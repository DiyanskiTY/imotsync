import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt from node:crypto (no native add-ons).
 *
 * Hashes are stored in PHC string format, so the parameters travel with the hash and
 * can be raised later without breaking existing accounts:
 *   $scrypt$ln=15,r=8,p=3$<salt, base64>$<key, base64>
 * The defaults follow the OWASP Password Storage Cheat Sheet (N=2^15, r=8, p=3).
 */
const DEFAULTS = { logN: 15, r: 8, p: 3, saltBytes: 16, keyBytes: 32 } as const;

type Range = readonly [min: number, max: number];

// Bounds for parameters read back from the database. They leave room to raise the cost
// later (N = 2^17 is the strongest OWASP setting), but stop a corrupted or hostile hash
// from making one verification weak, or many times slower than a normal login.
const LIMITS: Record<'logN' | 'r' | 'p' | 'saltBytes' | 'keyBytes', Range> = {
  logN: [14, 17],
  r: [8, 16],
  p: [1, 4],
  saltBytes: [16, 64],
  keyBytes: [16, 64],
};

/**
 * Budget for scrypt's working memory, 128 * N * r bytes: 128 MiB, what N = 2^17 with
 * r = 8 needs. The ranges above bound N and r one by one; this bounds their product,
 * so N = 2^17 with r = 16 (256 MiB) is refused as well.
 */
const MAX_WORKING_MEMORY_BYTES = 128 * 2 ** 20;

const workingMemory = (logN: number, r: number) => 128 * 2 ** logN * r;

const PHC_PATTERN =
  /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

interface ParsedHash {
  logN: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

const inRange = (value: number, [min, max]: Range) => value >= min && value <= max;

const toBase64 = (buffer: Buffer) => buffer.toString('base64').replace(/=+$/, '');

function scryptOptions(logN: number, r: number, p: number): ScryptOptions {
  const N = 2 ** logN;
  // Exactly what OpenSSL allocates (and checks maxmem against): 128 * r * (N + p + 2)
  // bytes. Node's default maxmem (32 MiB) is just below what the defaults need.
  return { N, r, p, maxmem: 128 * r * (N + p + 2) };
}

function deriveKey(
  password: string,
  salt: Buffer,
  keyBytes: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NFKC, so the same visible password always produces the same bytes.
    scrypt(password.normalize('NFKC'), salt, keyBytes, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function parseHash(stored: string): ParsedHash | null {
  const match = PHC_PATTERN.exec(stored);
  if (!match) return null;
  const [, logN = '', r = '', p = '', salt = '', key = ''] = match;

  const parsed: ParsedHash = {
    logN: Number(logN),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt, 'base64'),
    key: Buffer.from(key, 'base64'),
  };
  const valid =
    inRange(parsed.logN, LIMITS.logN) &&
    inRange(parsed.r, LIMITS.r) &&
    inRange(parsed.p, LIMITS.p) &&
    workingMemory(parsed.logN, parsed.r) <= MAX_WORKING_MEMORY_BYTES &&
    inRange(parsed.salt.length, LIMITS.saltBytes) &&
    inRange(parsed.key.length, LIMITS.keyBytes);
  return valid ? parsed : null;
}

/** Hashes a password with a fresh random salt. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0) {
    throw new Error('Password must not be empty');
  }
  const { logN, r, p, saltBytes, keyBytes } = DEFAULTS;
  const salt = randomBytes(saltBytes);
  const key = await deriveKey(password, salt, keyBytes, scryptOptions(logN, r, p));
  return `$scrypt$ln=${logN},r=${r},p=${p}$${toBase64(salt)}$${toBase64(key)}`;
}

/**
 * Checks a password against a stored hash in constant time.
 * Returns false for a wrong password and for a malformed hash or one whose parameters
 * are outside the bounds above; scrypt itself accepts every hash that passes them.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;

  const { logN, r, p, salt, key } = parsed;
  const candidate = await deriveKey(password, salt, key.length, scryptOptions(logN, r, p));
  return timingSafeEqual(candidate, key);
}
