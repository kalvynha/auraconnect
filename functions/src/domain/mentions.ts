/**
 * v4 @mention parsing. Pure module: no Firebase imports.
 *
 * `@` followed by a member's display name or an on-call role key, matched case-insensitively. When
 * several candidates match at the same `@` the longest wins ("@Ann Lee" beats "@Ann"; "@oncall-rn-north"
 * beats "@oncall-rn"). An `@` preceded by a letter, digit, `_` or `.` (an email address) is ignored, and
 * a match must end at a word boundary (a following letter, digit, `_` or `-` means no match).
 */

export interface MentionCandidate {
  uid: string;
  displayName: string;
}

export interface ParsedMentions {
  /** Mentioned member uids, in order of first mention. */
  uids: string[];
  /** Mentioned role keys, in order of first mention. */
  roleKeys: string[];
  /** Words after an `@` that matched nobody (e.g. a member outside the candidate set). */
  unmatched: string[];
}

interface Needle {
  text: string;
  kind: 'member' | 'role';
  id: string;
}

const WORD_BEFORE = /[\p{L}\p{N}_.]/u;
const WORD_AFTER = /[\p{L}\p{N}_-]/u;
const UNMATCHED_WORD = /^[\p{L}\p{N}_][\p{L}\p{N}_-]*/u;

/** True when `body` contains an `@` that could start a mention (cheap pre-check before loading anything). */
export function mayContainMentions(body: string | null | undefined): boolean {
  return typeof body === 'string' && /(^|[^\p{L}\p{N}_.])@[\p{L}\p{N}_]/u.test(body);
}

export function parseMentions(
  body: string,
  members: readonly MentionCandidate[],
  roleKeys: readonly string[] = [],
): ParsedMentions {
  const out: ParsedMentions = { uids: [], roleKeys: [], unmatched: [] };
  if (!mayContainMentions(body)) return out;

  const needles: Needle[] = [];
  for (const m of members) {
    const name = (m.displayName ?? '').trim();
    if (m.uid && name) needles.push({ text: name, kind: 'member', id: m.uid });
  }
  for (const k of roleKeys) if (k) needles.push({ text: k, kind: 'role', id: k });
  // Longest first; members before roles on a tie; equal names adjacent.
  needles.sort(
    (a, b) =>
      b.text.length - a.text.length ||
      (a.kind === b.kind ? 0 : a.kind === 'member' ? -1 : 1) ||
      (a.text.toLowerCase() < b.text.toLowerCase() ? -1 : a.text.toLowerCase() > b.text.toLowerCase() ? 1 : 0),
  );
  const lowered = needles.map((n) => n.text.toLowerCase());

  let i = 0;
  while (i < body.length) {
    const at = body.indexOf('@', i);
    if (at < 0) break;
    i = at + 1;
    if (at > 0 && WORD_BEFORE.test(body[at - 1]!)) continue;
    const start = at + 1;
    let hit = -1;
    for (let n = 0; n < needles.length; n++) {
      const len = needles[n]!.text.length;
      if (body.slice(start, start + len).toLowerCase() !== lowered[n]) continue;
      const next = body[start + len];
      if (next !== undefined && WORD_AFTER.test(next)) continue;
      hit = n;
      break;
    }
    if (hit < 0) {
      const word = UNMATCHED_WORD.exec(body.slice(start));
      if (word && !out.unmatched.includes(word[0])) out.unmatched.push(word[0]);
      continue;
    }
    const needle = needles[hit]!;
    // Members sharing a display name are all mentioned (the parser can't tell them apart).
    for (let n = hit; n < needles.length && lowered[n] === lowered[hit]; n++) {
      const same = needles[n]!;
      if (same.kind !== needle.kind) continue;
      const list = same.kind === 'member' ? out.uids : out.roleKeys;
      if (!list.includes(same.id)) list.push(same.id);
    }
    i = start + needle.text.length;
  }
  return out;
}
