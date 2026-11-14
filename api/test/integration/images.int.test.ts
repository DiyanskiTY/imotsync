import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import type { Knex } from 'knex';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { LocalFileStorage } from '../../src/lib/storage.js';
import { createLogger } from '../../src/logger.js';
import type { ErrorBody } from '../../src/middleware/error-handler.js';
import { PHOTO_LIMITS } from '../../src/modules/images/image-processing.js';
import type { PropertyImageDto } from '../../src/modules/images/images.mappers.js';
import { createImagesService } from '../../src/modules/images/images.service.js';
import type { PropertyDetailDto } from '../../src/modules/properties/properties.mappers.js';
import { exifGpsLatitude } from '../support/exif.js';
import { testImage } from '../support/images.js';
import { expectDocumented } from '../support/openapi.js';
import {
  authHeader,
  backdate,
  BACKDATED,
  closeApiFixture,
  fileForUrl,
  startApiFixture,
  type ApiFixture,
} from './api-fixture.js';

let fx: ApiFixture;
let auth: { Authorization: string };

beforeAll(async () => {
  fx = await startApiFixture();
  auth = await authHeader(fx.app);
});

afterAll(async () => {
  await closeApiFixture(fx);
});

async function newProperty(): Promise<PropertyDetailDto> {
  const res = await request(fx.app)
    .post('/api/properties')
    .set(auth)
    .send({ type: 'apartment', dealType: 'sale', city: 'Sofia' });
  expect(res.status).toBe(201);
  return res.body as PropertyDetailDto;
}

const getProperty = async (id: number) =>
  (await request(fx.app).get(`/api/properties/${id}`).set(auth)).body as PropertyDetailDto;

interface Photo {
  data: Buffer;
  name: string;
}

async function upload(propertyId: number, photos: Photo[]) {
  let req = request(fx.app).post(`/api/properties/${propertyId}/images`).set(auth);
  for (const photo of photos) req = req.attach('photos', photo.data, photo.name);
  const res = await req;
  expectDocumented(res, 'post', '/properties/{id}/images');
  return res;
}

const imagesOf = (res: { body: unknown }) => (res.body as { data: PropertyImageDto[] }).data;

