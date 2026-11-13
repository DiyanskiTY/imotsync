import { pino, type Logger, type LoggerOptions } from 'pino';
import type { NodeEnv } from './config.js';

export type { Logger } from 'pino';

/**
 * JSON logs in production, human-readable logs in development, nothing in tests.
 * Authorization headers and cookies are redacted before they reach any log line.
 */
export function createLogger(config: { nodeEnv: NodeEnv }): Logger {
  const base: LoggerOptions = {
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  };

  switch (config.nodeEnv) {
    case 'test':
      return pino({ ...base, level: 'silent' });
    case 'development':
      return pino({
        ...base,
        level: 'debug',
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      });
    case 'production':
      return pino({ ...base, level: 'info' });
  }
}
