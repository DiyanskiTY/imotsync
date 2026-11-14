import { body, query, type ValidationChain } from 'express-validator';
import {
  DEAL_TYPES,
  PORTAL_LISTING_STATUSES,
  PORTALS,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
  type DealType,
  type Portal,
  type PortalListingStatus,
  type PropertyStatus,
  type PropertyType,
} from '../../db/types.js';
import { SORT_VALUES } from './list-query.js';

/*
 * Field rules for properties. They mirror the columns (VARCHAR lengths, DECIMAL(12,2),
 * DECIMAL(8,2), TINYINT UNSIGNED, ...), so nothing that passes can fail in the database.
 */

export const FIELD_LIMITS = {
  refCodePattern: /^[A-Za-z0-9_-]{3,32}$/,
  titleMax: 200,
  cityMax: 100,
  districtMax: 100,
  descriptionMax: 20_000,
  /** The TEXT column holds 65,535 bytes; 20,000 four-byte characters would not fit. */
  descriptionMaxBytes: 65_535,
  priceMax: 9_999_999_999.99,
  areaMax: 999_999.99,
  roomsMax: 255,
  floorMin: -5,
  floorMax: 200,
  totalFloorsMax: 200,
  currencyPattern: /^[A-Z]{3}$/,
  searchMax: 100,
  pageMax: 1_000_000,
  pageSizeMax: 100,
} as const;

/**
 * Codes the server assigns ("IS-" + zero-padded id). Reserved for that, in any letter
 * case (the unique index is case-insensitive), so a chosen code can never take the code
 * a later property needs.
 */
export const GENERATED_REF_CODE = /^IS-\d+$/i;

export const generatedRefCode = (id: number) => `IS-${String(id).padStart(5, '0')}`;

type Mode = 'create' | 'update';

const isString = (value: unknown): value is string => typeof value === 'string';
const notNull = (value: unknown) => value !== null;
const trim = (value: unknown) => (isString(value) ? value.trim() : value);
const emptyToNull = (value: unknown) => (value === '' ? null : value);
/** Length in code points, the way MariaDB counts utf8mb4 characters. */
const charCount = (value: string) => [...value].length;

const oneOf = (values: readonly string[]) => (value: unknown) =>
  isString(value) && values.includes(value);