describe('POST /api/properties/:id/images', () => {
  it('stores JPEG and PNG uploads as JPEGs, in order, after the existing photos', async () => {
    const property = await newProperty();
    const first = await upload(property.id, [{ data: await testImage(), name: 'first.jpg' }]);
    const res = await upload(property.id, [
      { data: await testImage({ width: 3000, height: 2000 }), name: 'big.jpg' },
      { data: await testImage({ format: 'png', width: 640, height: 480 }), name: 'plan.png' },
    ]);

    expect(first.status).toBe(201);
    expect(res.status).toBe(201);
    const [big, plan] = imagesOf(res);
    expect(big).toMatchObject({ sortOrder: 1, width: 2048, height: 1365 });
    expect(plan).toMatchObject({ sortOrder: 2, width: 640, height: 480 });
    for (const image of [big, plan]) {
      expect(image?.url).toMatch(
        new RegExp(`^/uploads/properties/${property.id}/[0-9a-f-]{36}\\.jpg$`),
      );
      const stored = await readFile(fileForUrl(fx, image?.url ?? ''));
      expect(stored.length).toBe(image?.sizeBytes);
      expect((await sharp(stored).metadata()).format).toBe('jpeg');
    }

    const served = await request(fx.app).get(plan?.url ?? '');
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
  });

  it('removes GPS coordinates and other metadata, and turns photos upright', async () => {
    const property = await newProperty();
    const phonePhoto = await testImage({ width: 1200, height: 900, orientation: 6, withGps: true });
    // The input really carries a position (42° 41' 2" N), so its absence below means something.
    expect(exifGpsLatitude((await sharp(phonePhoto).metadata()).exif)).toEqual([42, 41, 2]);

    const [image] = imagesOf(
      await upload(property.id, [{ data: phonePhoto, name: 'IMG_0001.jpg' }]),
    );
    const stored = await readFile(fileForUrl(fx, image?.url ?? ''));
    const metadata = await sharp(stored).metadata();

    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    expect(stored.includes('TestPhone')).toBe(false);
    expect([image?.width, image?.height]).toEqual([900, 1200]);
  });

  it('touches the property and makes the first photo its cover', async () => {
    const property = await newProperty();
    await backdate(fx, property.id);
    const [image] = imagesOf(
      await upload(property.id, [{ data: await testImage(), name: 'a.jpg' }]),
    );
    const after = await getProperty(property.id);

    expect(after.updatedAt > BACKDATED).toBe(true);
    expect(after.coverImageUrl).toBe(image?.url);
    expect(after.imageCount).toBe(1);
  });

  it('decides by content: a PNG named .txt and a JPEG named .png are stored as JPEGs', async () => {
    const property = await newProperty();
    const res = await request(fx.app)
      .post(`/api/properties/${property.id}/images`)
      .set(auth)
      .attach('photos', await testImage({ format: 'png' }), {
        filename: 'scan.txt',
        contentType: 'text/plain',
      })
      .attach('photos', await testImage(), { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expectDocumented(res, 'post', '/properties/{id}/images');
    for (const image of imagesOf(res)) {
      const stored = await readFile(fileForUrl(fx, image.url));
      expect((await sharp(stored).metadata()).format).toBe('jpeg');
    }
  });

  it('decides by content: a text file named .jpg is refused with 415, naming the file', async () => {
    const property = await newProperty();
    const res = await upload(property.id, [
      { data: await testImage(), name: 'good.jpg' },
      { data: Buffer.from('this is not a photo at all'), name: 'notes.jpg' },
    ]);

    expect(res.status).toBe(415);
    expect((res.body as ErrorBody).error).toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: expect.stringContaining('"notes.jpg"') as string,
      details: [{ field: 'photos[1]', message: expect.stringContaining('notes.jpg') as string }],
    });
    // Nothing of the request is kept, not even the good photo.
    expect((await getProperty(property.id)).images).toEqual([]);
  });

  it('refuses a photo under 400 px on the shorter side with 400', async () => {
    const property = await newProperty();
    const res = await upload(property.id, [
      { data: await testImage({ width: 1000, height: 300 }), name: 'thumbnail.jpg' },
    ]);

    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    expect((res.body as ErrorBody).error.message).toContain('thumbnail.jpg');
  });

  it('refuses a panorama that would be stored under 400 px on the shorter side', async () => {
    const property = await newProperty();
    const res = await upload(property.id, [
      { data: await testImage({ width: 6000, height: 400 }), name: 'panorama.jpg' },
    ]);

    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'photos[0]', message: expect.stringContaining('137 px') as string }],
    });
    expect((await getProperty(property.id)).images).toEqual([]);
  });

  it('refuses a file over 15 MB with 413, and keeps nothing', async () => {
    const property = await newProperty();
    const filesBefore = await readdir(fx.uploadDir, { recursive: true });
    const res = await upload(property.id, [
      { data: await testImage(), name: 'small.jpg' },
      { data: Buffer.alloc(PHOTO_LIMITS.maxFileBytes + 1, 0xff), name: 'huge.jpg' },
    ]);

    expect(PHOTO_LIMITS.maxFileBytes).toBe(15 * 1024 * 1024);
    expect(res.status).toBe(413);
    expect((res.body as ErrorBody).error).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      message: '"huge.jpg" is larger than 15 MB',
    });
    expect(await fx.db('property_images').where({ property_id: property.id })).toEqual([]);
    expect(await readdir(fx.uploadDir, { recursive: true })).toEqual(filesBefore);
  });

  it('allows at most 40 photos per property (409 beyond)', async () => {
    const property = await newProperty();
    const small = await testImage({ width: 400, height: 400 });
    const batch = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ data: small, name: `p${index}.jpg` }));

    expect((await upload(property.id, batch(20))).status).toBe(201);
    expect((await upload(property.id, batch(19))).status).toBe(201);
    const tooMany = await upload(property.id, batch(2));
    const last = await upload(property.id, batch(1));
    const full = await upload(property.id, batch(1));

    expect(tooMany.status).toBe(409);
    expect((tooMany.body as ErrorBody).error.message).toMatch(/at most 40 photos/);
    expect(last.status).toBe(201);
    expect(full.status).toBe(409);
    const images = (await getProperty(property.id)).images;
    expect(images).toHaveLength(40);
    expect(images.map((image) => image.sortOrder)).toEqual([...Array(40).keys()]);
  });

  it('refuses more than 20 files in one request, other fields, and other content types', async () => {
    const property = await newProperty();
    const small = await testImage({ width: 400, height: 400 });
    const tooMany = await upload(
      property.id,
      Array.from({ length: 21 }, (_, index) => ({ data: small, name: `p${index}.jpg` })),
    );
    const wrongField = await request(fx.app)
      .post(`/api/properties/${property.id}/images`)
      .set(auth)
      .attach('image', small, 'a.jpg');
    const textField = await request(fx.app)
      .post(`/api/properties/${property.id}/images`)
      .set(auth)
      .field('caption', 'hello')
      .attach('photos', small, 'a.jpg');
    const onlyField = await request(fx.app)
      .post(`/api/properties/${property.id}/images`)
      .set(auth)
      .field('nothing', '');
    // A well-formed multipart body without a single part.
    const noFiles = await request(fx.app)
      .post(`/api/properties/${property.id}/images`)
      .set(auth)
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .send('--x--\r\n');
    const json = await request(fx.app)
      .post(`/api/properties/${property.id}/images`)
      .set(auth)
      .send({ photos: [] });

    for (const res of [tooMany, wrongField, textField, onlyField, noFiles]) {
      expect(res.status, res.text).toBe(400);
      expect((res.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
      expectDocumented(res, 'post', '/properties/{id}/images');
    }
    expect((noFiles.body as ErrorBody).error.details).toEqual([
      { field: 'photos', message: 'must contain at least one photo' },
    ]);
    const onlyPhotos = 'Only files in the "photos" field are accepted';
    expect((textField.body as ErrorBody).error.details).toEqual([
      { field: 'caption', message: onlyPhotos },
    ]);
    expect((onlyField.body as ErrorBody).error.details).toEqual([
      { field: 'nothing', message: onlyPhotos },
    ]);
    expect(json.status).toBe(415);
    expect((json.body as ErrorBody).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expectDocumented(json, 'post', '/properties/{id}/images');
    expect((await getProperty(property.id)).images).toEqual([]);
  });

  it('answers 404 for a missing property', async () => {
    const res = await upload(99999, [{ data: await testImage(), name: 'a.jpg' }]);

    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
  });

  it('puts new photos after the highest sort order, also after a photo was deleted', async () => {
    const property = await newProperty();
    const small = await testImage({ width: 400, height: 400 });
    const [first, second, third] = imagesOf(
      await upload(
        property.id,
        [0, 1, 2].map((index) => ({ data: small, name: `${index}.jpg` })),
      ),
    );
    await request(fx.app).delete(`/api/properties/${property.id}/images/${first?.id}`).set(auth);

    // Two photos are left, at sort orders 1 and 2: a count would give 2 again.
    const [added] = imagesOf(await upload(property.id, [{ data: small, name: 'new.jpg' }]));
    const images = (await getProperty(property.id)).images;

    expect(added?.sortOrder).toBe(3);
    expect(images.map((image) => image.id)).toEqual([second?.id, third?.id, added?.id]);
    expect(new Set(images.map((image) => image.sortOrder)).size).toBe(3);
  });
});

describe('a failed upload', () => {
  it('removes the files it already wrote when the database step fails', async () => {
    const property = await newProperty();
    const local = new LocalFileStorage(fx.uploadDir);
    const saved: string[] = [];
    // Writes the files, but the property is deleted under the upload's feet after the
    // first one, so the transaction that adds the rows fails.
    const storage = Object.assign(Object.create(local) as LocalFileStorage, {
      async save(key: string, data: Buffer) {
        await local.save(key, data);
        saved.push(key);
        if (saved.length === 1) await fx.db('properties').where({ id: property.id }).delete();
      },
    });
    const app = createApp({
      config: fx.config,
      db: fx.db,
      logger: createLogger(fx.config),
      storage,
    });

    const res = await request(app)
      .post(`/api/properties/${property.id}/images`)
      .set(auth)
      .attach('photos', await testImage(), 'a.jpg')
      .attach('photos', await testImage(), 'b.jpg');

    expect(res.status).toBe(404);
    expect(saved).toHaveLength(2);
    for (const key of saved) expect(existsSync(local.resolve(key))).toBe(false);
    expect(await fx.db('property_images').where({ property_id: property.id })).toEqual([]);
  });

  it('keeps the files of committed rows, whatever fails after the commit', async () => {
    const property = await newProperty();
    // Once a transaction has committed, every other query fails, as on a dropped connection.
    let committed = false;
    const db = new Proxy(fx.db, {
      apply(target, thisArg, args: unknown[]) {
        if (committed) throw new Error('Connection lost');
        return Reflect.apply(target, thisArg, args) as unknown;
      },
      get(target, name, receiver) {
        if (name !== 'transaction') return Reflect.get(target, name, receiver) as unknown;
        return async (work: (trx: Knex.Transaction) => Promise<unknown>) => {
          const result = await target.transaction(work);
          committed = true;
          return result;
        };
      },
    });
    const app = createApp({ config: fx.config, db, logger: createLogger(fx.config) });

    const res = await request(app)
      .post(`/api/properties/${property.id}/images`)
      .set(auth)
      .attach('photos', await testImage(), 'a.jpg');

    expect(committed).toBe(true);
    expect(res.status).toBe(201);
    const [image] = imagesOf(res);
    expect(existsSync(fileForUrl(fx, image?.url ?? ''))).toBe(true);
    expect(await fx.db('property_images').where({ property_id: property.id })).toHaveLength(1);
  });

  it('lets go of each upload as soon as its JPEG exists', async () => {
    const property = await newProperty();
    const images = createImagesService({
      db: fx.db,
      storage: new LocalFileStorage(fx.uploadDir),
      logger: createLogger(fx.config),
    });
    const photos = [
      { buffer: await testImage(), originalName: 'a.jpg' },
      { buffer: await testImage({ format: 'png' }), originalName: 'b.png' },
    ];

    expect(await images.upload(property.id, photos)).toHaveLength(2);
    expect(photos.map((photo) => photo.buffer.length)).toEqual([0, 0]);
  });
});

describe('PUT /api/properties/:id/images/order', () => {
  let property: PropertyDetailDto;
  let ids: number[];

  beforeAll(async () => {
    property = await newProperty();
    const photos = await Promise.all(
      [0, 1, 2].map(async (index) => ({ data: await testImage(), name: `${index}.jpg` })),
    );
    ids = imagesOf(await upload(property.id, photos)).map((image) => image.id);
  });

  const reorder = async (imageIds: unknown, propertyId = property.id) => {
    const res = await request(fx.app)
      .put(`/api/properties/${propertyId}/images/order`)
      .set(auth)
      .send({ imageIds });
    expectDocumented(res, 'put', '/properties/{id}/images/order');
    return res;
  };

  it('sets the new order and returns the photos in it', async () => {
    const [a = 0, b = 0, c = 0] = ids;
    await backdate(fx, property.id);
    const res = await reorder([c, a, b]);

    expect(res.status).toBe(200);
    expect(imagesOf(res).map((image) => [image.id, image.sortOrder])).toEqual([
      [c, 0],
      [a, 1],
      [b, 2],
    ]);
    const detail = await getProperty(property.id);
    expect(detail.images.map((image) => image.id)).toEqual([c, a, b]);
    expect(detail.coverImageUrl).toBe(detail.images[0]?.url);
    expect(detail.updatedAt > BACKDATED).toBe(true);
  });

  it('refuses a list with a missing photo', async () => {
    const res = await reorder(ids.slice(0, 2));

    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    expect((res.body as ErrorBody).error.details?.[0]?.message).toContain(
      `missing photo ids: ${ids[2]}`,
    );
  });

  it('refuses a photo of another property', async () => {
    const other = await newProperty();
    const [foreign] = imagesOf(
      await upload(other.id, [{ data: await testImage(), name: 'x.jpg' }]),
    );
    const res = await reorder([...ids, foreign?.id]);

    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error.details?.[0]?.message).toContain(
      `not photos of this property: ${foreign?.id}`,
    );
    expect((await getProperty(other.id)).images).toHaveLength(1);
  });

  it('refuses duplicates and answers 404 for a missing property', async () => {
    const duplicate = await reorder([ids[0], ids[0], ids[1]]);
    const missing = await reorder([1], 99999);

    expect(duplicate.status).toBe(400);
    expect((duplicate.body as ErrorBody).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'imageIds', message: 'must not contain an id twice' }],
    });
    expect(missing.status).toBe(404);
    expect((missing.body as ErrorBody).error.code).toBe('NOT_FOUND');
  });
});

