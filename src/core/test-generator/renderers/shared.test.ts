import { describe, it, expect } from 'vitest';
import { toPascalCase, toSnakeCase } from './shared.js';

describe('toPascalCase (identifier generation)', () => {
  it('folds underscores, hyphens, and spaces to camel boundaries', () => {
    expect(toPascalCase('create_new owner')).toBe('CreateNewOwner');
    expect(toPascalCase('find-by-id')).toBe('FindById');
  });

  it('produces a valid identifier from names with dots and punctuation (#138)', () => {
    // The bug: dots/parens leaked into JUnit method names → un-compilable Java.
    const out = toPascalCase('With-Special_Chars-And.Dots');
    expect(out).toBe('WithSpecialCharsAndDots');
    // Whatever the input, the result must be a legal Java/Go/C++ identifier body.
    for (const s of ['create owner (v2.1)', 'login & logout', 'GET /vets.html', 'a.b.c']) {
      expect(toPascalCase(s)).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
    }
  });
});

describe('toSnakeCase', () => {
  it('strips non-identifier characters', () => {
    expect(toSnakeCase('Create Owner (v2)')).toMatch(/^[a-z0-9_]+$/);
  });
});
