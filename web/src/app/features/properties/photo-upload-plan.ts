import type { UploadLimits } from '../../core/api/models';
import { DEFAULT_UPLOAD_LIMITS } from '../../core/client-config/client-config';

const MB = 1024 * 1024;

const ACCEPTED_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
const ACCEPTED_EXTENSIONS = /\.(jpe?g|png|webp|avif)$/i;
export const ACCEPT_ATTRIBUTE = ACCEPTED_TYPES.join(',');

export interface RejectedPhoto {
  name: string;
  reason: string;
}

export interface PhotoUploadPlan {
  /** Upload one request per batch, one after the other. */
  batches: File[][];
  rejected: RejectedPhoto[];
  totalBytes: number;
}

/**
 * Checks the chosen files against the API's photo limits (GET /api/client-config) and splits
 * them into requests. The API checks the actual image bytes; this only spares the user an upload
 * that is sure to be refused.
 */
export function planPhotoUpload(
  files: readonly File[],
  existingCount: number,
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
): PhotoUploadPlan {
  const accepted: File[] = [];
  const rejected: RejectedPhoto[] = [];
  let room = limits.maxPerProperty - existingCount;

  for (const file of files) {
    const reason = rejectionReason(file, room, limits);
    if (reason) {
      rejected.push({ name: file.name, reason });
    } else {
      accepted.push(file);
      room--;
    }
  }

  const batches: File[][] = [];
  for (let i = 0; i < accepted.length; i += limits.maxFilesPerRequest) {
    batches.push(accepted.slice(i, i + limits.maxFilesPerRequest));
  }
  const totalBytes = accepted.reduce((sum, file) => sum + file.size, 0);
  return { batches, rejected, totalBytes };
}

/** "15 MB", "5 MB" or "2.5 MB". */
export function formatMegabytes(bytes: number): string {
  return `${Number((bytes / MB).toFixed(1))} MB`;
}

function rejectionReason(file: File, room: number, limits: UploadLimits): string | null {
  const knownType = file.type
    ? ACCEPTED_TYPES.includes(file.type)
    : ACCEPTED_EXTENSIONS.test(file.name);
  if (!knownType) {
    return 'not a JPEG, PNG, WebP or AVIF image';
  }
  if (file.size > limits.maxFileBytes) {
    return `larger than ${formatMegabytes(limits.maxFileBytes)}`;
  }
  if (room <= 0) {
    return `a property has at most ${limits.maxPerProperty} photos`;
  }
  return null;
}
