import { TestBed } from '@angular/core/testing';
import { NonNullableFormBuilder } from '@angular/forms';

import { propertyDetail } from '../../testing/fixtures';
import {
  applyServerErrors,
  createPropertyForm,
  describeFieldError,
  formValueFromProperty,
  PropertyForm,
  toCreateBody,
  toPatchBody,
} from './property-form';

describe('property form', () => {
  let form: PropertyForm;

  beforeEach(() => {
    form = createPropertyForm(TestBed.inject(NonNullableFormBuilder));
  });

  function errorOf(field: keyof PropertyForm['controls']): string | null {
    const control = form.controls[field];
    return control.errors ? describeFieldError(control.errors) : null;
  }

  it('starts as a valid-to-fill draft in EUR', () => {
    expect(form.getRawValue()).toMatchObject({ status: 'draft', currency: 'EUR', city: '' });
    expect(form.valid).toBe(false);
    form.patchValue({ type: 'apartment', dealType: 'sale', city: 'Sofia' });
    expect(form.valid).toBe(true);
  });

  it.each<[keyof PropertyForm['controls'], unknown, string]>([
    ['city', '   ', 'Required.'],
    ['city', 'x'.repeat(101), 'At most 100 characters.'],
    ['title', 'x'.repeat(201), 'At most 200 characters.'],
    ['refCode', 'ab', 'Use 3 to 32 letters, digits, "-" or "_".'],
    ['refCode', 'IS-00042', 'Codes like IS-00042 are assigned automatically; choose another.'],
    ['price', -1, 'Must be at least 0.'],
    ['price', 10.555, 'Use at most 2 decimals.'],
    ['areaM2', 0, 'Must be more than 0.'],
    ['rooms', 2.5, 'Must be a whole number.'],
    ['rooms', 256, 'Must be at most 255.'],
    ['floor', -6, 'Must be at least -5.'],
    ['currency', 'eur', 'Use a 3-letter code such as EUR.'],
    ['description', '😀'.repeat(16_400), 'Too long: at most 65,535 bytes of text.'],
  ])('%s = %j → %s', (field, value, message) => {
    form.controls[field].setValue(value as never);
    expect(errorOf(field)).toBe(message);
  });

  it('refuses a floor above the number of floors', () => {
    form.patchValue({ floor: 9, totalFloors: 8 });
    expect(errorOf('floor')).toBe('Must not be above the number of floors (8).');
    form.patchValue({ totalFloors: 9 });
    expect(form.controls.floor.errors).toBeNull();
  });

  it('builds the create body with nulls for empty fields and no empty refCode', () => {
    form.patchValue({
      type: 'house',
      dealType: 'rent',
      city: ' Varna ',
      title: '  ',
      price: 900,
    });
    expect(toCreateBody(form.getRawValue())).toEqual({
      type: 'house',
      dealType: 'rent',
      status: 'draft',
      city: 'Varna',
      title: null,
      district: null,
      description: null,
      price: 900,
      currency: 'EUR',
      areaM2: null,
      rooms: null,
      floor: null,
      totalFloors: null,
    });
  });

  it('sends only what changed in a patch', () => {
    const original = propertyDetail();
    form.setValue(formValueFromProperty(original));
    expect(toPatchBody(original, form.getRawValue())).toEqual({});

    form.patchValue({ price: 190000, district: '', title: original.title ?? '' });
    expect(toPatchBody(original, form.getRawValue())).toEqual({ price: 190000, district: null });
  });

  it('puts server errors on their fields and returns the rest', () => {
    const unmatched = applyServerErrors(form, [
      { field: 'price', message: 'must have at most 2 decimals' },
      { field: 'body', message: 'must contain at least one field' },
    ]);
    expect(errorOf('price')).toBe('Must have at most 2 decimals.');
    expect(form.controls.price.touched).toBe(true);
    expect(unmatched).toEqual(['body: must contain at least one field']);
  });
});
