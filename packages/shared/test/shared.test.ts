import { describe, expect, it } from 'vitest';
import { detectAadhaar, isAadhaarNumber, verhoeffCheckDigit, verhoeffValid, looksLikeAadhaarFilename, scanForAadhaar } from '../src/aadhaar';
import { formatINR, formatINRCompact, formatDate, formatDateTime, groupIndian, normalizeMobile, maskMobile, daysBetween } from '../src/format';
import { seedId } from '../src/ids';

function makeAadhaar(payload11: string): string {
  return payload11 + verhoeffCheckDigit(payload11);
}

describe('Verhoeff / Aadhaar detector', () => {
  it('generates and validates check digits', () => {
    const n = makeAadhaar('23456789012');
    expect(n).toHaveLength(12);
    expect(verhoeffValid(n)).toBe(true);
    expect(verhoeffValid(n.slice(0, 11) + ((Number(n[11]) + 1) % 10))).toBe(false);
  });
  it('detects grouped and ungrouped numbers', () => {
    const n = makeAadhaar('23456789012');
    expect(isAadhaarNumber(n)).toBe(true);
    expect(detectAadhaar(`my number is ${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8)}`)).toHaveLength(1);
    expect(detectAadhaar(n)).toHaveLength(1);
    expect(detectAadhaar(`${n.slice(0, 4)}-${n.slice(4, 8)}-${n.slice(8)}`)).toHaveLength(1);
  });
  it('ignores numbers that fail the checksum, start with 0/1, or are +91 mobiles', () => {
    const n = makeAadhaar('23456789012');
    const bad = n.slice(0, 11) + ((Number(n[11]) + 3) % 10);
    expect(detectAadhaar(bad)).toHaveLength(0);
    expect(detectAadhaar('123456789012')).toHaveLength(0);
    expect(detectAadhaar('919876543210')).toHaveLength(0);
    expect(detectAadhaar('Call me on 9876543210')).toHaveLength(0);
  });
  it('flags suspicious file names and scans nested bodies', () => {
    expect(looksLikeAadhaarFilename('aadhaar_card_front.jpg')).toBe(true);
    expect(looksLikeAadhaarFilename('roof-photo.jpg')).toBe(false);
    const n = makeAadhaar('34567890123');
    expect(scanForAadhaar({ notes: `uid ${n}`, nested: { arr: ['ok', n] }, mobile: n })).toEqual(['notes', 'nested.arr[1]']);
  });
});

describe('formatting', () => {
  it('groups digits the Indian way', () => {
    expect(groupIndian(1234567)).toBe('12,34,567');
    expect(groupIndian(999)).toBe('999');
    expect(groupIndian(100000)).toBe('1,00,000');
    expect(formatINR(1234567)).toBe('₹ 12,34,567');
    expect(formatINR(78000)).toBe('₹ 78,000');
    expect(formatINR(1234.5, 2)).toBe('₹ 1,234.50');
    expect(formatINRCompact(2450000)).toBe('₹ 24.50 L');
    expect(formatINRCompact(45000000)).toBe('₹ 4.50 Cr');
  });
  it('formats dates as DD-MMM-YYYY in IST', () => {
    expect(formatDate('2026-11-30')).toBe('30-Nov-2026');
    expect(formatDate('2026-12-31T19:00:00Z')).toBe('01-Jan-2027');
    expect(formatDateTime('2026-10-26T04:30:00Z')).toBe('26-Oct-2026, 10:00 AM');
    expect(daysBetween('2026-10-26', '2026-11-30')).toBe(35);
  });
  it('normalises and masks mobiles', () => {
    expect(normalizeMobile('+91 98765-43210')).toBe('9876543210');
    expect(normalizeMobile('09876543210')).toBe('9876543210');
    expect(normalizeMobile('1234567890')).toBeNull();
    expect(maskMobile('9876543210')).toBe('+91 ••••• ••210');
  });
  it('builds stable UUID-shaped seed ids', () => {
    const id = seedId('lead', 7);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(seedId('lead', 7)).toBe(id);
    expect(seedId('lead', 8)).not.toBe(id);
  });
});

import { sha256Hex, hashMobile } from '../src/ids';
import { createHash } from 'node:crypto';
describe('sha256Hex', () => {
  it('matches node crypto', () => {
    for (const s of ['', 'abc', 'futuresolar:mobile:+919876543210', 'नमस्ते solar ☀ ' + 'x'.repeat(200)]) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
    }
    expect(hashMobile('+919876543210')).toHaveLength(64);
  });
});

import { scanForAadhaar as scan, verhoeffCheckDigit as vcd } from '../src/aadhaar';
describe('Aadhaar guard skips structured identifiers but still scans free text', () => {
  it('does not block e-way bill / UPI reference fields, still blocks notes', () => {
    const n = '23456789012' + vcd('23456789012');
    expect(scan({ ewb_no: n, reference: n, consumer_no: n })).toEqual([]);
    expect(scan({ notes: n, nested: { remarks: `ref ${n}` } })).toEqual(['notes', 'nested.remarks']);
  });
});

import { detectAadhaar as det } from '../src/aadhaar';
describe('Aadhaar guard never trips on UUIDs or *_id fields', () => {
  it('ignores a UUID whose last group is 12 checksum-valid digits', () => {
    // find a UUID-shaped string whose final 12 digits are a valid Verhoeff number
    const tail = '23456789012' + vcd('23456789012');
    const uuid = `0a1b2c3d-1111-4222-8333-${tail}`;
    expect(det(tail)).toHaveLength(1);
    expect(det(uuid)).toHaveLength(0);
    expect(scan({ quote_id: uuid, ids: [uuid], so_ids: [tail], note: 'ok' })).toEqual([]);
    expect(scan({ note: `${uuid} and ${tail}` })).toEqual(['note']);
  });
});
