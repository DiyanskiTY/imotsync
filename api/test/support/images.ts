import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';

/*
 * Test images, generated in memory with sharp.
 */

export interface TestImageOptions {
  width?: number;
  height?: number;
  format?: 'jpeg' | 'png' | 'webp' | 'avif';
  /** An RGBA image that is fully transparent. */
  transparent?: boolean;
  /** EXIF orientation tag (6 = rotate 90 degrees clockwise to display). */
  orientation?: number;
  /** Adds GPS coordinates and a camera model, the way a phone does. */
  withGps?: boolean;
}

export async function testImage(options: TestImageOptions = {}): Promise<Buffer> {
  const { width = 800, height = 600, format = 'jpeg', transparent = false } = options;
  let image = sharp({
    create: {
      width,
      height,
      channels: transparent ? 4 : 3,
      background: transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 70, g: 130, b: 180 },
    },
  });
  if (options.withGps) {
    image = image.withExif({
      IFD0: { Make: 'TestPhone', Model: 'TestPhone 1' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '42/1 41/1 2/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '23/1 19/1 18/1',
      },
    });
  }
  if (options.orientation !== undefined) {
    image = image.withMetadata({ orientation: options.orientation });
  }
  switch (format) {
    case 'jpeg':
      return image.jpeg({ quality: 70 }).toBuffer();
    case 'png':
      return image.png().toBuffer();
    case 'webp':
      return image.webp().toBuffer();
    case 'avif':
      return image.avif({ effort: 0 }).toBuffer();
  }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * A tiny file whose PNG header claims huge dimensions: what a decompression bomb looks
 * like before decoding. Its pixel data is a few bytes, nowhere near the claimed size.
 */
export function pngHeaderOnly(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.alloc(64))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
