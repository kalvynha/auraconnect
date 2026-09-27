import { describe, expect, it } from 'vitest';
import { mayContainMentions, parseMentions } from '../../src/domain/mentions';

const members = [
  { uid: 'ann', displayName: 'Ann' },
  { uid: 'annlee', displayName: 'Ann Lee' },
  { uid: 'bob', displayName: 'Bob Ray' },
  { uid: 'jose', displayName: 'José Núñez' },
];
const roles = ['oncall-rn', 'oncall-rn-north'];

describe('parseMentions', () => {
  it('matches display names case-insensitively', () => {
    expect(parseMentions('hi @bob ray please call', members).uids).toEqual(['bob']);
    expect(parseMentions('@BOB RAY', members).uids).toEqual(['bob']);
    expect(parseMentions('thanks @josé núñez', members).uids).toEqual(['jose']);
  });

  it('prefers the longest match', () => {
    expect(parseMentions('@Ann Lee can you visit?', members).uids).toEqual(['annlee']);
    expect(parseMentions('@Ann can you visit?', members).uids).toEqual(['ann']);
    expect(parseMentions('@oncall-rn-north please', members, roles).roleKeys).toEqual(['oncall-rn-north']);
    expect(parseMentions('@oncall-rn please', members, roles).roleKeys).toEqual(['oncall-rn']);
  });

  it('requires a word boundary after the match', () => {
    expect(parseMentions('@Annabel hi', members).uids).toEqual([]);
    expect(parseMentions('@oncall-rn-south', members, roles).roleKeys).toEqual([]);
    expect(parseMentions('@Ann, @Bob Ray. @Ann Lee!', members).uids).toEqual(['ann', 'bob', 'annlee']);
    expect(parseMentions("@Ann Lee's patient", members).uids).toEqual(['annlee']);
  });

  it('ignores email addresses and bare @', () => {
    expect(parseMentions('mail ann@bob.org or x.@Ann', members).uids).toEqual([]);
    expect(parseMentions('meet @ 5pm', members)).toEqual({ uids: [], roleKeys: [], unmatched: [] });
  });

  it('de-duplicates, keeps first-mention order, and mixes members and roles', () => {
    const r = parseMentions('@Bob Ray @ann @oncall-rn @BOB RAY @oncall-rn', members, roles);
    expect(r.uids).toEqual(['bob', 'ann']);
    expect(r.roleKeys).toEqual(['oncall-rn']);
  });

  it('reports unmatched @words (possible non-members)', () => {
    const r = parseMentions('@Zed and @Ann and @zed-2', members, roles);
    expect(r.uids).toEqual(['ann']);
    expect(r.unmatched).toEqual(['Zed', 'zed-2']);
  });

  it('mentions every member who shares a display name', () => {
    const dup = [...members, { uid: 'ann2', displayName: 'ann' }];
    expect(parseMentions('@Ann', dup).uids.sort()).toEqual(['ann', 'ann2']);
  });

  it('skips blank names and handles mentions at the very start and end', () => {
    expect(parseMentions('@Ann', [{ uid: 'x', displayName: '  ' }, ...members]).uids).toEqual(['ann']);
    expect(parseMentions('ping @Ann', members).uids).toEqual(['ann']);
  });

  it('mayContainMentions is a cheap pre-check', () => {
    expect(mayContainMentions('hello')).toBe(false);
    expect(mayContainMentions('a@b.com')).toBe(false);
    expect(mayContainMentions('hi @x')).toBe(true);
    expect(mayContainMentions('@x')).toBe(true);
    expect(mayContainMentions(null)).toBe(false);
  });
});
