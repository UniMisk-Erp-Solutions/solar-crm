import { describe, expect, it } from 'vitest';
import { median, percentile, ratioPct, round, summarise, weekStartIst } from '../../src/services/kpi/stats';

describe('percentile maths (linear interpolation, same as Postgres percentile_cont)', () => {
  const tenDays = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('median of an even-sized list interpolates between the middle values', () => {
    expect(median(tenDays)).toBe(5.5);
  });

  it('p90 of 1..10 is 9.1', () => {
    expect(percentile(tenDays, 90)).toBeCloseTo(9.1, 10);
    expect(summarise(tenDays)).toMatchObject({ n: 10, median: 5.5, p90: 9.1, mean: 5.5, max: 10 });
  });

  it('median / p90 of an odd-sized unsorted list', () => {
    const v = [30, 5, 12, 20, 9];
    expect(median(v)).toBe(12);
    expect(percentile(v, 90)).toBeCloseTo(26, 10); // sorted 5,9,12,20,30 → rank 3.6 → 20 + 0.6×10
    expect(percentile(v, 0)).toBe(5);
    expect(percentile(v, 100)).toBe(30);
  });

  it('single value and empty list', () => {
    expect(median([7])).toBe(7);
    expect(percentile([7], 90)).toBe(7);
    expect(median([])).toBeNull();
    expect(summarise([])).toMatchObject({ n: 0, median: null, p90: null, mean: null });
  });

  it('ignores non-finite values', () => {
    expect(median([1, Number.NaN, 3])).toBe(2);
  });

  it('ratioPct guards a zero denominator and rounds to one decimal', () => {
    expect(ratioPct(2, 3)).toBe(66.7);
    expect(ratioPct(0, 0)).toBeNull();
    expect(round(2.345, 2)).toBe(2.35);
  });

  it('weekStartIst returns the Monday of the IST week', () => {
    // Mon 26-Oct-2026 10:30 IST and Sun 25-Oct-2026 23:00 IST fall in different weeks
    expect(weekStartIst(Date.parse('2026-10-26T05:00:00Z'))).toBe('2026-10-26');
    expect(weekStartIst(Date.parse('2026-10-25T17:30:00Z'))).toBe('2026-10-19');
  });
});
