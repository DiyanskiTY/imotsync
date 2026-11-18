import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { SkeletonModule } from 'primeng/skeleton';
import { TextareaModule } from 'primeng/textarea';
import { filter, finalize, map, merge, Observable, of, Subject } from 'rxjs';

import { toApiError } from '../../core/api/api-error';
import type { PropertyDetail } from '../../core/api/models';
import { injectPortals } from '../../core/api/portals-api';
import { PropertiesApi } from '../../core/api/properties-api';
import { injectConfirmDestructive } from '../../shared/confirm-destructive';
import { pollWhile } from '../../shared/polling';
import { remoteState } from '../../shared/remote-state';
import { StatusTag } from '../../shared/status-tag';
import { DeletionNotice } from './deletion-notice';
import { FormField } from './form-field';
import { PhotoManager } from './photo-manager';
import { DEAL_OPTIONS, STATUS_OPTIONS, TYPE_OPTIONS } from './property-labels';
import {
  applyServerErrors,
  createPropertyForm,
  formValueFromProperty,
  toCreateBody,
  toPatchBody,
} from './property-form';
import { PublishingPanel } from './publishing-panel';
import { statusWarning } from './status-warning';

/**
 * One property: create it, edit it, manage its photos, check it against every portal and
 * publish it. /properties/new shows the form only; photos and publishing need a saved property.
 */
