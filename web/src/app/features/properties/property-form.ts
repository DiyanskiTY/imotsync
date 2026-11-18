import {
  AbstractControl,
  FormControl,
  FormGroup,
  NonNullableFormBuilder,
  ValidationErrors,
  ValidatorFn,
  Validators,
} from '@angular/forms';

import type {
  DealType,
  ErrorDetail,
  PropertyCreate,
  PropertyDetail,
  PropertyStatus,
  PropertyType,
  PropertyUpdate,
} from '../../core/api/models';

/*
 * The property form: its controls and validators, and the conversions between the form and the
 * API. The rules mirror the API's (README › Property fields) so most mistakes are caught before a
 * request; the API stays the authority and its 400 details land on the same controls.
 */

const LIMITS = {
  titleMax: 200,
  cityMax: 100,
  districtMax: 100,
  descriptionMax: 20_000,
  descriptionMaxBytes: 65_535,
  priceMax: 9_999_999_999.99,
  areaMax: 999_999.99,
  roomsMax: 255,
  floorMin: -5,
  floorMax: 200,
  totalFloorsMax: 200,
} as const;

const REF_CODE = /^[A-Za-z0-9_-]{3,32}$/;
const GENERATED_REF_CODE = /^IS-\d+$/i;
const CURRENCY = /^[A-Z]{3}$/;

type TextControl = FormControl<string>;
type NumberControl = FormControl<number | null>;

export type PropertyForm = FormGroup<{
  refCode: TextControl;
  title: TextControl;
  type: FormControl<PropertyType | null>;
  dealType: FormControl<DealType | null>;
  status: FormControl<PropertyStatus>;
  city: TextControl;
  district: TextControl;
  price: NumberControl;
  currency: TextControl;
  areaM2: NumberControl;
  rooms: NumberControl;
  floor: NumberControl;
  totalFloors: NumberControl;
  description: TextControl;
}>;

export type PropertyFormValue = ReturnType<PropertyForm['getRawValue']>;
export type PropertyField = keyof PropertyForm['controls'];

export function createPropertyForm(fb: NonNullableFormBuilder): PropertyForm {
  const form: PropertyForm = fb.group({
    refCode: fb.control('', refCode),
    title: fb.control('', maxChars(LIMITS.titleMax)),
    type: fb.control<PropertyType | null>(null, Validators.required),
    dealType: fb.control<DealType | null>(null, Validators.required),
    status: fb.control<PropertyStatus>('draft'),
    city: fb.control('', [notBlank, maxChars(LIMITS.cityMax)]),
    district: fb.control('', maxChars(LIMITS.districtMax)),
    price: fb.control<number | null>(null, decimal(0, LIMITS.priceMax)),
    currency: fb.control('EUR', currencyCode),
    areaM2: fb.control<number | null>(null, decimal(0, LIMITS.areaMax, true)),
    rooms: fb.control<number | null>(null, integer(0, LIMITS.roomsMax)),
    floor: fb.control<number | null>(null, [
      integer(LIMITS.floorMin, LIMITS.floorMax),
      floorWithinBuilding,
    ]),
    totalFloors: fb.control<number | null>(null, integer(0, LIMITS.totalFloorsMax)),
    description: fb.control('', [
      maxChars(LIMITS.descriptionMax),
      maxBytes(LIMITS.descriptionMaxBytes),
    ]),
  });
  // The floor is checked against the number of floors, so it is checked again when that changes.
  form.controls.totalFloors.valueChanges.subscribe(() =>
    form.controls.floor.updateValueAndValidity(),
  );
  return form;
}

export function formValueFromProperty(property: PropertyDetail): PropertyFormValue {
  return {
    refCode: property.refCode,
    title: property.title ?? '',
    type: property.type,
    dealType: property.dealType,
    status: property.status,
    city: property.city,
    district: property.district ?? '',
    price: property.price,
    currency: property.currency,
    areaM2: property.areaM2,
    rooms: property.rooms,
    floor: property.floor,
    totalFloors: property.totalFloors,
    description: property.description ?? '',
  };
}

/** The editable fields as the API stores them: trimmed text, empty text as null. */
function apiFields(value: PropertyFormValue) {
  return {
    title: textOrNull(value.title),
    type: value.type,
    dealType: value.dealType,
    status: value.status,
    city: value.city.trim(),
    district: textOrNull(value.district),
    price: value.price,
    currency: value.currency,
    areaM2: value.areaM2,
    rooms: value.rooms,
    floor: value.floor,
    totalFloors: value.totalFloors,
    description: textOrNull(value.description),
  };
}

/** Body of POST /api/properties. Call only with a valid form (type and dealType are set). */
export function toCreateBody(value: PropertyFormValue): PropertyCreate {
  const { type, dealType, ...fields } = apiFields(value);
  if (type === null || dealType === null) {
    throw new Error('toCreateBody needs a valid form');
  }
  const refCode = value.refCode.trim();
  return { ...(refCode ? { refCode } : {}), ...fields, type, dealType };
}

