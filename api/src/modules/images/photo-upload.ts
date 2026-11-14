import type { Request, Response } from 'express';
import multer from 'multer';
import { HttpError, validationError } from '../../lib/http-error.js';
import { PHOTO_LIMITS } from './image-processing.js';

/** The multipart field that carries the photos. */
export const PHOTO_FIELD = 'photos';

const MB = 1024 * 1024;

/**
 * The largest multipart body worth reading: every file at its size limit, plus room for
 * the boundaries and part headers. Anything bigger is refused without being read.
 */
export const MAX_UPLOAD_BODY_BYTES =
  PHOTO_LIMITS.maxFilesPerRequest * PHOTO_LIMITS.maxFileBytes + MB;

/**
 * Time the whole multipart body has to arrive by default: about 5 MB/s for the largest
 * upload, far less for a few phone photos. A slower upload gets 408 REQUEST_TIMEOUT.
 */
export const DEFAULT_UPLOAD_BODY_TIMEOUT_MS = 60_000;

/** The longest delay setTimeout takes; anything longer would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** A received photo: its bytes, and the client's file name for error messages. */
export interface UploadedPhoto {
  /** Whoever holds the photo may replace this with an empty buffer once it is processed. */
  buffer: Buffer;
  originalName: string;
}

/** Client-supplied name (of a file or a form field), safe to quote in an error message. */
function cleanName(name: string | undefined): string {
  // eslint-disable-next-line no-control-regex -- removing control characters on purpose
  const cleaned = (name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
}

/** Client-supplied file name, safe to quote in an error message. */
export function displayName(originalName: string | undefined, index: number): string {
  const cleaned = cleanName(originalName);
  return cleaned === '' ? `photo ${index + 1}` : cleaned;
}

/** A multipart field name for error details; `body` when the part has no usable name. */
function fieldName(name: string | undefined): string {
  const cleaned = cleanName(name);
  return cleaned === '' ? 'body' : cleaned;
}

function bodyTooLarge(): HttpError {
  return new HttpError(
    413,
    'PAYLOAD_TOO_LARGE',
    `The upload is larger than ${PHOTO_LIMITS.maxFilesPerRequest} photos of ${PHOTO_LIMITS.maxFileBytes / MB} MB`,
  );
}

function duration(ms: number): string {
  const seconds = ms / 1000;
  if (!Number.isInteger(seconds)) return `${ms} ms`;
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

function bodyTimedOut(ms: number): HttpError {
  return new HttpError(
    408,
    'REQUEST_TIMEOUT',
    `The upload did not arrive within ${duration(ms)}. On a slow connection, send fewer photos at a time.`,
  );
}

/** A text field, or a part without a name: an upload takes files in PHOTO_FIELD only. */
function notAPhotoField(name: string | undefined): HttpError {
  const message = `Only files in the "${PHOTO_FIELD}" field are accepted`;
  const field = fieldName(name);
  return validationError(
    [{ field, message }],
    field === 'body'
      ? message
      : `Unexpected field "${field}": only files in the "${PHOTO_FIELD}" field are accepted`,
  );
}

/** multer 2's error codes; @types/multer lists only the older ones. */
type MulterErrorCode =
  | multer.ErrorCode
  | 'LIMIT_FIELD_NESTING'
  | 'LIMIT_FIELD_ARRAY_INDEX'
  | 'INVALID_FIELD_NAME'
  | 'STREAM_DESTROYED';

/**
 * multer's errors (limits, unexpected fields) and busboy's parse errors as API errors.
 * `textField` is the text field the request carried, if any (see createPhotoReceiver):
 * multer reports a second text field without a name, and the first one names the problem.
 */
export function toUploadError(error: unknown, textField?: string): HttpError {
  if (error instanceof multer.MulterError) {
    const { field } = error;
    // Widened on purpose, so the codes the types miss can be matched.
    const code = error.code as MulterErrorCode;
    const fileName = (error as { filename?: unknown }).filename;
    switch (code) {
      case 'LIMIT_FILE_SIZE':
        return new HttpError(
          413,
          'PAYLOAD_TOO_LARGE',
          `${typeof fileName === 'string' ? `"${displayName(fileName, 0)}"` : 'A photo'} is larger than ${PHOTO_LIMITS.maxFileBytes / MB} MB`,
        );
      case 'LIMIT_FILE_COUNT':
        return validationError([
          {
            field: PHOTO_FIELD,
            message: `at most ${PHOTO_LIMITS.maxFilesPerRequest} files per request`,
          },
        ]);
      case 'LIMIT_UNEXPECTED_FILE':
        return field === PHOTO_FIELD
          ? validationError([
              {
                field: PHOTO_FIELD,
                message: `at most ${PHOTO_LIMITS.maxFilesPerRequest} files per request`,
              },
            ])
          : validationError([
              {
                field: fieldName(field),
                message: `is not an accepted field; send the photos in "${PHOTO_FIELD}"`,
              },
            ]);
      // A text field: one with a value (the value limit is 0 bytes), one named like a[b],
      // a name multer cannot store, a part without a name, or a second text field.
      case 'LIMIT_FIELD_VALUE':
      case 'LIMIT_FIELD_NESTING':
      case 'INVALID_FIELD_NAME':
      case 'MISSING_FIELD_NAME':
      case 'LIMIT_FIELD_COUNT':
        return notAPhotoField(field ?? textField);
      default:
        return validationError([
          {
            field: fieldName(field),
            message: `is not accepted (${error.message}); send only files in "${PHOTO_FIELD}"`,
          },
        ]);
    }
  }
  if (error instanceof HttpError) return error;
  // busboy: truncated body, missing boundary, malformed part headers, ...
  return validationError(
    [{ field: 'body', message: 'is not a valid multipart/form-data body' }],
    `Malformed multipart/form-data body: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * The text field multer let into req.body, if any. Only an empty one gets there (see the
 * limits in createPhotoReceiver), under the name the client sent.
 */
function textFieldIn(req: Request): string | undefined {
  const body: unknown = req.body;
  return typeof body === 'object' && body !== null ? Object.keys(body)[0] : undefined;
}

/**
 * Takes the received files out of the request. multer keeps its own references to the
 * file objects until the request is gone, so the bytes are moved out of them: from here on
 * the returned photos are the only holders, and the caller can free them one by one.
 */
function takeFiles(req: Request): UploadedPhoto[] {
  const files = Array.isArray(req.files) ? req.files : [];
  const photos = files.map((file) => ({ buffer: file.buffer, originalName: file.originalname }));
  for (const file of files) file.buffer = Buffer.alloc(0);
  delete req.files;
  return photos;
}

/** Reads the photos of a request; rejects with an API error. */
export type PhotoReceiver = (req: Request, res: Response) => Promise<UploadedPhoto[]>;

export interface PhotoReceiverOptions {
  /**
   * Milliseconds the whole body has to arrive in (default DEFAULT_UPLOAD_BODY_TIMEOUT_MS).
   * Later, the upload is answered with 408 and the connection is closed.
   */
  bodyTimeoutMs?: number;
}

/**
 * Receives 1..20 photos from the "photos" field of a multipart/form-data body into memory
 * (15 MB each at most). Text fields are not accepted. What the files contain is decided
 * later by sharp, not by their declared type or extension.
 *
 * A body declared larger than MAX_UPLOAD_BODY_BYTES is refused before it is read, and the
 * connection is closed. One without a declared length is cut off at that size: after a
 * limit error multer reads the rest of the body before it answers, and that must not go on
 * for as long as the client keeps sending.
 *
 * The body also has to arrive within bodyTimeoutMs, whether the client stalls or trickles
 * it in: the caller holds an upload slot (and the memory behind it) until the promise
 * settles, and without a deadline only Node's request timeout (5 minutes) would end it.
 * On the deadline the promise rejects with 408 and the connection is closed once that is
 * sent, which also ends multer's reading of the body.
 */
export function createPhotoReceiver({
  bodyTimeoutMs = DEFAULT_UPLOAD_BODY_TIMEOUT_MS,
}: PhotoReceiverOptions = {}): PhotoReceiver {
  if (!Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > MAX_TIMER_MS) {
    throw new RangeError(
      `An upload body timeout must be a whole number of milliseconds from 1 to ${MAX_TIMER_MS}, not ${bodyTimeoutMs}`,
    );
  }

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: PHOTO_LIMITS.maxFileBytes,
      files: PHOTO_LIMITS.maxFilesPerRequest,
      // Text fields are refused, by name. busboy stops at the `fields` limit without
      // saying which field went over it, so one field is let through, with no room for a
      // value: multer refuses it by name if it has one (LIMIT_FIELD_VALUE), and leaves an
      // empty one in req.body, where textFieldIn finds it. A second field ends the upload
      // (LIMIT_FIELD_COUNT), and the first one is in req.body by then.
      fields: 1,
      fieldSize: 0,
      // A name like a[b] would be stored in req.body as {a: {b}}; refuse it by name.
      fieldNestingDepth: 0,
    },
    // Browsers and HTTP clients send UTF-8 file names (Cyrillic, for example).
    defParamCharset: 'utf8',
  }).array(PHOTO_FIELD, PHOTO_LIMITS.maxFilesPerRequest);

  return (req, res) =>
    new Promise<UploadedPhoto[]>((resolve, reject) => {
      if (!req.is('multipart/form-data')) {
        reject(
          new HttpError(
            415,
            'UNSUPPORTED_MEDIA_TYPE',
            `Photos must be sent as multipart/form-data in the field "${PHOTO_FIELD}"`,
          ),
        );
        return;
      }
      if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BODY_BYTES) {
        res.set('Connection', 'close');
        reject(bodyTooLarge());
        return;
      }

      let received = 0;
      let cutOff = false;
      const countBytes = (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_UPLOAD_BODY_BYTES && !cutOff) {
          cutOff = true;
          req.destroy();
        }
      };
      req.on('data', countBytes);

      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        res.set('Connection', 'close');
        reject(bodyTimedOut(bodyTimeoutMs));
      }, bodyTimeoutMs);

      upload(req, res, (error: unknown) => {
        clearTimeout(deadline);
        req.off('data', countBytes);
        // Already rejected with 408; multer has only now let go of the body.
        if (timedOut) return;
        const textField = textFieldIn(req);
        if (cutOff) reject(bodyTooLarge());
        else if (error !== undefined) reject(toUploadError(error, textField));
        else if (textField !== undefined) reject(notAPhotoField(textField));
        else resolve(takeFiles(req));
      });
    });
}
