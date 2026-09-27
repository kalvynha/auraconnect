// CSV export helpers (client-side; nothing leaves the browser except the downloaded file).

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

/** Characters that make spreadsheet apps treat a cell as a formula (CSV/formula injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Escape one CSV cell: neutralize formulas, then quote when needed (RFC 4180). */
export function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Numbers are safe as-is (a negative number is not a formula); strings are not.
  if (typeof v === 'string' && FORMULA_START.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(c.value(r))).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** `name-YYYY-MM-DD.csv`, filesystem-safe. */
export function csvFileName(base: string, date = new Date()): string {
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'export';
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return safe.toLowerCase().endsWith('.csv') ? safe : `${safe}-${stamp}.csv`;
}

/** Trigger a browser download of `csv` (UTF-8 with BOM so Excel detects the encoding). */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.toLowerCase().endsWith('.csv') ? filename : `${filename}.csv`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