const integerIn = (min: number, max: number) => (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** A JSON number in range with at most two decimals (12.5 and 12.50 are fine, 12.505 is not). */
const decimalIn =
  (min: number, max: number, { minExclusive = false } = {}) =>
  (value: unknown) =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (minExclusive ? value > min : value >= min) &&
    value <= max &&
    /^\d+(\.\d{1,2})?$/.test(String(value));

/** Starts a chain: required when creating, optional when updating. */
function field(name: string, mode: Mode, requiredOnCreate: boolean): ValidationChain {
  return mode === 'create' && requiredOnCreate
    ? body(name).exists().withMessage('is required').bail()
    : body(name).optional();
}

/** A field that must be one of a fixed list and cannot be null. */
function enumField(name: string, values: readonly string[], mode: Mode, required: boolean) {
  return field(name, mode, required)
    .custom(notNull)
    .withMessage('must not be null')
    .bail()
    .custom(oneOf(values))
    .withMessage(`must be one of: ${values.join(', ')}`);
}

/** Text that cannot be null or empty (trimmed). */
function requiredText(name: string, max: number, mode: Mode) {
  return field(name, mode, true)
    .custom(isString)
    .withMessage('must be a string')
    .bail()
    .customSanitizer(trim)
    .custom((value: string) => value.length > 0)
    .withMessage('must not be empty')
    .bail()
    .custom((value: string) => charCount(value) <= max)
    .withMessage(`must be at most ${max} characters`);
}

/** Optional text; trimmed, and "" or null stores NULL. */
function nullableText(name: string, max: number) {
  return body(name)
    .optional()
    .customSanitizer(trim)
    .customSanitizer(emptyToNull)
    .if(notNull)
    .custom(isString)
    .withMessage('must be a string or null')
    .bail()
    .custom((value: string) => charCount(value) <= max)
    .withMessage(`must be at most ${max} characters`);
}

function nullableNumber(name: string, check: (value: unknown) => boolean, message: string) {
  return body(name).optional().if(notNull).custom(check).withMessage(message);
}

function propertyValidators(mode: Mode): ValidationChain[] {
  const L = FIELD_LIMITS;

  const refCode =
    mode === 'create'
      ? body('refCode')
          .optional()
          .customSanitizer(trim)
          .customSanitizer(emptyToNull)
          .if(notNull)
          .custom(isString)
          .withMessage('must be a string')
          .bail()
          .custom((value: string) => L.refCodePattern.test(value))
          .withMessage('must be 3 to 32 characters: letters, digits, "-" or "_"')
          .bail()
          .custom((value: string) => !GENERATED_REF_CODE.test(value))
          .withMessage('IS-<number> codes are reserved for codes the server assigns')
      : body('refCode')
          .optional()
          .custom(() => false)
          .withMessage('cannot be changed after the property is created');

  return [
    refCode,
    enumField('type', PROPERTY_TYPES, mode, true),
    enumField('dealType', DEAL_TYPES, mode, true),
    requiredText('city', L.cityMax, mode),
    nullableText('title', L.titleMax),
    nullableText('district', L.districtMax),
    nullableText('description', L.descriptionMax)
      .custom((value: string) => Buffer.byteLength(value, 'utf8') <= L.descriptionMaxBytes)
      .withMessage(`must be at most ${L.descriptionMaxBytes} bytes in UTF-8`),
    nullableNumber(
      'price',
      decimalIn(0, L.priceMax),
      `must be a number from 0 to ${L.priceMax} with at most 2 decimals`,
    ),
    field('currency', mode, false)
      .custom(isString)
      .withMessage('must be a string')
      .bail()
      .customSanitizer(trim)
      .custom((value: string) => L.currencyPattern.test(value))
      .withMessage('must be an ISO 4217 code of three upper-case letters, e.g. EUR'),
    nullableNumber(
      'areaM2',
      decimalIn(0, L.areaMax, { minExclusive: true }),
      `must be a number greater than 0 and at most ${L.areaMax}, with at most 2 decimals`,
    ),
    nullableNumber('rooms', integerIn(0, L.roomsMax), `must be an integer from 0 to ${L.roomsMax}`),
    nullableNumber(
      'floor',
      integerIn(L.floorMin, L.floorMax),
      `must be an integer from ${L.floorMin} to ${L.floorMax}`,
    )
      .bail()
      .custom((floor: number, { req }) => {
        const totalFloors = (req.body as Record<string, unknown> | undefined)?.totalFloors;
        return !(typeof totalFloors === 'number' && floor > totalFloors);
      })
      .withMessage('must not be greater than totalFloors'),
    nullableNumber(
      'totalFloors',
      integerIn(0, L.totalFloorsMax),
      `must be an integer from 0 to ${L.totalFloorsMax}`,
    ),
    enumField('status', PROPERTY_STATUSES, mode, false),
  ];
}

export const createPropertyValidators = propertyValidators('create');
export const updatePropertyValidators = propertyValidators('update');

/* ---- GET /properties query parameters ---- */

/** A query parameter given once (Express turns ?a=1&a=2 into an array). */
const singleValue = (value: unknown) => isString(value);

/** "active,draft" (or ?status=active&status=draft) -> ["active", "draft"]. */
function listParam(name: string, values: readonly string[]) {
  return query(name)
    .optional()
    .customSanitizer((value: unknown) => (Array.isArray(value) ? value.join(',') : value))
    .custom(isString)
    .withMessage('must be a comma-separated list')
    .bail()
    .customSanitizer((value: string) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    )
    .custom((items: string[]) => items.every((item) => values.includes(item)))
    .withMessage(`must be a comma-separated list of: ${values.join(', ')}`);
}

const PRICE_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;

function priceParam(name: string) {
  return query(name)
    .optional()
    .custom((value: unknown) => isString(value) && PRICE_PATTERN.test(value.trim()))
    .withMessage('must be a number of at least 0 with at most 2 decimals')
    .bail()
    .customSanitizer((value: string) => Number(value.trim()));
}

export const listPropertiesValidators: ValidationChain[] = [
  query('page')
    .optional()
    .custom(
      (value: unknown) =>
        isString(value) &&
        /^\d{1,7}$/.test(value) &&
        Number(value) >= 1 &&
        Number(value) <= FIELD_LIMITS.pageMax,
    )
    .withMessage(`must be an integer from 1 to ${FIELD_LIMITS.pageMax}`)
    .bail()
    .toInt(),
  query('pageSize')
    .optional()
    .custom(
      (value: unknown) =>
        isString(value) &&
        /^\d{1,3}$/.test(value) &&
        Number(value) >= 1 &&
        Number(value) <= FIELD_LIMITS.pageSizeMax,
    )
    .withMessage(`must be an integer from 1 to ${FIELD_LIMITS.pageSizeMax}`)
    .bail()
    .toInt(),
  query('q')
    .optional()
    .custom(singleValue)
    .withMessage('must be given once')
    .bail()
    .customSanitizer(trim)
    .custom((value: string) => charCount(value) <= FIELD_LIMITS.searchMax)
    .withMessage(`must be at most ${FIELD_LIMITS.searchMax} characters`),
  listParam('status', PROPERTY_STATUSES),
  listParam('type', PROPERTY_TYPES),
  listParam('dealType', DEAL_TYPES),
  query('city')
    .optional()
    .custom(singleValue)
    .withMessage('must be given once')
    .bail()
    .customSanitizer(trim)
    .custom((value: string) => charCount(value) <= FIELD_LIMITS.cityMax)
    .withMessage(`must be at most ${FIELD_LIMITS.cityMax} characters`),
  priceParam('priceMin'),
  priceParam('priceMax')
    .bail()
    .custom((priceMax: number, { req }) => {
      const raw = (req.query as Record<string, unknown> | undefined)?.priceMin;
      return !(isString(raw) && PRICE_PATTERN.test(raw.trim()) && Number(raw.trim()) > priceMax);
    })
    .withMessage('must not be less than priceMin'),
  query('portal')
    .optional()
    .custom(oneOf(PORTALS))
    .withMessage(`must be one of: ${PORTALS.join(', ')}`),
  listParam('portalStatus', PORTAL_LISTING_STATUSES),
  query('sort')
    .optional()
    .custom(oneOf(SORT_VALUES))
    .withMessage(`must be one of: ${SORT_VALUES.join(', ')}`),
];

/** GET /properties query after validation (all optional; the service applies defaults). */
export interface ListPropertiesQuery {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: PropertyStatus[];
  type?: PropertyType[];
  dealType?: DealType[];
  city?: string;
  priceMin?: number;
  priceMax?: number;
  portal?: Portal;
  portalStatus?: PortalListingStatus[];
  sort?: string;
}
