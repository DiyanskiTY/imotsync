import { randomUUID } from 'node:crypto';
import { pinoHttp, type HttpLogger } from 'pino-http';
import type { Logger } from '../logger.js';

// Accept a caller-supplied request id (e.g. from a reverse proxy) only if it looks sane.
const VALID_REQUEST_ID = /^[\w.:-]{1,128}$/;

/** The parts of pino's serialized request/response worth keeping (no header dumps). */
interface LoggedRequest {
  id: unknown;
  method: string;
  url: string;
  remoteAddress?: string;
}
interface LoggedResponse {
  statusCode: number;
}

/** One log line per request, with a request id that is also returned as X-Request-Id. */
export function createRequestLogger(logger: Logger): HttpLogger {
  return pinoHttp({
    logger,
    genReqId(req, res) {
      const incoming = req.headers['x-request-id'];
      const id =
        typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    // Container health probes would otherwise flood the log.
    autoLogging: { ignore: (req) => req.url === '/api/health' },
    serializers: {
      req: ({ id, method, url, remoteAddress }: LoggedRequest): LoggedRequest => ({
        id,
        method,
        url,
        remoteAddress,
      }),
      res: ({ statusCode }: LoggedResponse): LoggedResponse => ({ statusCode }),
    },
    customLogLevel(_req, res, error) {
      if (error || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  });
}
