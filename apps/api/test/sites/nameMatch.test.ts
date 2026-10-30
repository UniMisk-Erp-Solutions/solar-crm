import { describe, expect, it } from 'vitest';
import { compareNames, nameTokens, stateInList } from '@solar/shared';

const match = (a: string, b: string) => compareNames(a, b)?.match;

describe('name match (bill vs applicant) — feeds gate G12', () => {
  it('matches the same name regardless of case, order and punctuation', () => {
    expect(compareNames('RAMESH KUMAR PATEL', 'Ramesh Kumar Patel')).toMatchObject({ match: true, reason: 'exact', score: 1 });
    expect(match('Patel Ramesh Kumar', 'Ramesh Kumar Patel')).toBe(true);
    expect(match('Patel, Ramesh K.', 'Ramesh Kumar Patel')).toBe(true);
  });

  it('ignores honorifics and company suffixes', () => {
    expect(match('Shri Ramesh Patel', 'Ramesh Patel')).toBe(true);
    expect(match('Mrs. Hansa Ben Shah', 'Hansa Ben Shah')).toBe(true);
    expect(match('M/s Sun Power Industries Pvt. Ltd.', 'Sun Power Industries Private Limited')).toBe(true);
  });

  it('tolerates a missing middle name, initials, Mohd/Mohammad and transliteration', () => {
    expect(compareNames('Ramesh Patel', 'Ramesh Kumar Patel')).toMatchObject({ match: true, reason: 'missing_middle_name' });
    expect(compareNames('R K Patel', 'Ramesh Kumar Patel')).toMatchObject({ match: true, reason: 'initials' });
    expect(match('Mohd Irfan Khan', 'Mohammad Irfan Khan')).toBe(true);
    expect(match('Pratik Mehta', 'Prateek Mehta')).toBe(true);
  });

  it('does NOT match people who merely look alike (a false match is worse than a false warning)', () => {
    expect(match('Rajesh Patel', 'Ramesh Patel')).toBe(false);
    expect(match('Ramesh Patel', 'Ramesh Shah')).toBe(false);
    expect(match('Ramesh', 'Ramesh Patel')).toBe(false); // one word against two — cannot confirm
    expect(match('R P', 'Ramesh Patel')).toBe(false); // initials alone prove nothing
    expect(match('Ramesh Kumar Patel', 'Ramesh Patel Shah Desai')).toBe(false);
  });

  it('returns null when there is nothing to compare', () => {
    expect(compareNames('', 'Ramesh Patel')).toBeNull();
    expect(compareNames(null, null)).toBeNull();
    expect(compareNames('Shri', 'Ramesh')).toBeNull(); // only an honorific
  });

  it('honours the configurable threshold', () => {
    const lenient = compareNames('Ramesh Kumar Patel', 'Ramesh Kumar Patil', 0.5);
    expect(lenient?.score).toBeLessThan(1);
  });

  it('tokenises across scripts', () => {
    expect(nameTokens('  Dr. Anil  Kumar ')).toEqual(['anil', 'kumar']);
    expect(nameTokens('રમેશ પટેલ')).toHaveLength(2);
  });

  it('compares state names tolerantly', () => {
    expect(stateInList('Jammu & Kashmir', ['Jammu and Kashmir'])).toBe(true);
    expect(stateInList('assam', ['Assam'])).toBe(true);
    expect(stateInList('Gujarat', ['Assam'])).toBe(false);
    expect(stateInList(null, ['Assam'])).toBe(false);
  });
});
