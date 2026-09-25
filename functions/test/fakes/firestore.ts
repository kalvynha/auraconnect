/**
 * Minimal in-memory fake of the `firebase-admin/firestore` surface used by
 * the functions. Install with:
 *   vi.mock('firebase-admin/firestore', () => import('../fakes/firestore'));
 */

type Data = Record<string, unknown>;

export class Timestamp {
  constructor(
    readonly seconds: number,
    readonly nanoseconds: number,
  ) {}
  static fromMillis(ms: number): Timestamp {
    const seconds = Math.floor(ms / 1000);
    return new Timestamp(seconds, Math.round((ms - seconds * 1000) * 1e6));
  }
  static fromDate(d: Date): Timestamp {
    return Timestamp.fromMillis(d.getTime());
  }
  static now(): Timestamp {
    return Timestamp.fromMillis(Date.now());
  }
  toMillis(): number {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
  }
  toDate(): Date {
    return new Date(this.toMillis());
  }
  isEqual(o: Timestamp): boolean {
    return o.seconds === this.seconds && o.nanoseconds === this.nanoseconds;
  }
}

class Sentinel {
  constructor(
    readonly kind: 'serverTimestamp' | 'arrayUnion' | 'arrayRemove' | 'delete' | 'increment',
    readonly values: unknown[] = [],
  ) {}
}

export const FieldValue = {
  serverTimestamp: () => new Sentinel('serverTimestamp'),
  arrayUnion: (...v: unknown[]) => new Sentinel('arrayUnion', v),
  arrayRemove: (...v: unknown[]) => new Sentinel('arrayRemove', v),
  delete: () => new Sentinel('delete'),
  increment: (n: number) => new Sentinel('increment', [n]),
};

function clone<T>(v: T): T {
  if (v instanceof Timestamp) return v;
  if (v instanceof Sentinel) return v;
  if (Array.isArray(v)) return v.map(clone) as T;
  if (v && typeof v === 'object') {
    const out: Data = {};
    for (const [k, x] of Object.entries(v as Data)) out[k] = clone(x);
    return out as T;
  }
  return v;
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
function norm(v: unknown): unknown {
  if (v instanceof Timestamp) return { __ts: v.toMillis() };
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Data).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, norm(x)]));
  }
  return v;
}
function cmpVal(a: unknown): unknown {
  return a instanceof Timestamp ? a.toMillis() : a;
}

function applyValue(current: unknown, value: unknown): unknown {
  if (value instanceof Sentinel) {
    switch (value.kind) {
      case 'serverTimestamp':
        return Timestamp.now();
      case 'arrayUnion': {
        const arr = Array.isArray(current) ? [...current] : [];
        for (const v of value.values) if (!arr.some((x) => eq(x, v))) arr.push(clone(v));
        return arr;
      }
      case 'arrayRemove':
        return (Array.isArray(current) ? current : []).filter((x) => !value.values.some((v) => eq(x, v)));
      case 'increment':
        return (typeof current === 'number' ? current : 0) + (value.values[0] as number);
      case 'delete':
        return undefined;
    }
  }
  if (Array.isArray(value)) {
    if (value.some((v) => v instanceof Sentinel)) throw new Error('FieldValue sentinel inside array is not allowed');
    return value.map((v) => resolveDeep(v));
  }
  if (value && typeof value === 'object' && !(value instanceof Timestamp)) return resolveDeep(value);
  return value;
}
function resolveDeep(v: unknown): unknown {
  if (v instanceof Sentinel) return applyValue(undefined, v);
  if (v instanceof Timestamp) return v;
  if (v instanceof Date) return Timestamp.fromDate(v);
  if (Array.isArray(v)) return v.map(resolveDeep);
  if (v && typeof v === 'object') {
    const out: Data = {};
    for (const [k, x] of Object.entries(v as Data)) {
      const r = resolveDeep(x);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return v;
}

function getField(data: Data, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Data)[k] : undefined), data);
}

let autoId = 0;
function newId(): string {
  autoId++;
  return `auto${String(autoId).padStart(6, '0')}`;
}

export class DocumentSnapshot {
  constructor(
    readonly ref: DocumentReference,
    private readonly _data: Data | undefined,
  ) {}
  get exists(): boolean {
    return this._data !== undefined;
  }
  get id(): string {
    return this.ref.id;
  }
  data(): Data | undefined {
    return this._data === undefined ? undefined : clone(this._data);
  }
  get(field: string): unknown {
    return this._data ? getField(this._data, field) : undefined;
  }
}