/** Body of PATCH /api/properties/{id}: only the fields that differ from `original`. */
export function toPatchBody(original: PropertyDetail, value: PropertyFormValue): PropertyUpdate {
  const patch: Record<string, unknown> = {};
  for (const [key, next] of Object.entries(apiFields(value))) {
    if (next !== original[key as keyof PropertyDetail]) {
      patch[key] = next;
    }
  }
  return patch as PropertyUpdate;
}

/**
 * Shows a 400 VALIDATION_ERROR (or a 409 about the reference code) on the matching controls.
 * Returns the details that belong to no control, for a message above the form.
 */
export function applyServerErrors(form: PropertyForm, details: readonly ErrorDetail[]): string[] {
  const unmatched: string[] = [];
  for (const detail of details) {
    const control = (form.controls as Record<string, AbstractControl | undefined>)[detail.field];
    if (control) {
      control.setErrors({ server: sentence(detail.message) });
      control.markAsTouched();
    } else {
      unmatched.push(`${detail.field}: ${detail.message}`);
    }
  }
  return unmatched;
}

/** One message for a control's first error. */
export function describeFieldError(errors: ValidationErrors): string {
  const [key, value] = Object.entries(errors)[0] ?? ['', null];
  switch (key) {
    case 'required':
    case 'blank':
      return 'Required.';
    case 'maxChars':
      return `At most ${(value as { max: number }).max} characters.`;
    case 'maxBytes':
      return `Too long: at most ${(value as { max: number }).max.toLocaleString('en')} bytes of text.`;
    case 'refCodeFormat':
      return 'Use 3 to 32 letters, digits, "-" or "_".';
    case 'currencyCode':
      return 'Use a 3-letter code such as EUR.';
    case 'generatedRefCode':
      return 'Codes like IS-00042 are assigned automatically; choose another.';
    case 'min':
      return `Must be at least ${(value as { min: number }).min}.`;
    case 'minExclusive':
      return `Must be more than ${(value as { min: number }).min}.`;
    case 'max':
      return `Must be at most ${(value as { max: number }).max}.`;
    case 'decimals':
      return 'Use at most 2 decimals.';
    case 'integer':
      return 'Must be a whole number.';
    case 'floorAboveTotal':
      return `Must not be above the number of floors (${(value as { totalFloors: number }).totalFloors}).`;
    case 'server':
      return String(value);
    default:
      return 'Check this value.';
  }
}

function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function sentence(message: string): string {
  const text = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Length in code points, the way the API (and MariaDB) count characters. */
function charCount(value: string): number {
  return [...value].length;
}

function maxChars(max: number): ValidatorFn {
  return (control) =>
    typeof control.value === 'string' && charCount(control.value) > max
      ? { maxChars: { max } }
      : null;
}

function maxBytes(max: number): ValidatorFn {
  const encoder = new TextEncoder();
  return (control) =>
    typeof control.value === 'string' && encoder.encode(control.value).length > max
      ? { maxBytes: { max } }
      : null;
}

const notBlank: ValidatorFn = (control) =>
  typeof control.value === 'string' && control.value.trim() === '' ? { blank: true } : null;

/** Optional; when given, the agency's own format, and not one of the codes the API assigns. */
const refCode: ValidatorFn = (control) => {
  const value = typeof control.value === 'string' ? control.value.trim() : '';
  if (value === '') return null;
  if (!REF_CODE.test(value)) return { refCodeFormat: true };
  return GENERATED_REF_CODE.test(value) ? { generatedRefCode: true } : null;
};

const currencyCode: ValidatorFn = (control) =>
  typeof control.value === 'string' && CURRENCY.test(control.value) ? null : { currencyCode: true };

function integer(min: number, max: number): ValidatorFn {
  return (control) => {
    const value = control.value as number | null;
    if (value === null) return null;
    if (!Number.isInteger(value)) return { integer: true };
    return range(value, min, max);
  };
}

function decimal(min: number, max: number, minExclusive = false): ValidatorFn {
  return (control) => {
    const value = control.value as number | null;
    if (value === null) return null;
    if (minExclusive && value <= min) return { minExclusive: { min } };
    const outOfRange = range(value, min, max);
    if (outOfRange) return outOfRange;
    return Math.round(value * 100) / 100 === value ? null : { decimals: true };
  };
}

function range(value: number, min: number, max: number): ValidationErrors | null {
  if (value < min) return { min: { min } };
  if (value > max) return { max: { max } };
  return null;
}

/** floor ≤ totalFloors when both are known. */
const floorWithinBuilding: ValidatorFn = (control) => {
  const floor = control.value as number | null;
  const totalFloors = (control.parent?.get('totalFloors')?.value ?? null) as number | null;
  return floor !== null && totalFloors !== null && floor > totalFloors
    ? { floorAboveTotal: { totalFloors } }
    : null;
};
