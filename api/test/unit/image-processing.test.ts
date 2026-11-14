import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  inspectImage,
  PHOTO_LIMITS,
  processImage,
  RejectedImageError,
  sniffImageFormat,
  UnsupportedImageError,
} from '../../src/modules/images/image-processing.js';
import { exifGpsLatitude } from '../support/exif.js';
import { pngHeaderOnly, testImage } from '../support/images.js';

const ftyp = (major: string, ...compatible: string[]) => {
  const brands = [major, '\0\0\0\0', ...compatible].join('');
  const box = Buffer.alloc(8 + brands.length);
  box.writeUInt32BE(box.length, 0);
  box.write('ftyp', 4, 'latin1');
  box.write(brands, 8, 'latin1');
  return Buffer.concat([box, Buffer.alloc(16)]);
};

describe('sniffImageFormat', () => {
  it('recognises the accepted formats by their first bytes', async () => {
    expect(sniffImageFormat(await testImage({ format: 'jpeg' }))).toBe('jpeg');
    expect(sniffImageFormat(await testImage({ format: 'png' }))).toBe('png');
    expect(sniffImageFormat(await testImage({ format: 'webp' }))).toBe('webp');
    expect(sniffImageFormat(await testImage({ format: 'avif', width: 400, height: 400 }))).toBe(
      'avif',
    );
    expect(sniffImageFormat(ftyp('mif1', 'avif', 'miaf'))).toBe('avif');
  });

  it.each([
    ['text', Buffer.from('just some text, renamed to photo.jpg')],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"/>')],
    ['GIF', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')],
    ['PDF', Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')],
    ['TIFF', Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 0, 0, 0, 0])],
    ['HEIC', ftyp('heic', 'mif1', 'heic')],
    ['empty', Buffer.alloc(0)],
  ])('refuses %s', (_name, buffer) => {
    expect(sniffImageFormat(buffer)).toBeNull();
  });
});

describe('inspectImage', () => {
  it.each(['jpeg', 'png', 'webp'] as const)('accepts a %s photo', async (format) => {
    const info = await inspectImage(await testImage({ format, width: 640, height: 480 }));

    expect(info).toEqual({ format, width: 640, height: 480 });
  });

  it('accepts an AVIF photo', async () => {
    expect(
      (await inspectImage(await testImage({ format: 'avif', width: 400, height: 400 }))).format,
    ).toBe('avif');
  });

  it('refuses a text file whatever its name', async () => {
    await expect(inspectImage(Buffer.from('not an image'))).rejects.toBeInstanceOf(
      UnsupportedImageError,
    );
  });

  it('refuses a file that only starts like a JPEG', async () => {
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x41)]);

    await expect(inspectImage(fake)).rejects.toBeInstanceOf(UnsupportedImageError);
  });

  it('refuses a photo whose shorter side is under 400 px', async () => {
    const error = await inspectImage(await testImage({ width: 1200, height: 399 })).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RejectedImageError);
    expect((error as Error).message).toContain('1200x399');
  });

  it('accepts exactly 400 px on the shorter side', async () => {
    await expect(inspectImage(await testImage({ width: 400, height: 900 }))).resolves.toMatchObject(
      {
        width: 400,
      },
    );
  });

  it('refuses a panorama whose shorter side would end up under 400 px once stored', async () => {
    const error = await inspectImage(pngHeaderOnly(400, 6000)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RejectedImageError);
    expect((error as Error).message).toContain('400x6000');
    expect((error as Error).message).toContain('137 px');
    await expect(inspectImage(pngHeaderOnly(2560, 499))).rejects.toBeInstanceOf(RejectedImageError);
  });

  it('accepts a panorama whose stored shorter side is exactly 400 px', async () => {
    const panorama = await testImage({ width: 2560, height: 500 });

    await expect(inspectImage(panorama)).resolves.toMatchObject({ width: 2560, height: 500 });
    const stored = await processImage(panorama);
    expect([stored.width, stored.height]).toEqual([PHOTO_LIMITS.maxStoredSide, 400]);
  });

  it('refuses a decompression bomb from its header, before decoding', async () => {
    const bomb = pngHeaderOnly(30_000, 30_000);

    expect(bomb.length).toBeLessThan(100);
    const error = await inspectImage(bomb).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RejectedImageError);
    expect((error as Error).message).toContain('megapixels');
  });
});

describe('processImage', () => {
  it('re-encodes as JPEG and keeps the size of a photo that fits', async () => {
    const result = await processImage(await testImage({ format: 'png', width: 900, height: 600 }));
    const metadata = await sharp(result.data).metadata();

    expect(metadata.format).toBe('jpeg');
    expect(result).toMatchObject({ width: 900, height: 600, sizeBytes: result.data.length });
  });

  it('fits a large photo inside 2048x2048 and never enlarges', async () => {
    const large = await processImage(await testImage({ width: 3000, height: 1500 }));
    const tall = await processImage(await testImage({ width: 1000, height: 4000 }));

    expect([large.width, large.height]).toEqual([PHOTO_LIMITS.maxStoredSide, 1024]);
    expect([tall.width, tall.height]).toEqual([512, PHOTO_LIMITS.maxStoredSide]);
  });

  it('turns the photo upright from its EXIF orientation', async () => {
    const input = await testImage({ width: 800, height: 500, orientation: 6 });
    expect((await sharp(input).metadata()).orientation).toBe(6);

    const result = await processImage(input);

    expect([result.width, result.height]).toEqual([500, 800]);
    expect((await sharp(result.data).metadata()).orientation).toBeUndefined();
  });

  it('removes all metadata, including GPS coordinates', async () => {
    const input = await testImage({ withGps: true });
    const before = await sharp(input).metadata();
    expect(before.exif?.includes('TestPhone')).toBe(true);
    expect(exifGpsLatitude(before.exif)).toEqual([42, 41, 2]);

    const result = await processImage(input);
    const after = await sharp(result.data).metadata();

    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.iptc).toBeUndefined();
    expect(result.data.includes('TestPhone')).toBe(false);
  });

  it('flattens transparency onto white', async () => {
    const result = await processImage(
      await testImage({ format: 'png', width: 500, height: 500, transparent: true }),
    );
    const { data } = await sharp(result.data).raw().toBuffer({ resolveWithObject: true });

    expect([...data.subarray(0, 3)].every((channel) => channel > 245)).toBe(true);
  });

  it('refuses to decode more than 50 megapixels even when called directly', async () => {
    await expect(processImage(pngHeaderOnly(8000, 8000))).rejects.toBeInstanceOf(
      UnsupportedImageError,
    );
  });

  it('refuses a truncated photo', async () => {
    const photo = await testImage({ width: 1600, height: 1200 });

    await expect(
      processImage(photo.subarray(0, Math.floor(photo.length / 2))),
    ).rejects.toBeInstanceOf(UnsupportedImageError);
  });
});
