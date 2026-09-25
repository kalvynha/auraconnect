import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Member } from '@shared/types';
import type { WithId } from '../lib/firestore';

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
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  empty = 'Nothing here yet.',
  onRowClick,
  rowClassName,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
}) {
  return (
    <div className="table-wrap">
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
}: {
  members: WithId<Member>[];
  value: string;
  onChange: (uid: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} required={required}>
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
