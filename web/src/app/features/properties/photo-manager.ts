import { CdkDrag, CdkDragDrop, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { ProgressBarModule } from 'primeng/progressbar';
import {
  catchError,
  concatMap,
  finalize,
  from,
  map,
  Observable,
  of,
  retry,
  Subject,
  tap,
  throwError,
  timer,
} from 'rxjs';

import { toApiError } from '../../core/api/api-error';
import { ImagesApi, UploadProgress } from '../../core/api/images-api';
import type { PropertyImage } from '../../core/api/models';
import { injectConfirmDestructive } from '../../shared/confirm-destructive';
import { Photo } from '../../shared/photo';
import {
  ACCEPT_ATTRIBUTE,
  PHOTO_LIMITS,
  planPhotoUpload,
  RejectedPhoto,
} from './photo-upload-plan';

/** Seconds to wait for a free upload slot when the API's 429 names none. */
const DEFAULT_RETRY_AFTER_SECONDS = 10;

/** Same photos in the same order (a reload that changed nothing). */
function samePhotos(a: readonly PropertyImage[], b: readonly PropertyImage[]): boolean {
  return a.length === b.length && a.every((photo, i) => photo.id === b[i]?.id);
}

interface Reorder {
  order: PropertyImage[];
  previous: PropertyImage[];
}

/**
 * A property's photos: upload (with progress), reorder by dragging or with buttons, delete.
 * Changes are shown at once and saved right away; a failed reorder puts the old order back.
 * `changed` tells the page to reload the property, whose listings may now have update jobs.
 */
@Component({
  selector: 'app-photo-manager',
  imports: [CdkDrag, CdkDropList, ButtonModule, MessageModule, ProgressBarModule, Photo],
  templateUrl: './photo-manager.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhotoManager {
  private readonly api = inject(ImagesApi);
  private readonly confirmDestructive = injectConfirmDestructive();
  private readonly messages = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  /** Reorders are saved one after the other, so the last one the user made is the one that sticks. */
  private readonly reorders = new Subject<Reorder>();
  private pendingReorders = 0;

  readonly propertyId = input.required<number>();
  readonly images = input.required<PropertyImage[]>();
  readonly changed = output();

  /**
   * The server's photos, changing only when they really change: a poll that reloads the same
   * photos must not replace an order the user just made or photos still uploading.
   */
  private readonly serverPhotos = computed(() => this.images(), { equal: samePhotos });
  protected readonly photos = linkedSignal(() => [...this.serverPhotos()]);
  protected readonly uploading = signal(false);
  protected readonly progress = signal(0);
  protected readonly uploadError = signal<string | null>(null);
  protected readonly rejected = signal<RejectedPhoto[]>([]);
  protected readonly accept = ACCEPT_ATTRIBUTE;
  protected readonly maxPhotos = PHOTO_LIMITS.maxPerProperty;
  protected readonly full = computed(() => this.photos().length >= this.maxPhotos);

  constructor() {
    this.reorders
      .pipe(
        concatMap(({ order, previous }) =>
          this.api
            .reorder(
              this.propertyId(),
              order.map((photo) => photo.id),
            )
            .pipe(
              map((photos) => ({ photos, previous, error: null })),
              catchError((error: unknown) => of({ photos: null, previous, error })),
            ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe(({ photos, previous, error }) => {
        this.pendingReorders--;
        if (photos === null) {
          this.photos.set(previous);
          this.messages.add({
            severity: 'error',
            summary: 'Order not saved',
            detail: toApiError(error).message,
          });
        } else if (this.pendingReorders === 0) {
          this.photos.set(photos);
          this.changed.emit();
        }
      });
  }

  protected onFilesChosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    this.upload(files);
  }

  protected onDrop(event: CdkDragDrop<PropertyImage[]>): void {
    if (event.previousIndex !== event.currentIndex) {
      this.reorder(event.previousIndex, event.currentIndex);
    }
  }

  protected move(index: number, delta: -1 | 1): void {
    this.reorder(index, index + delta);
  }

  protected confirmDelete(photo: PropertyImage, position: number): void {
    this.confirmDestructive({
      header: 'Delete this photo?',
      message: `Photo ${position} will be removed from the property and, with the next update, from the portals.`,
      icon: 'pi pi-trash',
      accept: () => this.delete(photo),
    });
  }

  private upload(files: File[]): void {
    const plan = planPhotoUpload(files, this.photos().length);
    this.rejected.set(plan.rejected);
    this.uploadError.set(null);
    if (plan.batches.length === 0) {
      return;
    }

    let sentBytes = 0;
    let uploadedAny = false;
    this.uploading.set(true);
    this.progress.set(0);
    from(plan.batches)
      .pipe(
        concatMap((batch) => {
          const batchBytes = batch.reduce((sum, file) => sum + file.size, 0);
          return this.uploadBatch(batch).pipe(
            tap((event) => {
              if (event.kind === 'progress') {
                this.progress.set(percent(sentBytes + event.loaded, plan.totalBytes));
              } else {
                sentBytes += batchBytes;
                uploadedAny = true;
                this.photos.update((photos) => [...photos, ...event.images]);
              }
            }),
          );
        }),
        finalize(() => {
          this.uploading.set(false);
          if (uploadedAny) {
            this.changed.emit();
          }
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({ error: (error: unknown) => this.uploadError.set(toApiError(error).message) });
  }

  /** One request; when every upload slot is busy (429), waits as long as the API says, once. */
  private uploadBatch(batch: File[]): Observable<UploadProgress> {
    return this.api.upload(this.propertyId(), batch).pipe(
      retry({
        count: 1,
        delay: (error: unknown) => {
          const { code, retryAfterSeconds } = toApiError(error);
          return code === 'TOO_MANY_REQUESTS'
            ? timer((retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000)
            : throwError(() => error);
        },
      }),
    );
  }

  private reorder(from: number, to: number): void {
    const previous = this.photos();
    const order = [...previous];
    moveItemInArray(order, from, to);
    this.photos.set(order);
    this.pendingReorders++;
    this.reorders.next({ order, previous });
  }

  private delete(photo: PropertyImage): void {
    this.api
      .delete(this.propertyId(), photo.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.photos.update((photos) => photos.filter((p) => p.id !== photo.id));
          this.changed.emit();
        },
        error: (error: unknown) =>
          this.messages.add({
            severity: 'error',
            summary: 'Photo not deleted',
            detail: toApiError(error).message,
          }),
      });
  }
}

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0;
}
