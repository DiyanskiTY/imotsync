/**
 * The API's photo limits (README › Photos). The API checks the actual image bytes; these checks
 * only spare the user an upload that is sure to be refused.
 */
export const PHOTO_LIMITS = {
  maxFileBytes: 15 * 1024 * 1024,
  maxFilesPerRequest: 20,
  maxPerProperty: 40,
} as const;

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

export function planPhotoUpload(files: readonly File[], existingCount: number): PhotoUploadPlan {
  const accepted: File[] = [];
  const rejected: RejectedPhoto[] = [];
  let room = PHOTO_LIMITS.maxPerProperty - existingCount;

  for (const file of files) {
    const reason = rejectionReason(file, room);
    if (reason) {
      rejected.push({ name: file.name, reason });
    } else {
      accepted.push(file);
      room--;
    }
  }

  const batches: File[][] = [];
  for (let i = 0; i < accepted.length; i += PHOTO_LIMITS.maxFilesPerRequest) {
    batches.push(accepted.slice(i, i + PHOTO_LIMITS.maxFilesPerRequest));
  }
  const totalBytes = accepted.reduce((sum, file) => sum + file.size, 0);
  return { batches, rejected, totalBytes };
}

function rejectionReason(file: File, room: number): string | null {
  const knownType = file.type
    ? ACCEPTED_TYPES.includes(file.type)
    : ACCEPTED_EXTENSIONS.test(file.name);
  if (!knownType) {
    return 'not a JPEG, PNG, WebP or AVIF image';
  }
  if (file.size > PHOTO_LIMITS.maxFileBytes) {
    return 'larger than 15 MB';
  }
  if (room <= 0) {
    return `a property has at most ${PHOTO_LIMITS.maxPerProperty} photos`;
  }
  return null;
}
