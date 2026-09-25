import { describe, expect, it } from 'vitest';
import { resolveOnCall, shiftCovers } from '../../src/domain/roleRouting';

const H = 3_600_000;
const now = 100 * H;

describe('resolveOnCall', () => {
  it('returns everyone on overlapping shifts, ordered by start', () => {
    const r = resolveOnCall({
      shifts: [
        { uid: 'b', startMs: now - 1 * H, endMs: now + 5 * H },
        { uid: 'a', startMs: now - 2 * H, endMs: now + 1 * H },
        { uid: 'c', startMs: now + 1 * H, endMs: now + 9 * H },
      ],
      fallbackUids: ['f'],
      nowMs: now,
    });
    expect(r).toEqual({ uids: ['a', 'b'], source: 'shift' });
  });

  it('treats shift end as exclusive and start as inclusive', () => {
    expect(shiftCovers({ uid: 'a', startMs: now - H, endMs: now }, now)).toBe(false);
    expect(shiftCovers({ uid: 'a', startMs: now, endMs: now + H }, now)).toBe(true);
    const r = resolveOnCall({
      shifts: [
        { uid: 'outgoing', startMs: now - 12 * H, endMs: now },
        { uid: 'incoming', startMs: now, endMs: now + 12 * H },
      ],
      fallbackUids: [],
      nowMs: now,
    });
    expect(r.uids).toEqual(['incoming']);
  });

  it('falls back when nobody is scheduled', () => {
    expect(resolveOnCall({ shifts: [], fallbackUids: ['f1', 'f2', 'f1'], nowMs: now })).toEqual({ uids: ['f1', 'f2'], source: 'fallback' });
  });

  it('excludes the caller, falling back if the caller is the only one on shift', () => {
    const shifts = [{ uid: 'me', startMs: now - H, endMs: now + H }];
    expect(resolveOnCall({ shifts, fallbackUids: ['me', 'f'], nowMs: now, excludeUid: 'me' })).toEqual({ uids: ['f'], source: 'fallback' });
    expect(resolveOnCall({ shifts, fallbackUids: ['me'], nowMs: now, excludeUid: 'me' })).toEqual({ uids: [], source: 'none' });
  });

  it('filters to eligible (active) uids and de-duplicates', () => {
    const r = resolveOnCall({
      shifts: [
        { uid: 'a', startMs: now - H, endMs: now + H },
        { uid: 'a', startMs: now - H, endMs: now + 2 * H },
        { uid: 'inactive', startMs: now - H, endMs: now + H },
      ],
      fallbackUids: [],
      nowMs: now,
      eligibleUids: new Set(['a']),
    });
    expect(r.uids).toEqual(['a']);
  });
});
