/**
 * Builds bounded, plain-text model inputs for the AI features. Pure module:
 * no Firebase imports, so the caps and formatting are unit-testable.
 */
import { localDateParts } from '../domain/dates';
import type { TimestampLike } from '../shared/types';

/** At most this many messages are sent to the model per request. */
export const MAX_AI_MESSAGES = 200;
/** Each message body is truncated to this many characters. */
export const MAX_AI_MESSAGE_CHARS = 1000;
/** Other free-text fields (visit notes, triage reasons) are truncated to this. */
export const MAX_AI_FIELD_CHARS = 500;
/** Hard cap on the whole prompt. */
export const MAX_AI_PROMPT_CHARS = 150_000;

export function millisOf(t: TimestampLike | null | undefined): number | null {
  if (!t) return null;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t.seconds === 'number') return t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
  return null;
}

/** Collapses whitespace and truncates with an explicit marker the model can see. */
export function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)} …[truncated]`;
}

/** `YYYY-MM-DD HH:mm` in the org time zone. */
export function formatInstant(ms: number, timeZone: string): string {
  const d = new Date(ms);
  const { date } = localDateParts(d, timeZone);
  let time: string;
  try {
    time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  } catch {
    time = d.toISOString().slice(11, 16);
  }
  return `${date} ${time}`;
}

export interface AiMessage {
  senderName: string;
  body: string;
  priority: string;
  createdAtMs: number;
  attachmentCount: number;
  isThreadReply: boolean;
}

/** Oldest-first transcript, capped at {@link MAX_AI_MESSAGES} most recent messages. */
export function formatMessages(messages: readonly AiMessage[], timeZone: string, max = MAX_AI_MESSAGES): string {
  const recent = [...messages].sort((a, b) => a.createdAtMs - b.createdAtMs).slice(-max);
  return recent
    .map((m) => {
      const tags = [m.priority !== 'normal' ? m.priority.toUpperCase() : null, m.isThreadReply ? 'thread reply' : null]
        .filter(Boolean)
        .join(', ');
      const att = m.attachmentCount > 0 ? ` [${m.attachmentCount} attachment(s) not shown]` : '';
      return `[${formatInstant(m.createdAtMs, timeZone)}] ${clip(m.senderName, 100)}${tags ? ` (${tags})` : ''}: ${clip(m.body, MAX_AI_MESSAGE_CHARS)}${att}`;
    })
    .join('\n');
}

export interface PatientActivity {
  patientId: string;
  name: string;
  status: string;
  levelOfCare: string;
  primaryDiagnosis: string | null;
  codeStatus: string | null;
  events: Array<{ date: string; type: string; summary: string }>;
  visits: Array<{ discipline: string; status: string; startMs: number | null; note: string | null }>;
  openTasks: Array<{ title: string; dueDate: string | null; priority: string; discipline: string | null }>;
  triageCalls: Array<{
    receivedAtMs: number | null;
    urgency: string;
    status: string;
    reason: string;
    symptoms: string[];
    disposition: string | null;
    dispositionNote: string | null;
  }>;
  deadlines: Array<{ label: string; dueDate: string; overdue: boolean }>;
  messages: AiMessage[];
}

const none = '  (none)';

function when(ms: number | null, tz: string): string {
  return ms === null ? 'unknown time' : formatInstant(ms, tz);
}

/** One patient's section of a handoff / IDG prep prompt. */
export function formatPatientActivity(p: PatientActivity, timeZone: string, opts: { includeEvents: boolean }): string {
  const lines: string[] = [];
  lines.push(`### Patient: ${clip(p.name, 200)} (id ${p.patientId})`);
  lines.push(
    `Status: ${p.status}; level of care: ${p.levelOfCare}; primary diagnosis: ${p.primaryDiagnosis ? clip(p.primaryDiagnosis, 200) : 'not documented'}; code status: ${p.codeStatus ?? 'not documented'}`,
  );
  if (opts.includeEvents) {
    lines.push('Timeline events:');
    lines.push(...(p.events.length ? p.events.map((e) => `  - ${e.date} ${e.type}: ${clip(e.summary, MAX_AI_FIELD_CHARS)}`) : [none]));
  }
  lines.push('Visits:');
  lines.push(
    ...(p.visits.length
      ? p.visits.map((v) => `  - ${when(v.startMs, timeZone)} ${v.discipline} visit, ${v.status}${v.note ? `; note: ${clip(v.note, MAX_AI_FIELD_CHARS)}` : ''}`)
      : [none]),
  );
  lines.push('Open tasks:');
  lines.push(
    ...(p.openTasks.length
      ? p.openTasks.map((t) => `  - ${clip(t.title, 200)} (${t.priority}${t.discipline ? `, ${t.discipline}` : ''}${t.dueDate ? `, due ${t.dueDate}` : ''})`)
      : [none]),
  );
  lines.push('After-hours / triage calls:');
  lines.push(
    ...(p.triageCalls.length
      ? p.triageCalls.map(
          (c) =>
            `  - ${when(c.receivedAtMs, timeZone)} ${c.urgency}, ${c.status}: ${clip(c.reason, MAX_AI_FIELD_CHARS)}` +
            (c.symptoms.length ? `; symptoms: ${clip(c.symptoms.join(', '), 300)}` : '') +
            (c.disposition ? `; disposition: ${c.disposition}` : '') +
            (c.dispositionNote ? ` (${clip(c.dispositionNote, MAX_AI_FIELD_CHARS)})` : ''),
        )
      : [none]),
  );
  lines.push('Regulatory deadlines due soon or overdue:');
  lines.push(...(p.deadlines.length ? p.deadlines.map((d) => `  - ${d.label} ${d.overdue ? 'OVERDUE, was due' : 'due'} ${d.dueDate}`) : [none]));
  lines.push('Care-team channel messages:');
  lines.push(p.messages.length ? formatMessages(p.messages, timeZone).replace(/^/gm, '  ') : none);
  return lines.join('\n');
}

/** Truncates a full prompt to {@link MAX_AI_PROMPT_CHARS}, keeping the beginning. */
export function capPrompt(prompt: string, max = MAX_AI_PROMPT_CHARS): string {
  return prompt.length <= max ? prompt : `${prompt.slice(0, max)}\n…[input truncated]`;
}
