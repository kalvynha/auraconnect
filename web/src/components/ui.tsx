import { isValidElement, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { AiTextResult, Member, Patient } from '@shared/types';
import type { WithId } from '../lib/firestore';
import { csvFileName, downloadCsv, toCsv } from '../lib/csv';

export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <header className="page-header">
        <h1>{title}</h1>
        {actions && <div className="page-actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-header">
          {title && <h2>{title}</h2>}
          {actions && <div className="row gap">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  variant = 'secondary',
  small,
  busy,
  children,
  className,
  disabled,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; small?: boolean; busy?: boolean }) {
  const cls = ['btn', `btn-${variant}`, small ? 'btn-sm' : '', className ?? ''].join(' ').trim();
  return (
    <button type={type} className={cls} disabled={disabled || busy} {...rest}>
      {busy ? 'Working…' : children}
    </button>
  );
}

const BADGE_TONES: Record<string, string> = {
  // priority
  normal: 'neutral',
  urgent: 'warn',
  critical: 'danger',
  // alert status
  open: 'danger',
  acked: 'warn',
  resolved: 'ok',
  // patient status
  referral: 'info',
  admitted: 'ok',
  discharged: 'neutral',
  deceased: 'neutral',
  // referral status
  uploaded: 'info',
  extracting: 'info',
  needs_review: 'warn',
  accepted: 'ok',
  rejected: 'neutral',
  failed: 'danger',
  // invites
  pending: 'info',
  revoked: 'neutral',
  // due states
  overdue: 'danger',
  soon: 'warn',
  ok: 'ok',
  // roles
  admin: 'accent',
  // v2: visits, tasks, bereavement, triage, volunteers
  scheduled: 'info',
  completed: 'ok',
  missed: 'danger',
  cancelled: 'neutral',
  done: 'ok',
  skipped: 'neutral',
  emergent: 'danger',
  routine: 'neutral',
  active: 'ok',
  closed: 'neutral',
  ended: 'neutral',
  low: 'ok',
  moderate: 'warn',
  high: 'danger',
};

export function Badge({ value, tone, children }: { value?: string; tone?: string; children?: ReactNode }) {
  const t = tone ?? (value ? BADGE_TONES[value] : undefined) ?? 'neutral';
  return <span className={`badge badge-${t}`}>{children ?? value?.replace(/_/g, ' ')}</span>;
}

export function Field({
  label,
  hint,
  warn,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  warn?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`field ${warn ? 'field-warn' : ''} ${className ?? ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export interface Column<T> {
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  /** Plain-text value for CSV export. Falls back to the text of `cell`; columns with no header and no `csv` are skipped. */
  csv?: (row: T) => string;
  /** CSV header when `header` is not plain text. */
  csvHeader?: string;
}

/**
 * Best-effort plain text of a rendered node: strings, numbers and the children of plain
 * elements (fragments, spans, links). Function components are not rendered, so columns
 * that use them should provide `csv`.
 */
export function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    // Skip interactive controls (buttons, inputs): they are not data.
    if (typeof node.type === 'string' && ['button', 'input', 'select', 'textarea'].includes(node.type)) return '';
    const inner = nodeText(props.children);
    return typeof node.type === 'string' && ['div', 'li', 'p', 'br'].includes(node.type) ? ` ${inner} ` : inner;
  }
  return '';
}

function exportTable<T>(name: string, columns: Column<T>[], rows: T[]) {
  const cols = columns
    .map((c) => ({ c, header: c.csvHeader ?? nodeText(c.header).trim() }))
    .filter(({ c, header }) => header || c.csv)
    .map(({ c, header }) => ({
      header: header || 'Value',
      value: (r: T) => (c.csv ? c.csv(r) : nodeText(c.cell(r)).replace(/\s+/g, ' ').trim()),
    }));
  downloadCsv(csvFileName(name), toCsv(rows, cols));
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  empty = 'Nothing here yet.',
  onRowClick,
  rowClassName,
  exportName,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  /** When set, shows an "Export CSV" button that exports the visible rows (file name prefix). */
  exportName?: string;
}) {
  return (
    <div className="table-wrap">
      {exportName && (
        <div className="table-tools no-print">
          <span className="muted small">{rows.length} row{rows.length === 1 ? '' : 's'}</span>
          <Button small variant="ghost" disabled={rows.length === 0} onClick={() => exportTable(exportName, columns, rows)}>
            Export CSV
          </Button>
          <Button small variant="ghost" onClick={() => window.print()}>
            Print
          </Button>
        </div>
      )}
      <table className="table">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} className={c.className}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="empty">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr
                key={rowKey(r)}
                className={[onRowClick ? 'clickable' : '', rowClassName?.(r) ?? ''].join(' ').trim() || undefined}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
              >
                {columns.map((c, i) => (
                  <td key={i} className={c.className}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function ErrorBanner({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <div className="banner banner-error" role="alert">
      {error}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="loading">{label}</div>;
}

/** Checkbox list for picking members. */
export function MemberPicker({
  members,
  value,
  onChange,
  exclude,
}: {
  members: WithId<Member>[];
  value: string[];
  onChange: (uids: string[]) => void;
  exclude?: string[];
}) {
  const list = members.filter((m) => m.active !== false && !exclude?.includes(m.uid ?? m.id));
  if (list.length === 0) return <div className="muted">No members available.</div>;
  return (
    <div className="picker">
      {list.map((m) => {
        const uid = m.uid ?? m.id;
        const checked = value.includes(uid);
        return (
          <label key={uid} className="picker-item">
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onChange(checked ? value.filter((u) => u !== uid) : [...value, uid])}
            />
            <span>
              {m.displayName || m.email} <span className="muted">· {m.discipline}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function MemberSelect({
  members,
  value,
  onChange,
  placeholder = 'Select member…',
  required,
  disabled,
}: {
  members: WithId<Member>[];
  value: string;
  onChange: (uid: string) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} required={required} disabled={disabled}>
      <option value="">{placeholder}</option>
      {members
        .filter((m) => m.active !== false)
        .map((m) => (
          <option key={m.id} value={m.uid ?? m.id}>
            {m.displayName || m.email} ({m.discipline})
          </option>
        ))}
    </select>
  );
}

export interface TabDef<K extends string> {
  key: K;
  label: ReactNode;
  hidden?: boolean;
}

/** Simple tab strip; the caller renders the active panel. */
export function Tabs<K extends string>({ tabs, value, onChange }: { tabs: TabDef<K>[]; value: K; onChange: (k: K) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={value === t.key}
            className={value === t.key ? 'active' : ''}
            onClick={() => onChange(t.key)}
          >
            {t.label}
          </button>
        ))}
    </div>
  );
}

export interface TimelineItem {
  id: string;
  when: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  tone?: string;
}

export function Timeline({ items, empty = 'No events yet.' }: { items: TimelineItem[]; empty?: ReactNode }) {
  if (items.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ol className="timeline">
      {items.map((it) => (
        <li key={it.id} className={`timeline-item tl-${it.tone ?? 'neutral'}`}>
          <div className="timeline-when muted small">{it.when}</div>
          <div className="timeline-title">{it.title}</div>
          {it.body && <div className="timeline-body">{it.body}</div>}
        </li>
      ))}
    </ol>
  );
}

/** Tiny inline-SVG line chart. Null values are skipped. */
export function Sparkline({ values, width = 120, height = 32, label }: { values: (number | null)[]; width?: number; height?: number; label?: string }) {
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null && Number.isFinite(p.v));
  if (pts.length < 2) return <svg className="sparkline" width={width} height={height} aria-hidden="true" />;
  const min = Math.min(...pts.map((p) => p.v));
  const max = Math.max(...pts.map((p) => p.v));
  const span = max - min || 1;
  const n = Math.max(values.length - 1, 1);
  const x = (i: number) => (i / n) * (width - 4) + 2;
  const y = (v: number) => height - 3 - ((v - min) / span) * (height - 6);
  const d = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? 'trend'}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last.i)} cy={y(last.v)} r={2.5} fill="currentColor" />
    </svg>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  return (
    <Button
      small
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState('copied');
          window.setTimeout(() => setState('idle'), 2000);
        } catch {
          setState('error');
        }
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'error' ? 'Copy failed' : label}
    </Button>
  );
}

export const AI_DISCLAIMER_FALLBACK = 'AI-generated content. Verify against the chart before acting on it.';

/** Renders an AI result with its disclaimer (always shown) and a copy button. */
export function AiResultView({ result }: { result: AiTextResult }) {
  return (
    <div className="ai-result">
      <div className="banner banner-warn" role="note">
        {result.disclaimer || AI_DISCLAIMER_FALLBACK}
      </div>
      <div className="ai-text">{result.text}</div>
      <div className="row gap space-between">
        <span className="muted small">Model: {result.model}</span>
        <CopyButton text={result.text} />
      </div>
    </div>
  );
}

export function PatientSelect({
  patients,
  value,
  onChange,
  placeholder = 'No patient',
  required,
}: {
  patients: WithId<Pick<Patient, 'firstName' | 'lastName' | 'status'>>[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const sorted = [...patients].sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} required={required}>
      <option value="">{placeholder}</option>
      {sorted.map((p) => (
        <option key={p.id} value={p.id}>
          {[p.lastName, p.firstName].filter(Boolean).join(', ') || '(unnamed)'}
          {p.status !== 'admitted' ? ` (${p.status})` : ''}
        </option>
      ))}
    </select>
  );
}
