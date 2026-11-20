import sharp from 'sharp';

/** What every stored photo must meet; the OpenAPI document uses these too. */
export const PHOTO_LIMITS = {
  /** Smallest accepted shorter side; portals reject or bury smaller photos. */
  minShortSide: 400,
  /** Decompression-bomb guard: a small file must not decode into gigabytes of pixels. */
  maxInputPixels: 50_000_000,
  /** Stored photos fit inside this square (never enlarged). */
  maxStoredSide: 2048,
  jpegQuality: 82,
} as const;

/**
 * How much one deployment accepts: DEFAULT_UPLOAD_LIMITS, or the public demo's lower ones
 * (src/modules/demo/deployment-profile.ts). GET /api/client-config tells the admin panel.
 */
export interface UploadLimits {
  /** Largest accepted upload per file. */
  maxFileBytes: number;
  maxFilesPerRequest: number;
  maxPerProperty: number;
}

export const DEFAULT_UPLOAD_LIMITS: Readonly<UploadLimits> = Object.freeze({
  maxFileBytes: 15 * 1024 * 1024,
  maxFilesPerRequest: 20,
  maxPerProperty: 40,
});

export const ACCEPTED_FORMATS = ['jpeg', 'png', 'webp', 'avif'] as const;
export type AcceptedFormat = (typeof ACCEPTED_FORMATS)[number];
export const ACCEPTED_FORMATS_TEXT = 'JPEG, PNG, WebP or AVIF';

/** Not an image in an accepted format, or one sharp cannot decode. Maps to 415. */
export class UnsupportedImageError extends Error {
  override readonly name = 'UnsupportedImageError';
}

/** A decodable image that breaks a rule (too small, too many pixels). Maps to 400. */
export class RejectedImageError extends Error {
  override readonly name = 'RejectedImageError';
}

const ascii = (buffer: Buffer, start: number, end: number) =>
  buffer.subarray(start, end).toString('latin1');

/**
 * Format from the file's first bytes. A cheap gate before sharp sees the data, so
 * formats that are never accepted (SVG, PDF, TIFF, GIF, HEIC, ...) never reach a decoder.
 */
export function sniffImageFormat(buffer: Buffer): AcceptedFormat | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 12) === 'WEBP') return 'webp';
  if (ascii(buffer, 4, 8) === 'ftyp') {
    // ISO-BMFF: major brand at 8..12, compatible brands after the minor version (16..box end).
    const boxEnd = Math.min(buffer.readUInt32BE(0), buffer.length, 256);
    const brands = [ascii(buffer, 8, 12)];
    for (let offset = 16; offset + 4 <= boxEnd; offset += 4)
      brands.push(ascii(buffer, offset, offset + 4));
    if (brands.some((brand) => brand === 'avif' || brand === 'avis')) return 'avif';
  }
  return null;
}

export interface ImageInfo {
  format: AcceptedFormat;
  width: number;
  height: number;
}

/** Checks format and dimensions from the header only (nothing is decoded yet). */
export async function inspectImage(buffer: Buffer): Promise<ImageInfo> {
  const sniffed = sniffImageFormat(buffer);
  if (!sniffed) {
    throw new UnsupportedImageError(`is not a ${ACCEPTED_FORMATS_TEXT} image`);
  }

  const metadata = await sharp(buffer, { limitInputPixels: false })
    .metadata()
    .catch(() => {
      throw new UnsupportedImageError(`is not a readable ${ACCEPTED_FORMATS_TEXT} image`);
    });
  const decoded =
    metadata.format === 'heif' && metadata.compression === 'av1' ? 'avif' : metadata.format;
  if (decoded !== sniffed) {
    throw new UnsupportedImageError(`is not a readable ${ACCEPTED_FORMATS_TEXT} image`);
  }

  const { width, height } = metadata;
  if (width * height > PHOTO_LIMITS.maxInputPixels) {
    const megapixels = Math.round((width * height) / 1_000_000);
    throw new RejectedImageError(
      `is too large (${width}x${height} px, about ${megapixels} megapixels); at most ${PHOTO_LIMITS.maxInputPixels / 1_000_000} megapixels are accepted`,
    );
  }
  const { minShortSide, maxStoredSide } = PHOTO_LIMITS;
  const [shortSide, longSide] = [Math.min(width, height), Math.max(width, height)];
  if (shortSide < minShortSide) {
    throw new RejectedImageError(
      `is too small (${width}x${height} px); the shorter side must be at least ${minShortSide} px`,
    );
  }
  // The rule holds for the stored photo too: fitting a long, narrow image (a panorama)
  // inside the maximum size shrinks its shorter side as well. Compared without division,
  // so the boundary case is exact.
  if (longSide > maxStoredSide && shortSide * maxStoredSide < minShortSide * longSide) {
    const storedShortSide = Math.round((shortSide * maxStoredSide) / longSide);
    throw new RejectedImageError(
      `is too narrow (${width}x${height} px): fitted inside ${maxStoredSide}x${maxStoredSide} px, its shorter side would be ${storedShortSide} px, and at least ${minShortSide} px are needed`,
    );
  }
  return { format: sniffed, width, height };
}

export interface ProcessedImage {
  data: Buffer;
  width: number;
  height: number;
  sizeBytes: number;
}

/**
 * Normalises a photo for storage and for the portals:
 * - turned upright from the EXIF orientation,
 * - all metadata removed (phone photos carry GPS coordinates, camera serials, ...),
 * - fitted inside 2048x2048 without enlarging,
 * - transparency flattened onto white,
 * - encoded as a progressive mozjpeg JPEG.
 */
export async function processImage(buffer: Buffer): Promise<ProcessedImage> {
  const side = PHOTO_LIMITS.maxStoredSide;
  try {
    const { data, info } = await sharp(buffer, {
      limitInputPixels: PHOTO_LIMITS.maxInputPixels,
      failOn: 'error',
    })
      .rotate()
      .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: PHOTO_LIMITS.jpegQuality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, sizeBytes: data.length };
  } catch {
    throw new UnsupportedImageError(`could not be decoded (corrupt or incomplete image)`);
  }
}
