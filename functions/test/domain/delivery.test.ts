import { describe, expect, it } from 'vitest';
import {
  decideDelivery,
  isInQuietHours,
  isOff,
  isOutOfOffice,
  isUnavailable,
  localMinuteOfDay,
  outOfOfficeReply,
  parseHHmm,
  type DeliveryContext,
  type RecipientState,
} from '../../src/domain/delivery';
import { resolveOnCall } from '../../src/domain/roleRouting';

const ts = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 });
// 2026-09-27 14:00 UTC = 10:00 in New York (EDT).
const NOW = Date.UTC(2026, 8, 27, 14, 0);
const NY = 'America/New_York';

function r(over: Partial<RecipientState> = {}): RecipientState {
  return { prefs: null, settings: null, outOfOfficeUntilMs: null, hasShifts: false, onShiftNow: false, mentioned: false, ...over };
}
function ctx(over: Partial<DeliveryContext> = {}): DeliveryContext {
  return { priority: 'normal', channelType: 'group', nowMs: NOW, timeZone: NY, ...over };
}
const quiet = (start: string, end: string) => ({ quietHours: { start, end }, offShiftQuiet: false });

describe('decideDelivery', () => {
  it('pushes by default', () => {
    expect(decideDelivery(r(), ctx())).toEqual({ push: true });
  });

  it('urgent and critical always push, whatever the prefs and settings', () => {
    const everything = r({
      prefs: { mode: 'urgent_only', mutedUntil: ts(NOW + 60_000) },
      settings: { quietHours: { start: '00:00', end: '23:59' }, offShiftQuiet: true },
      hasShifts: true,
      outOfOfficeUntilMs: NOW + 1,
    });
    expect(decideDelivery(everything, ctx({ priority: 'urgent' }))).toEqual({ push: true });
    expect(decideDelivery(everything, ctx({ priority: 'critical', channelType: 'direct' }))).toEqual({ push: true });
  });

  it('muted until the future skips; an expired mute does not', () => {
    expect(decideDelivery(r({ prefs: { mode: 'all', mutedUntil: ts(NOW + 1000) } }), ctx())).toEqual({ push: false, reason: 'muted' });
    expect(decideDelivery(r({ prefs: { mode: 'all', mutedUntil: ts(NOW - 1000) } }), ctx())).toEqual({ push: true });
    expect(decideDelivery(r({ prefs: { mode: 'all', mutedUntil: ts(NOW) } }), ctx())).toEqual({ push: true });
    // Muting silences mentions too.
    expect(decideDelivery(r({ prefs: { mode: 'all', mutedUntil: ts(NOW + 1000) }, mentioned: true }), ctx())).toMatchObject({ push: false });
  });

  it('mode mentions: only when mentioned', () => {
    expect(decideDelivery(r({ prefs: { mode: 'mentions', mutedUntil: null } }), ctx())).toEqual({ push: false, reason: 'mentions_only' });
    expect(decideDelivery(r({ prefs: { mode: 'mentions', mutedUntil: null }, mentioned: true }), ctx())).toEqual({ push: true });
  });

  it('mode urgent_only: never for normal, even when mentioned', () => {
    expect(decideDelivery(r({ prefs: { mode: 'urgent_only', mutedUntil: null }, mentioned: true }), ctx())).toEqual({ push: false, reason: 'urgent_only' });
  });

  it('quiet hours in the org time zone (mentions do not override)', () => {
    expect(decideDelivery(r({ settings: quiet('09:00', '11:00') }), ctx())).toEqual({ push: false, reason: 'quiet_hours' });
    expect(decideDelivery(r({ settings: quiet('09:00', '11:00'), mentioned: true }), ctx())).toEqual({ push: false, reason: 'quiet_hours' });
    // 10:00 local is outside 14:00–15:00 (which would be "now" in UTC).
    expect(decideDelivery(r({ settings: quiet('14:00', '15:00') }), ctx())).toEqual({ push: true });
    expect(decideDelivery(r({ settings: quiet('14:00', '15:00') }), ctx({ timeZone: 'UTC' }))).toEqual({ push: false, reason: 'quiet_hours' });
  });

  it('off-shift quiet: only when they have shifts and none covers now', () => {
    const s = { quietHours: null, offShiftQuiet: true };
    expect(decideDelivery(r({ settings: s, hasShifts: true, onShiftNow: false }), ctx())).toEqual({ push: false, reason: 'off_shift' });
    expect(decideDelivery(r({ settings: s, hasShifts: true, onShiftNow: true }), ctx())).toEqual({ push: true });
    expect(decideDelivery(r({ settings: s, hasShifts: false }), ctx())).toEqual({ push: true });
    expect(decideDelivery(r({ settings: { quietHours: null, offShiftQuiet: false }, hasShifts: true }), ctx())).toEqual({ push: true });
  });

  it('out of office skips unless mentioned; past absences do not', () => {
    expect(decideDelivery(r({ outOfOfficeUntilMs: NOW + 1 }), ctx())).toEqual({ push: false, reason: 'out_of_office' });
    expect(decideDelivery(r({ outOfOfficeUntilMs: NOW + 1, mentioned: true }), ctx())).toEqual({ push: true });
    expect(decideDelivery(r({ outOfOfficeUntilMs: NOW }), ctx())).toEqual({ push: true });
  });

  it('direct messages push unless muted, ignoring mode, quiet hours, shifts and out of office', () => {
    const d = ctx({ channelType: 'direct' });
    const all = r({
      prefs: { mode: 'urgent_only', mutedUntil: null },
      settings: { quietHours: { start: '00:00', end: '23:59' }, offShiftQuiet: true },
      hasShifts: true,
      outOfOfficeUntilMs: NOW + 1,
    });
    expect(decideDelivery(all, d)).toEqual({ push: true });
    expect(decideDelivery(r({ prefs: { mode: 'all', mutedUntil: ts(NOW + 1) } }), d)).toEqual({ push: false, reason: 'muted' });
  });

  it('an unknown mode is treated as all', () => {
    expect(decideDelivery(r({ prefs: { mode: 'bogus' as never, mutedUntil: null } }), ctx())).toEqual({ push: true });
  });
});