export class QuerySnapshot {
  constructor(readonly docs: DocumentSnapshot[]) {}
  get empty(): boolean {
    return this.docs.length === 0;
  }
  get size(): number {
    return this.docs.length;
  }
  forEach(fn: (d: DocumentSnapshot) => void): void {
    this.docs.forEach(fn);
  }
}

type Filter = { field: string; op: string; value: unknown };

export class Query {
  constructor(
    protected readonly fs: FakeFirestore,
    protected readonly collectionPath: string | null,
    protected readonly groupId: string | null,
    protected readonly filters: Filter[] = [],
    protected readonly limitN: number | null = null,
    protected readonly orders: Array<{ field: string; dir: 'asc' | 'desc' }> = [],
  ) {}
  where(field: string, op: string, value: unknown): Query {
    return new Query(this.fs, this.collectionPath, this.groupId, [...this.filters, { field, op, value }], this.limitN, this.orders);
  }
  limit(n: number): Query {
    return new Query(this.fs, this.collectionPath, this.groupId, this.filters, n, this.orders);
  }
  orderBy(field: string, dir: 'asc' | 'desc' = 'asc'): Query {
    return new Query(this.fs, this.collectionPath, this.groupId, this.filters, this.limitN, [...this.orders, { field, dir }]);
  }
  private matches(data: Data): boolean {
    return this.filters.every(({ field, op, value }) => {
      const v = getField(data, field);
      const a = cmpVal(v) as number;
      const b = cmpVal(value) as number;
      switch (op) {
        case '==':
          return eq(v, value);
        case '!=':
          return v !== undefined && !eq(v, value);
        case '>':
          return v !== undefined && a > b;
        case '>=':
          return v !== undefined && a >= b;
        case '<':
          return v !== undefined && a < b;
        case '<=':
          return v !== undefined && a <= b;
        case 'array-contains':
          return Array.isArray(v) && v.some((x) => eq(x, value));
        case 'in':
          return (value as unknown[]).some((x) => eq(v, x));
        default:
          throw new Error(`unsupported op ${op}`);
      }
    });
  }
  async get(): Promise<QuerySnapshot> {
    const docs: DocumentSnapshot[] = [];
    for (const [path, data] of this.fs.store) {
      const segs = path.split('/');
      const parent = segs.slice(0, -1).join('/');
      if (this.collectionPath !== null && parent !== this.collectionPath) continue;
      if (this.groupId !== null && segs[segs.length - 2] !== this.groupId) continue;
      if (!this.matches(data)) continue;
      docs.push(new DocumentSnapshot(this.fs.doc(path), data));
    }
    for (const o of [...this.orders].reverse()) {
      docs.sort((x, y) => {
        const a = cmpVal(x.get(o.field)) as number;
        const b = cmpVal(y.get(o.field)) as number;
        return (a < b ? -1 : a > b ? 1 : 0) * (o.dir === 'asc' ? 1 : -1);
      });
    }
    return new QuerySnapshot(this.limitN === null ? docs : docs.slice(0, this.limitN));
  }
}

