import { describe, expect, it } from 'vitest';
import { directChannelId, patientChannelName, sameMembers, truncateText } from '../../src/domain/channels';

describe('channels', () => {
  it('directChannelId is order-independent', () => {
    expect(directChannelId('bob', 'alice')).toBe('dm_alice_bob');
    expect(directChannelId('alice', 'bob')).toBe('dm_alice_bob');
    expect(() => directChannelId('a', 'a')).toThrow();
    expect(() => directChannelId('', 'a')).toThrow();
  });
  it('patientChannelName uses "{Last}, {First} – Care Team"', () => {
    expect(patientChannelName('Jane', 'Doe')).toBe('Doe, Jane – Care Team');
  });
  it('sameMembers ignores order and duplicates', () => {
    expect(sameMembers(['a', 'b'], ['b', 'a', 'a'])).toBe(true);
    expect(sameMembers(['a'], ['a', 'b'])).toBe(false);
  });
  it('truncateText caps at 140 chars', () => {
    const t = truncateText('x'.repeat(300));
    expect(t.length).toBe(140);
    expect(t.endsWith('…')).toBe(true);
    expect(truncateText('  hi\n there ')).toBe('hi there');
  });
});