describe('quiet hours helpers', () => {
  it('parseHHmm', () => {
    expect(parseHHmm('00:00')).toBe(0);
    expect(parseHHmm('23:59')).toBe(1439);
    for (const bad of ['24:00', '7:00', '07:60', 'x', null, 700]) expect(parseHHmm(bad)).toBeNull();
  });

  it('localMinuteOfDay follows the zone and DST', () => {
    expect(localMinuteOfDay(NOW, NY)).toBe(10 * 60);
    expect(localMinuteOfDay(Date.UTC(2026, 0, 15, 14, 0), NY)).toBe(9 * 60); // EST
    expect(localMinuteOfDay(NOW, 'Not/AZone')).toBe(14 * 60); // UTC fallback
  });

  it('windows: same-day, wrapping past midnight, start inclusive / end exclusive, empty', () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 8, 27, h, m); // UTC zone
    expect(isInQuietHours(at(22), 'UTC', { start: '22:00', end: '07:00' })).toBe(true);
    expect(isInQuietHours(at(3), 'UTC', { start: '22:00', end: '07:00' })).toBe(true);
    expect(isInQuietHours(at(7), 'UTC', { start: '22:00', end: '07:00' })).toBe(false);
    expect(isInQuietHours(at(21, 59), 'UTC', { start: '22:00', end: '07:00' })).toBe(false);
    expect(isInQuietHours(at(12), 'UTC', { start: '12:00', end: '13:00' })).toBe(true);
    expect(isInQuietHours(at(13), 'UTC', { start: '12:00', end: '13:00' })).toBe(false);
    expect(isInQuietHours(at(12), 'UTC', { start: '12:00', end: '12:00' })).toBe(false);
    expect(isInQuietHours(at(12), 'UTC', { start: 'bad', end: '13:00' })).toBe(false);
    expect(isInQuietHours(at(12), 'UTC', null)).toBe(false);
  });
});