export class CollectionReference extends Query {
  constructor(fs: FakeFirestore, readonly path: string) {
    super(fs, path, null);
  }
  get id(): string {
    return this.path.split('/').pop()!;
  }
  get parent(): DocumentReference | null {
    const segs = this.path.split('/');
    return segs.length > 1 ? this.fs.doc(segs.slice(0, -1).join('/')) : null;
  }
  doc(id?: string): DocumentReference {
    return this.fs.doc(`${this.path}/${id ?? newId()}`);
  }
  async add(data: Data): Promise<DocumentReference> {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

export class DocumentReference {
  constructor(
    private readonly fs: FakeFirestore,
    readonly path: string,
  ) {}
  get id(): string {
    return this.path.split('/').pop()!;
  }
  get parent(): CollectionReference {
    return this.fs.collection(this.path.split('/').slice(0, -1).join('/'));
  }
  collection(id: string): CollectionReference {
    return this.fs.collection(`${this.path}/${id}`);
  }
  async get(): Promise<DocumentSnapshot> {
    return new DocumentSnapshot(this, this.fs.store.get(this.path));
  }
  async set(data: Data, opts?: { merge?: boolean }): Promise<void> {
    this.fs.write(this.path, data, opts?.merge ? 'merge' : 'set');
  }
  async update(data: Data): Promise<void> {
    this.fs.write(this.path, data, 'update');
  }
  async create(data: Data): Promise<void> {
    this.fs.write(this.path, data, 'create');
  }
  async delete(): Promise<void> {
    this.fs.store.delete(this.path);
  }
}

type Op = () => void;

export class WriteBatch {
  protected ops: Op[] = [];
  constructor(protected readonly fs: FakeFirestore) {}
  set(ref: DocumentReference, data: Data, opts?: { merge?: boolean }): this {
    this.ops.push(() => this.fs.write(ref.path, data, opts?.merge ? 'merge' : 'set'));
    return this;
  }
  update(ref: DocumentReference, data: Data): this {
    this.ops.push(() => this.fs.write(ref.path, data, 'update'));
    return this;
  }
  create(ref: DocumentReference, data: Data): this {
    this.ops.push(() => this.fs.write(ref.path, data, 'create'));
    return this;
  }
  delete(ref: DocumentReference): this {
    this.ops.push(() => this.fs.store.delete(ref.path));
    return this;
  }
  async commit(): Promise<void> {
    // Validate creates first so a failing batch writes nothing.
    const snapshot = new Map(this.fs.store);
    try {
      for (const op of this.ops) op();
    } catch (e) {
      this.fs.store = snapshot;
      throw e;
    }
  }
}

export class Transaction extends WriteBatch {
  async get(target: DocumentReference | Query): Promise<DocumentSnapshot | QuerySnapshot> {
    if (this.ops.length) throw new Error('Firestore transactions require all reads to be executed before all writes.');
    return target.get();
  }
  async getAll(...refs: DocumentReference[]): Promise<DocumentSnapshot[]> {
    if (this.ops.length) throw new Error('Firestore transactions require all reads to be executed before all writes.');
    return Promise.all(refs.map((r) => r.get()));
  }
}

export class FakeFirestore {
  store = new Map<string, Data>();

  doc(path: string): DocumentReference {
    const segs = path.split('/').filter(Boolean);
    if (segs.length % 2 !== 0) throw new Error(`Invalid document path: ${path}`);
    return new DocumentReference(this, segs.join('/'));
  }
  collection(path: string): CollectionReference {
    const segs = path.split('/').filter(Boolean);
    if (segs.length % 2 !== 1) throw new Error(`Invalid collection path: ${path}`);
    return new CollectionReference(this, segs.join('/'));
  }
  collectionGroup(id: string): Query {
    return new Query(this, null, id);
  }
  batch(): WriteBatch {
    return new WriteBatch(this);
  }
  async getAll(...refs: DocumentReference[]): Promise<DocumentSnapshot[]> {
    return Promise.all(refs.map((r) => r.get()));
  }
  async runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const tx = new Transaction(this);
    const result = await fn(tx as unknown as Transaction);
    await tx.commit();
    return result;
  }

  write(path: string, data: Data, mode: 'set' | 'merge' | 'update' | 'create'): void {
    const existing = this.store.get(path);
    if (mode === 'create' && existing) {
      const err = new Error(`ALREADY_EXISTS: ${path}`) as Error & { code: number };
      err.code = 6;
      throw err;
    }
    if (mode === 'update' && !existing) {
      const err = new Error(`NOT_FOUND: ${path}`) as Error & { code: number };
      err.code = 5;
      throw err;
    }
    const base: Data = mode === 'set' || mode === 'create' ? {} : clone(existing ?? {});
    for (const [key, value] of Object.entries(data)) {
      const parts = mode === 'update' ? key.split('.') : [key];
      let target = base;
      for (const p of parts.slice(0, -1)) {
        if (!target[p] || typeof target[p] !== 'object') target[p] = {};
        target = target[p] as Data;
      }
      const last = parts[parts.length - 1]!;
      const next = applyValue(target[last], value);
      if (next === undefined) delete target[last];
      else target[last] = next;
    }
    this.store.set(path, base);
  }

  /** Test helper: seed a doc (Dates become Timestamps). */
  seed(path: string, data: object): void {
    this.store.set(path, resolveDeep(data) as Data);
  }
  /** Test helper: read raw doc data. */
  read<T = Data>(path: string): T | undefined {
    return this.store.get(path) as T | undefined;
  }
  reset(): void {
    this.store.clear();
  }
}

export const fakeDb = new FakeFirestore();
export function getFirestore(): FakeFirestore {
  return fakeDb;
}
