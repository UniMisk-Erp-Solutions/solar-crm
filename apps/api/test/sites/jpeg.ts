/** Hand-built JPEG bytes with an EXIF block (big-endian TIFF) carrying GPS latitude/longitude and the capture time — no image library needed. */

function u16(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }

/** IFD entry: tag, type, count, then a 4-byte value (inline data or an offset). */
function entry(tag: number, type: number, count: number, value: Buffer): Buffer {
  const v = Buffer.alloc(4);
  value.copy(v);
  return Buffer.concat([u16(tag), u16(type), u32(count), v]);
}

/** decimal degrees → three RATIONALs (degrees, minutes, seconds × 10000) */
function dms(value: number): Buffer {
  const v = Math.abs(value);
  const deg = Math.floor(v);
  const minFloat = (v - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = Math.round((minFloat - min) * 60 * 10000);
  return Buffer.concat([u32(deg), u32(1), u32(min), u32(1), u32(sec), u32(10000)]);
}

export interface ExifSpec { lat: number; lng: number; /** camera wall-clock time as written by the camera (IST), e.g. 2026:10:26 10:30:00 */ takenAt?: string }

export function jpegWithExif(spec: ExifSpec): Buffer {
  const taken = Buffer.from(`${spec.takenAt ?? '2026:10:26 10:30:00'}\0`, 'ascii'); // 20 bytes
  // layout (offsets from the start of the TIFF header): header 0–7, IFD0 8–37, Exif IFD 38–55, date 56–75, GPS IFD 76–129, lat 130–153, lng 154–177
  const header = Buffer.concat([Buffer.from('MM', 'ascii'), u16(0x002a), u32(8)]);
  const ifd0 = Buffer.concat([u16(2), entry(0x8769, 4, 1, u32(38)), entry(0x8825, 4, 1, u32(76)), u32(0)]);
  const exifIfd = Buffer.concat([u16(1), entry(0x9003, 2, 20, u32(56)), u32(0)]);
  const gpsIfd = Buffer.concat([
    u16(4),
    entry(1, 2, 2, Buffer.from(spec.lat >= 0 ? 'N\0' : 'S\0', 'ascii')),
    entry(2, 5, 3, u32(130)),
    entry(3, 2, 2, Buffer.from(spec.lng >= 0 ? 'E\0' : 'W\0', 'ascii')),
    entry(4, 5, 3, u32(154)),
    u32(0),
  ]);
  const tiff = Buffer.concat([header, ifd0, exifIfd, taken, gpsIfd, dms(spec.lat), dms(spec.lng)]);
  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe1]), u16(app1Body.length + 2), app1Body, Buffer.from([0xff, 0xd9])]);
}

/** A JPEG-looking file without any EXIF block (browser-supplied geo is used for these). */
export function plainJpeg(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary'), Buffer.from([0xff, 0xd9])]);
}
