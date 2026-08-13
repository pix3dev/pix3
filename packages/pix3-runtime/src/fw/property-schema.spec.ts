import { describe, expect, it } from 'vitest';

import { coerceToPropertyType } from './property-schema';

/**
 * The editor's inspector always sends the type a property declares; automation does not. These
 * cases are the ones that reached a saved scene as `moveInterval: "1.5"` sitting next to real
 * numbers — and cost a measured Flow increment its entire iteration budget chasing the quotes.
 */
describe('coerceToPropertyType', () => {
  it('parses a numeric string into the number a number property expects', () => {
    expect(coerceToPropertyType('number', '1.5')).toBe(1.5);
    expect(coerceToPropertyType('number', ' 42 ')).toBe(42);
  });

  it('leaves a non-numeric string alone so validation can reject it', () => {
    expect(coerceToPropertyType('number', 'fast')).toBe('fast');
    expect(coerceToPropertyType('number', '')).toBe('');
  });

  it('reads the two boolean words, and nothing else', () => {
    expect(coerceToPropertyType('boolean', 'true')).toBe(true);
    expect(coerceToPropertyType('boolean', 'FALSE')).toBe(false);
    expect(coerceToPropertyType('boolean', 'yes')).toBe('yes');
  });

  it('stringifies scalars for a string property and passes everything else through', () => {
    expect(coerceToPropertyType('string', 45)).toBe('45');
    const vector = { x: 1, y: 2 };
    expect(coerceToPropertyType('vector2', vector)).toBe(vector);
  });
});
