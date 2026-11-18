import {
  DEAL_TYPES,
  LISTING_STATUSES,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
  type DealType,
  type PropertyType,
} from '../../core/api/models';
import { statusLabel } from '../../shared/status-tag';

export const TYPE_LABELS: Readonly<Record<PropertyType, string>> = {
  apartment: 'Apartment',
  house: 'House',
  office: 'Office',
  shop: 'Shop',
  land: 'Land',
  garage: 'Garage',
  other: 'Other',
};

export const DEAL_LABELS: Readonly<Record<DealType, string>> = {
  sale: 'For sale',
  rent: 'For rent',
};

export interface Option<T extends string> {
  label: string;
  value: T;
}

export const TYPE_OPTIONS = PROPERTY_TYPES.map((value) => ({ value, label: TYPE_LABELS[value] }));
export const DEAL_OPTIONS = DEAL_TYPES.map((value) => ({ value, label: DEAL_LABELS[value] }));
export const STATUS_OPTIONS = PROPERTY_STATUSES.map((value) => ({
  value,
  label: statusLabel(value),
}));
export const LISTING_STATUS_OPTIONS = LISTING_STATUSES.map((value) => ({
  value,
  label: statusLabel(value),
}));
