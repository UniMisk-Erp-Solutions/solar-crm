/** Minimal JPEG EXIF reader — extracts GPS latitude/longitude (and capture time) when present. */
export interface ExifInfo { lat: number | null; lng: number | null; taken_at: string | null }

export function readExif(buf: Buffer): ExifInfo {
  const none: ExifInfo = { lat: null, lng: null, taken_at: null };
  try {
    if (buf.length < 12 || buf[0] !== 0xff || buf[1] !== 0xd8) return none;
    let off = 2;
    while (off + 4 < buf.length) {
      if (buf[off] !== 0xff) return none;
      const marker = buf[off + 1]!;
      const len = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && buf.toString('ascii', off + 4, off + 8) === 'Exif') return parseTiff(buf, off + 10);
      if (marker === 0xda) return none; // start of scan — no EXIF found
      off += 2 + len;
    }
  } catch { /* corrupt EXIF is ignored */ }
  return none;
}

function parseTiff(buf: Buffer, base: number): ExifInfo {
  const little = buf.toString('ascii', base, base + 2) === 'II';
  const u16 = (o: number) => (little ? buf.readUInt16LE(base + o) : buf.readUInt16BE(base + o));
  const u32 = (o: number) => (little ? buf.readUInt32LE(base + o) : buf.readUInt32BE(base + o));
  const readIfd = (ifdOff: number): Map<number, { type: number; count: number; valueOff: number }> => {
    const m = new Map<number, { type: number; count: number; valueOff: number }>();
    const n = u16(ifdOff);
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      m.set(u16(e), { type: u16(e + 2), count: u32(e + 4), valueOff: e + 8 });
    }
    return m;
  };
  const typeSize: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };
  const dataOff = (en: { type: number; count: number; valueOff: number }): number => ((typeSize[en.type] ?? 1) * en.count <= 4 ? en.valueOff : u32(en.valueOff));
  const ascii = (en: { type: number; count: number; valueOff: number }): string => buf.toString('ascii', base + dataOff(en), base + dataOff(en) + en.count).replace(/\0.*$/, '');
  const rationals = (en: { type: number; count: number; valueOff: number }): number[] => {
    const o = dataOff(en);
    return Array.from({ length: en.count }, (_, i) => { const d = u32(o + i * 8 + 4); return d === 0 ? 0 : u32(o + i * 8) / d; });
  };

  const ifd0 = readIfd(u32(4));
  const out: ExifInfo = { lat: null, lng: null, taken_at: null };
  const exifPtr = ifd0.get(0x8769);
  if (exifPtr) {
    const dt = readIfd(u32(exifPtr.valueOff)).get(0x9003);
    if (dt) {
      const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(ascii(dt));
      if (m) out.taken_at = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) - 5.5 * 3600 * 1000).toISOString(); // camera clocks are local (IST)
    }
  }
  const gpsPtr = ifd0.get(0x8825);
  if (gpsPtr) {
    const gps = readIfd(u32(gpsPtr.valueOff));
    const latRef = gps.get(1), lat = gps.get(2), lngRef = gps.get(3), lng = gps.get(4);
    if (latRef && lat && lngRef && lng) {
      const dms = (r: number[]) => (r[0] ?? 0) + (r[1] ?? 0) / 60 + (r[2] ?? 0) / 3600;
      out.lat = +(dms(rationals(lat)) * (ascii(latRef).startsWith('S') ? -1 : 1)).toFixed(6);
      out.lng = +(dms(rationals(lng)) * (ascii(lngRef).startsWith('W') ? -1 : 1)).toFixed(6);
    }
  }
  return out;
}
