/** Channel naming helpers. Pure module: no Firebase imports. */

/** Deterministic direct-message channel id: `dm_{minUid}_{maxUid}`. */
export function directChannelId(uidA: string, uidB: string): string {
  if (!uidA || !uidB) throw new Error('directChannelId requires two uids');
  if (uidA === uidB) throw new Error('directChannelId requires two different uids');
  const [a, b] = uidA < uidB ? [uidA, uidB] : [uidB, uidA];
  return `dm_${a}_${b}`;
}

/** Patient care-team channel name: `"{Last}, {First} – Care Team"` (en dash). */
export function patientChannelName(firstName: string, lastName: string): string {
  const last = lastName.trim();
  const first = firstName.trim();
  const who = [last, first].filter(Boolean).join(', ') || 'Patient';
  return `${who} – Care Team`;
}

/** Sorted, de-duplicated uid list. */
export function normalizeUids(uids: Iterable<string>): string[] {
  return [...new Set([...uids].filter((u) => typeof u === 'string' && u.length > 0))].sort();
}

/** Same set of uids, ignoring order and duplicates. */
export function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const x = normalizeUids(a);
  const y = normalizeUids(b);
  return x.length === y.length && x.every((u, i) => u === y[i]);
}

/** Truncates text for `channel.lastMessage.text`, adding an ellipsis when cut. */
export function truncateText(text: string, max = 140): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}
