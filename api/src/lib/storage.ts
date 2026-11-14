import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Where uploaded photos live. Files are addressed by a key such as
 * "properties/12/0f8fad5b-d9cb-469f-a165-70867728950e.jpg"; the database stores the
 * public URL. The local implementation below writes to UPLOAD_DIR, which Express serves
 * at /uploads; an S3-compatible implementation can replace it without touching callers.
 */
export interface FileStorage {
  /** Writes the file, creating folders as needed. */
  save(key: string, data: Buffer): Promise<void>;
  /** Removes the file. A file that is already gone is not an error. */
  delete(key: string): Promise<void>;
  /** Removes everything under a folder key such as "properties/12". */
  deletePrefix(prefix: string): Promise<void>;
  /** The URL clients and portals download the file from. */
  publicUrl(key: string): string;
  /** The key behind a URL that publicUrl() produced, or null for any other URL. */
  keyFromUrl(url: string): string | null;
}

export class StorageKeyError extends Error {
  override readonly name = 'StorageKeyError';
}

/**
 * Keys are "/"-separated segments of letters, digits, "-", "_" and ".", where no segment
 * starts with a dot. That rules out "..", hidden files, backslashes, drive letters and
 * absolute paths before any path is built.
 */
const KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

export const PUBLIC_UPLOADS_PATH = '/uploads';

/** Stores files under one root folder (UPLOAD_DIR), served by Express at /uploads. */
export class LocalFileStorage implements FileStorage {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * Absolute path for a key, strictly inside the root folder. Throws StorageKeyError for
   * anything that is not a well-formed key or would resolve to the root itself or outside.
   */
  resolve(key: string): string {
    if (key.length > 1024 || !KEY_PATTERN.test(key)) {
      throw new StorageKeyError(`Invalid storage key: ${JSON.stringify(key.slice(0, 200))}`);
    }
    const resolved = path.resolve(this.root, ...key.split('/'));
    const relative = path.relative(this.root, resolved);
    if (
      relative === '' ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).some((segment) => segment === '..')
    ) {
      throw new StorageKeyError(`Storage key escapes the upload folder: ${key}`);
    }
    return resolved;
  }

  async save(key: string, data: Buffer): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    // 'wx': keys are random, so an existing file means a bug; never overwrite it.
    await writeFile(file, data, { flag: 'wx' });
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.resolve(prefix), { recursive: true, force: true });
  }

  publicUrl(key: string): string {
    this.resolve(key);
    return `${PUBLIC_UPLOADS_PATH}/${key}`;
  }

  keyFromUrl(url: string): string | null {
    const prefix = `${PUBLIC_UPLOADS_PATH}/`;
    if (!url.startsWith(prefix)) return null;
    const key = url.slice(prefix.length);
    try {
      this.resolve(key);
      return key;
    } catch {
      return null;
    }
  }
}
