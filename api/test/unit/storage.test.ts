import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFileStorage, StorageKeyError } from '../../src/lib/storage.js';

let tempDir: string;
let root: string;
let storage: LocalFileStorage;

beforeEach(async () => {
  // <tempDir>/uploads is the storage root; <tempDir>/outside.txt must stay out of reach.
  tempDir = await mkdtemp(path.join(tmpdir(), 'imotsync-storage-'));
  root = path.join(tempDir, 'uploads');
  await mkdir(root);
  await writeFile(path.join(tempDir, 'outside.txt'), 'keep me');
  storage = new LocalFileStorage(root);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('LocalFileStorage', () => {
  it('saves a file under its key, creating folders, and deletes it again', async () => {
    await storage.save('properties/12/photo.jpg', Buffer.from('jpeg'));
    const file = path.join(root, 'properties', '12', 'photo.jpg');

    expect(await readFile(file, 'utf8')).toBe('jpeg');

    await storage.delete('properties/12/photo.jpg');
    expect(existsSync(file)).toBe(false);
  });

  it('never overwrites an existing file', async () => {
    await storage.save('a/b.jpg', Buffer.from('first'));

    await expect(storage.save('a/b.jpg', Buffer.from('second'))).rejects.toThrow();
    expect(await readFile(path.join(root, 'a', 'b.jpg'), 'utf8')).toBe('first');
  });

  it('treats deleting a missing file as done', async () => {
    await expect(storage.delete('properties/1/gone.jpg')).resolves.toBeUndefined();
  });

  it('deletes a whole folder by prefix', async () => {
    await storage.save('properties/7/a.jpg', Buffer.from('a'));
    await storage.save('properties/7/b.jpg', Buffer.from('b'));
    await storage.save('properties/8/c.jpg', Buffer.from('c'));

    await storage.deletePrefix('properties/7');

    expect(existsSync(path.join(root, 'properties', '7'))).toBe(false);
    expect(existsSync(path.join(root, 'properties', '8', 'c.jpg'))).toBe(true);
  });

  it('lists the files under a folder with their modification time', async () => {
    await storage.save('properties/7/a.jpg', Buffer.from('a'));
    await storage.save('properties/8/sub/c.jpg', Buffer.from('c'));
    await storage.save('demo/d.jpg', Buffer.from('d'));
    await writeFile(path.join(root, 'properties', '7', '.hidden'), 'x');

    const files = await storage.list('properties');

    expect(files.map((file) => file.key)).toEqual(['properties/7/a.jpg', 'properties/8/sub/c.jpg']);
    for (const file of files) {
      expect(Math.abs(file.modifiedAt.getTime() - Date.now())).toBeLessThan(60_000);
    }
    expect(await storage.list('nothing-here')).toEqual([]);
    await expect(storage.list('../outside')).rejects.toThrow(StorageKeyError);
  });

  it('maps keys to /uploads URLs and back', () => {
    expect(storage.publicUrl('properties/12/x.jpg')).toBe('/uploads/properties/12/x.jpg');
    expect(storage.keyFromUrl('/uploads/properties/12/x.jpg')).toBe('properties/12/x.jpg');
    expect(storage.keyFromUrl('/uploads/demo/is-00001-1.jpg')).toBe('demo/is-00001-1.jpg');
  });

  it.each([
    'https://cdn.example.test/uploads/x.jpg',
    '/static/x.jpg',
    '/uploads/../outside.txt',
    '/uploads/demo/../../outside.txt',
    '/uploads/',
  ])('does not take %s for one of its URLs', (url) => {
    expect(storage.keyFromUrl(url)).toBeNull();
  });

  it.each([
    '',
    '..',
    '../outside.txt',
    'demo/../../outside.txt',
    'demo/./x.jpg',
    '/etc/passwd',
    'C:/Windows/win.ini',
    'C:\\Windows\\win.ini',
    '..\\outside.txt',
    'demo\\..\\..\\outside.txt',
    '.hidden',
    'demo/.env',
    'demo//x.jpg',
    'demo/x.jpg/',
    'demo/x y.jpg',
    'demo/%2e%2e/x.jpg',
    'demo/x\0.jpg',
  ])('refuses the key %j for every operation', async (key) => {
    expect(() => storage.resolve(key)).toThrow(StorageKeyError);
    await expect(storage.save(key, Buffer.from('x'))).rejects.toThrow(StorageKeyError);
    await expect(storage.delete(key)).rejects.toThrow(StorageKeyError);
    await expect(storage.deletePrefix(key)).rejects.toThrow(StorageKeyError);

    expect(await readFile(path.join(tempDir, 'outside.txt'), 'utf8')).toBe('keep me');
    expect(existsSync(root)).toBe(true);
  });

  it('resolves every accepted key strictly inside the root', () => {
    for (const key of ['a.jpg', 'demo/is-00001-1.jpg', 'properties/1/x_y-z.jpg', 'a..b/c']) {
      const resolved = storage.resolve(key);
      expect(path.relative(root, resolved).startsWith('..')).toBe(false);
      expect(resolved.startsWith(root + path.sep)).toBe(true);
    }
  });
});