@Component({
  selector: 'app-property-edit-page',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    ButtonModule,
    InputNumberModule,
    InputTextModule,
    MessageModule,
    SelectButtonModule,
    SelectModule,
    SkeletonModule,
    TextareaModule,
    DeletionNotice,
    FormField,
    PhotoManager,
    PublishingPanel,
    StatusTag,
  ],
  templateUrl: './property-edit-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PropertyEditPage {
  private readonly api = inject(PropertiesApi);
  private readonly router = inject(Router);
  private readonly messages = inject(MessageService);
  private readonly confirmDestructive = injectConfirmDestructive();
  private readonly destroyRef = inject(DestroyRef);
  private readonly reloads = new Subject<void>();
  /** Saved properties go through the same stream as loaded ones: one source of truth. */
  private readonly saves = new Subject<PropertyDetail>();

  /** The property id from the URL; null on /properties/new. */
  protected readonly id = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((params) => parseId(params.get('id')))),
    { requireSync: true },
  );
  protected readonly isNew = computed(() => this.id() === null);

  protected readonly loaded = toSignal(
    remoteState(
      merge(
        merge(toObservable(this.id), this.reloads.pipe(map(() => this.id()))).pipe(
          filter((id): id is number => id !== null),
        ),
        this.saves,
      ),
      (request) => (typeof request === 'number' ? this.api.get(request) : of(request)),
    ),
    { requireSync: true },
  );
  /** The property as last loaded or saved. */
  protected readonly property = computed(() => this.loaded().data);
  /** True while the worker still has a job for one of the listings. */
  private readonly pollDue = computed(
    () => !this.loaded().loading && !!this.property()?.portals.some((l) => l.status === 'pending'),
  );
  /** The property the form was last filled from: what a save compares the form with. */
  private base: PropertyDetail | null = null;

  protected readonly form = createPropertyForm(inject(NonNullableFormBuilder));
  protected readonly saving = signal(false);
  protected readonly deleting = signal(false);
  protected readonly formErrors = signal<string[]>([]);

  protected readonly typeOptions = TYPE_OPTIONS;
  protected readonly dealOptions = DEAL_OPTIONS;
  protected readonly statusOptions = STATUS_OPTIONS;
  /** What an issue of the pre-publish check can point at here: a form field, or the photos. */
  protected readonly fixableFields: ReadonlySet<string> = new Set([
    ...Object.keys(this.form.controls),
    'images',
  ]);
  /** The form's state as signals: PrimeNG inputs change it outside this template's events. */
  private readonly formEvents = toSignal(this.form.events);
  protected readonly dirty = computed(() => {
    this.formEvents();
    return this.form.dirty;
  });
  private readonly portals = injectPortals();
  private readonly status = toSignal(this.form.controls.status.valueChanges, {
    initialValue: this.form.controls.status.value,
  });
  /** Draft or Archived does not take an online property down: say so before it is saved. */
  protected readonly statusWarning = computed(() =>
    statusWarning(this.status(), this.property()?.portals ?? [], this.portals.displayName),
  );
  protected readonly descriptionLength = toSignal(
    this.form.controls.description.valueChanges.pipe(map((value) => [...value].length)),
    { initialValue: 0 },
  );

  constructor() {
    pollWhile(this.pollDue, () => this.reload());
    // The reference code is chosen once, when the property is created.
    effect(() => {
      const refCode = this.form.controls.refCode;
      if (this.isNew()) {
        refCode.enable();
      } else {
        refCode.disable();
      }
    });
    // Show what was loaded or saved, unless the user is in the middle of an edit (polling).
    effect(() => {
      const property = this.property();
      if (property && untracked(() => this.form.pristine)) {
        this.fill(property);
      }
    });
  }

  protected reload(): void {
    this.reloads.next();
  }

  protected save(): void {
    this.form.markAllAsTouched();
    this.formErrors.set([]);
    if (this.form.invalid) {
      this.focusFirstInvalid();
      return;
    }
    const value = this.form.getRawValue();
    const original = this.base;
    if (original === null) {
      this.submit(this.api.create(toCreateBody(value)), (created) => {
        this.messages.add({
          severity: 'success',
          summary: 'Property created',
          detail: `${created.refCode} is saved as ${created.status}. Add photos, then publish it.`,
        });
        void this.router.navigate(['/properties', created.id], { replaceUrl: true });
      });
      return;
    }
    const patch = toPatchBody(original, value);
    if (Object.keys(patch).length === 0) {
      this.form.markAsPristine();
      return;
    }
    this.submit(this.api.update(original.id, patch), (updated) => {
      this.saves.next(updated);
      this.messages.add({
        severity: 'success',
        summary: 'Changes saved',
        detail: updated.portals.some((l) => l.status === 'pending')
          ? 'The portals that show this property get the update now.'
          : `${updated.refCode} is up to date.`,
      });
    });
  }

  protected discard(): void {
    const property = this.property();
    if (property) {
      this.fill(property);
    } else {
      this.form.reset();
    }
    this.formErrors.set([]);
  }

  private fill(property: PropertyDetail): void {
    this.base = property;
    this.form.reset(formValueFromProperty(property));
  }

  /** Brings the field an issue of the pre-publish check is about into view. */
  protected focusField(field: string): void {
    if (field === 'images') {
      document.getElementById('photos')?.scrollIntoView?.({ behavior: 'smooth' });
      return;
    }
    const element = document.getElementById(`field-${field}`);
    element?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    element?.focus({ preventScroll: true });
  }

  protected confirmDelete(): void {
    const property = this.property();
    if (!property) {
      return;
    }
    this.confirmDestructive({
      header: `Delete ${property.refCode}?`,
      message:
        'The property, its photos and its job history are deleted. A property that is still ' +
        'on a portal must be removed from it first.',
      accept: () => this.delete(property),
    });
  }

  private delete(property: PropertyDetail): void {
    this.deleting.set(true);
    this.api
      .delete(property.id)
      .pipe(
        finalize(() => this.deleting.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (result) => {
          if (result === 'deleted') {
            this.messages.add({ severity: 'success', summary: `${property.refCode} deleted` });
            void this.router.navigateByUrl('/properties');
          } else {
            this.messages.add({
              severity: 'info',
              summary: `${property.refCode} scheduled for deletion`,
              detail:
                'It is archived now; the notice on this page says when it is deleted and how to cancel.',
              life: 8000,
            });
            this.reload();
          }
        },
        error: (error: unknown) =>
          this.messages.add({
            severity: 'error',
            summary: 'Not deleted',
            detail: toApiError(error).message,
            life: 8000,
          }),
      });
  }

  private submit(request: Observable<PropertyDetail>, done: (saved: PropertyDetail) => void): void {
    this.saving.set(true);
    request
      .pipe(
        finalize(() => this.saving.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (saved) => {
          this.form.markAsPristine();
          done(saved);
        },
        error: (error: unknown) => {
          const apiError = toApiError(error);
          // The only conflict a create can run into is a reference code that is taken.
          const details =
            apiError.code === 'CONFLICT' && this.isNew()
              ? [{ field: 'refCode', message: apiError.message }]
              : apiError.details;
          const unmatched = applyServerErrors(this.form, details);
          this.formErrors.set(details.length === 0 ? [apiError.message] : unmatched);
          this.focusFirstInvalid();
        },
      });
  }

  private focusFirstInvalid(): void {
    const invalid = Object.entries(this.form.controls).find(([, control]) => control.invalid);
    if (invalid) {
      document.getElementById(`field-${invalid[0]}`)?.focus();
    }
  }
}

function parseId(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const id = Number(value);
  // A malformed id still goes to the API, whose error message the page then shows.
  return Number.isInteger(id) && id > 0 ? id : 0;
}
