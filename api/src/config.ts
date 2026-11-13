import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Absolute path of the api/ folder. Works from src/ (tsx, Vitest) and from dist/ (compiled). */
export const API_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The project keeps a single .env file at the repository root, next to docker-compose.yml. */
export const ROOT_ENV_FILE = path.resolve(API_ROOT, '..', '.env');

/** Minimum JWT_SECRET length enforced when NODE_ENV=production. */
export const MIN_PRODUCTION_SECRET_LENGTH = 32;

/** Prefix of the public JWT_SECRET placeholders (.env.example); rejected when NODE_ENV=production. */
export const PUBLIC_SECRET_PREFIX = 'dev-only';

const port = z.coerce.number().int().min(1).max(65_535);

const origin = z
  .string()
  .regex(/^https?:\/\/[^/\s]+$/, 'must be an origin such as http://localhost:4200 (no path)');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: port.default(3000),
    // Comma-separated list of browser origins allowed to call the API.
    CORS_ORIGIN: z
      .string()
      .default('http://localhost:4200')
      .transform((value) =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      )
      .pipe(z.array(origin).min(1, 'must list at least one origin')),
    JWT_SECRET: z.string({ error: 'is required' }).min(1, 'is required'),
    UPLOAD_DIR: z.string().min(1).default('./uploads'),
    DB_HOST: z.string().min(1).default('127.0.0.1'),
    DB_PORT: port.default(3307),
    DB_NAME: z.string().min(1).default('imotsync'),
    DB_USER: z.string({ error: 'is required' }).min(1, 'is required'),
    DB_PASSWORD: z.string({ error: 'is required' }),
    SEED_DEMO_PASSWORD: z.string().min(8).default('demo1234'),
    ALLOW_DEMO_SEED: z.stringbool().default(false),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (env.JWT_SECRET.length < MIN_PRODUCTION_SECRET_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: `must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters when NODE_ENV=production`,
      });
    }
    // The placeholder in .env.example is public, so it must never sign real tokens.
    if (env.JWT_SECRET.startsWith(PUBLIC_SECRET_PREFIX)) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: `is the public '${PUBLIC_SECRET_PREFIX}...' placeholder; generate a real one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      });
    }
  });

export type NodeEnv = 'development' | 'test' | 'production';

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface Config {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  port: number;
  corsOrigins: string[];
  jwtSecret: string;
  /** Absolute path; a relative UPLOAD_DIR is resolved from the api/ folder. */
  uploadDir: string;
  db: DbConfig;
  seed: {
    demoPassword: string;
    /** ALLOW_DEMO_SEED: lets the demo seed (and reset) run when NODE_ENV=production. */
    allowInProduction: boolean;
  };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Validates environment variables and maps them to a typed config. Pure: no I/O. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  const e = result.data;
  return {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.API_PORT,
    corsOrigins: e.CORS_ORIGIN,
    jwtSecret: e.JWT_SECRET,
    uploadDir: path.resolve(API_ROOT, e.UPLOAD_DIR),
    db: {
      host: e.DB_HOST,
      port: e.DB_PORT,
      database: e.DB_NAME,
      user: e.DB_USER,
      password: e.DB_PASSWORD,
    },
    seed: {
      demoPassword: e.SEED_DEMO_PASSWORD,
      allowInProduction: e.ALLOW_DEMO_SEED,
    },
  };
}

/**
 * Loads the repository-root .env file into process.env when it exists.
 * Variables that are already set (shell, Docker, CI) always win over the file.
 */
export function loadRootEnvFile(file: string = ROOT_ENV_FILE): void {
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}

/** Reads the root .env file (if any) and returns the validated config. */
export function loadConfig(): Config {
  loadRootEnvFile();
  return parseConfig(process.env);
}
