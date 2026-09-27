/**
 * v4: server-side @mention resolution (shared by `onMessageCreated` and `editMessage`).
 *
 * Parses against the channel's members and the org's on-call role keys. Role mentions resolve to
 * whoever is on call now (off and out-of-office members skipped). Anyone mentioned who isn't a
 * channel member is returned in `nonMembers` (not in `mentions`), so the caller can tell the sender.
 * When an `@word` matched no channel member, the body is parsed again against all active org
 * members (one query, only then) so longest-match still holds across both sets.
 */
import { mayContainMentions, parseMentions, type MentionCandidate } from '../domain/mentions';
import { colRef, getMany, paths } from '../lib/db';
import { resolveOnCall } from '../scheduling/resolveOnCall';
import type { Member } from '../shared/types';

/** Upper bound on the org-member query used to find mentions of non-members. */
export const MENTION_ORG_SCAN_LIMIT = 1000;
/** Upper bound on role keys considered. */
export const MENTION_ROLE_LIMIT = 200;

export interface MentionResolution {
  /** Channel-member uids mentioned by name or via a role (sender excluded). */
  mentions: string[];
  /** Role keys mentioned. */
  mentionRoles: string[];
  /** People mentioned (by name or via a role) who aren't channel members. */
  nonMembers: Array<{ uid: string; name: string }>;
}

export const EMPTY_MENTIONS: MentionResolution = { mentions: [], mentionRoles: [], nonMembers: [] };

export async function resolveMentions(p: {
  orgId: string;
  body: string;
  senderUid: string;
  channelMemberUids: readonly string[];
  /** Channel member docs already loaded (missing ones are read). */
  members?: ReadonlyMap<string, Member>;
  now?: Date;
}): Promise<MentionResolution> {
  if (!mayContainMentions(p.body)) return EMPTY_MENTIONS;
  const channelSet = new Set(p.channelMemberUids);
  const known = new Map<string, Member>(p.members ?? []);
  const missing = p.channelMemberUids.filter((u) => !known.has(u));
  if (missing.length) {
    for (const m of (await getMany<Member>(missing.map((u) => paths.member(p.orgId, u)))).values()) known.set(m.uid, m);
  }
  const candidates = (list: Iterable<Member>): MentionCandidate[] =>
    [...list].filter((m) => m.active && m.uid !== p.senderUid).map((m) => ({ uid: m.uid, displayName: m.displayName }));

  const rolesSnap = await colRef(`${paths.org(p.orgId)}/onCallRoles`).limit(MENTION_ROLE_LIMIT).get();
  const roleKeys = rolesSnap.docs.map((d) => d.id);

  const channelMembers = p.channelMemberUids.map((u) => known.get(u)).filter((m): m is Member => !!m);
  let parsed = parseMentions(p.body, candidates(channelMembers), roleKeys);
  if (parsed.unmatched.length > 0) {
    // Someone outside the channel may have been mentioned: parse against every active org member.
    const snap = await colRef(paths.members(p.orgId)).where('active', '==', true).limit(MENTION_ORG_SCAN_LIMIT).get();
    for (const d of snap.docs) {
      const m = d.data() as Member;
      if (!known.has(m.uid)) known.set(m.uid, m);
    }
    parsed = parseMentions(p.body, candidates(known.values()), roleKeys);
  }

  const mentions: string[] = [];
  const nonMembers = new Set<string>();
  const add = (uid: string) => {
    if (uid === p.senderUid) return;
    if (channelSet.has(uid)) {
      if (!mentions.includes(uid)) mentions.push(uid);
    } else {
      nonMembers.add(uid);
    }
  };
  parsed.uids.forEach(add);
  for (const key of parsed.roleKeys) {
    const res = await resolveOnCall(p.orgId, key, { excludeUid: p.senderUid, availability: 'skip', now: p.now });
    res.uids.forEach(add);
  }

  const unknownNames = [...nonMembers].filter((u) => !known.has(u));
  if (unknownNames.length) {
    for (const m of (await getMany<Member>(unknownNames.map((u) => paths.member(p.orgId, u)))).values()) known.set(m.uid, m);
  }
  return {
    mentions,
    mentionRoles: parsed.roleKeys,
    nonMembers: [...nonMembers].map((uid) => ({ uid, name: known.get(uid)?.displayName ?? 'Someone' })),
  };
}

/** System note text for mentions of people outside the channel (names only, no message text). */
export function nonMemberNoteText(names: readonly string[]): string {
  const list = names.length <= 1 ? (names[0] ?? 'Someone') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const verb = names.length <= 1 ? 'is' : 'are';
  return `${list} ${verb} not in this conversation and ${names.length <= 1 ? 'was' : 'were'} not notified. Add them to the conversation to include them.`;
}