describe('availability', () => {
  it('out of office while until > now', () => {
    expect(isOutOfOffice({ outOfOffice: { until: ts(NOW + 1), delegateUid: null, note: null } }, NOW)).toBe(true);
    expect(isOutOfOffice({ outOfOffice: { until: ts(NOW - 1), delegateUid: null, note: null } }, NOW)).toBe(false);
    expect(isOutOfOffice({ outOfOffice: null }, NOW)).toBe(false);
    expect(isOutOfOffice(null, NOW)).toBe(false);
  });

  it('off while state is off and until is null or in the future', () => {
    expect(isOff({ status: { state: 'off', text: null, until: null } }, NOW)).toBe(true);
    expect(isOff({ status: { state: 'off', text: null, until: ts(NOW + 1) } }, NOW)).toBe(true);
    expect(isOff({ status: { state: 'off', text: null, until: ts(NOW - 1) } }, NOW)).toBe(false);
    expect(isOff({ status: { state: 'busy', text: null, until: null } }, NOW)).toBe(false);
    expect(isUnavailable({ status: null, outOfOffice: { until: ts(NOW + 1), delegateUid: null, note: null } }, NOW)).toBe(true);
    expect(isUnavailable({ status: { state: 'in_visit', text: null, until: null }, outOfOffice: null }, NOW)).toBe(false);
  });

  it('outOfOfficeReply wording, with and without a delegate', () => {
    const until = Date.UTC(2026, 9, 3, 12);
    expect(outOfOfficeReply({ name: 'Ann Lee', untilMs: until, timeZone: NY, delegateName: 'Bob Ray' })).toBe(
      'Ann Lee is out of office until Oct 3, 2026. Contact Bob Ray instead.',
    );
    expect(outOfOfficeReply({ name: 'Ann Lee', untilMs: until, timeZone: NY, delegateName: null })).toBe('Ann Lee is out of office until Oct 3, 2026.');
  });
});

describe('role routing skips unavailable members (v4)', () => {
  const H = 3_600_000;
  const shifts = [
    { uid: 'a', startMs: NOW - H, endMs: NOW + H },
    { uid: 'b', startMs: NOW - 2 * H, endMs: NOW + H },
  ];

  it('falls through to the next shift holder, then the fallback', () => {
    expect(resolveOnCall({ shifts, fallbackUids: ['f'], nowMs: NOW, unavailableUids: new Set(['b']) })).toEqual({ uids: ['a'], source: 'shift' });
    expect(resolveOnCall({ shifts, fallbackUids: ['f', 'a'], nowMs: NOW, unavailableUids: new Set(['a', 'b']) })).toEqual({ uids: ['f'], source: 'fallback' });
    expect(resolveOnCall({ shifts, fallbackUids: ['f'], nowMs: NOW, unavailableUids: new Set(['a', 'b', 'f']) })).toEqual({ uids: [], source: 'none' });
  });

  it('fallbackToUnavailable (alerts) pages unavailable people rather than nobody', () => {
    expect(
      resolveOnCall({ shifts, fallbackUids: ['f'], nowMs: NOW, unavailableUids: new Set(['a', 'b', 'f']), fallbackToUnavailable: true }),
    ).toEqual({ uids: ['b', 'a'], source: 'shift' });
    expect(
      resolveOnCall({ shifts, fallbackUids: ['f'], nowMs: NOW, unavailableUids: new Set(['b']), fallbackToUnavailable: true }),
    ).toEqual({ uids: ['a'], source: 'shift' });
  });
});
