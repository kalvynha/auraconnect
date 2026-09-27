/** Deterministic RNG, bounded-concurrency pool and small helpers for the load harness. */

/** mulberry32: small, fast, deterministic PRNG so baseline and after runs replay the same scenario. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)]!,
    chance: (p: number) => next() < p,
    shuffle: <T>(arr: T[]): T[] => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
      }
      return arr;
    },
  };
}
export type Rng = ReturnType<typeof rng>;

/** Runs thunks with at most `concurrency` in flight. Errors are swallowed (callers record them). */
export async function pool(thunks: ReadonlyArray<() => Promise<unknown>>, concurrency: number): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < thunks.length) {
      const t = thunks[i++]!;
      try {
        await t();
      } catch {
        // recorded by measure()
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, thunks.length) }, worker));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export function isoDateUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function progress(msg: string): void {
  process.stderr.write(`[load ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}