describe('DELETE /api/properties/:id/images/:imageId', () => {
  it('deletes the photo row and its file', async () => {
    const property = await newProperty();
    const [first, second] = imagesOf(
      await upload(property.id, [
        { data: await testImage(), name: 'a.jpg' },
        { data: await testImage(), name: 'b.jpg' },
      ]),
    );
    const file = fileForUrl(fx, first?.url ?? '');
    await backdate(fx, property.id);

    const res = await request(fx.app)
      .delete(`/api/properties/${property.id}/images/${first?.id}`)
      .set(auth);

    expect(res.status).toBe(204);
    expectDocumented(res, 'delete', '/properties/{id}/images/{imageId}');
    expect(existsSync(file)).toBe(false);
    const detail = await getProperty(property.id);
    expect(detail.images.map((image) => image.id)).toEqual([second?.id]);
    expect(detail.coverImageUrl).toBe(second?.url);
    expect(detail.updatedAt > BACKDATED).toBe(true);
  });

  it('deletes a seeded demo photo too', async () => {
    const seeded = await fx.db('property_images').where('url', 'like', '/uploads/demo/%').first();
    if (!seeded) throw new Error('The demo seed has no photos');
    const file = fileForUrl(fx, seeded.url);
    expect(existsSync(file)).toBe(true);

    const res = await request(fx.app)
      .delete(`/api/properties/${seeded.property_id}/images/${seeded.id}`)
      .set(auth);

    expect(res.status).toBe(204);
    expect(existsSync(file)).toBe(false);
  });

  it('answers 404 for a photo of another property, and keeps it', async () => {
    const owner = await newProperty();
    const other = await newProperty();
    const [image] = imagesOf(await upload(owner.id, [{ data: await testImage(), name: 'a.jpg' }]));

    const res = await request(fx.app)
      .delete(`/api/properties/${other.id}/images/${image?.id}`)
      .set(auth);

    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
    expectDocumented(res, 'delete', '/properties/{id}/images/{imageId}');
    expect(existsSync(fileForUrl(fx, image?.url ?? ''))).toBe(true);
    expect((await getProperty(owner.id)).images).toHaveLength(1);
  });
});
