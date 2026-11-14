/*
 * Just enough of an EXIF reader to prove that a test photo really carries GPS data
 * before the upload tests check that it is gone.
 */

const GPS_IFD_POINTER = 0x8825;
const GPS_LATITUDE = 0x0002;
const RATIONAL = 5;

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** The value itself, or the offset of the value when it needs more than 4 bytes. */
  value: number;
}

/**
 * The GPS latitude as [degrees, minutes, seconds] from raw EXIF data (sharp's
 * metadata().exif), or undefined when there is none.
 */
export function exifGpsLatitude(exif: Buffer | undefined): number[] | undefined {
  if (!exif) return undefined;
  const tiff = exif.subarray(exif.toString('latin1', 0, 6) === 'Exif\0\0' ? 6 : 0);
  const little = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (offset: number) => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
  const u32 = (offset: number) => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));

  const find = (ifd: number, tag: number): IfdEntry | undefined => {
    const count = u16(ifd);
    for (let index = 0; index < count; index++) {
      const entry = ifd + 2 + index * 12;
      if (u16(entry) === tag) {
        return { tag, type: u16(entry + 2), count: u32(entry + 4), value: u32(entry + 8) };
      }
    }
    return undefined;
  };

  const gps = find(u32(4), GPS_IFD_POINTER);
  const latitude = gps && find(gps.value, GPS_LATITUDE);
  if (latitude?.type !== RATIONAL || latitude.count !== 3) return undefined;
  return [0, 1, 2].map(
    (part) => u32(latitude.value + part * 8) / u32(latitude.value + part * 8 + 4),
  );
}
