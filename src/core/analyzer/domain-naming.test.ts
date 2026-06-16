import { describe, it, expect } from 'vitest';
import { deriveDomainFromPath, DOMAIN_NOISE_DIRS } from './domain-naming.js';

describe('deriveDomainFromPath', () => {
  it('returns the leaf business package for a Maven/Gradle Java layout', () => {
    // Regression for #138: must NOT collapse to the reverse-DNS org root.
    expect(
      deriveDomainFromPath('src/main/java/com/example/inventory'.split('/'))
    ).toBe('inventory');
    expect(
      deriveDomainFromPath('src/main/java/org/springframework/samples/petclinic/owner'.split('/'))
    ).toBe('owner');
  });

  it('does not surface the org/company root (com/org/io) as a domain', () => {
    // The bug: root-first walking grabbed "com"/"org"/"springframework".
    const domain = deriveDomainFromPath(
      'src/main/java/org/springframework/samples/petclinic/vet'.split('/')
    );
    expect(domain).toBe('vet');
    expect(domain).not.toBe('springframework');
    expect(domain).not.toBe('org');
  });

  it('skips build-layout noise (main/java/kotlin/resources)', () => {
    expect(deriveDomainFromPath('src/main/kotlin/billing'.split('/'))).toBe('billing');
    expect(deriveDomainFromPath('src/main/resources/db'.split('/'))).toBe('db');
  });

  it('skips Go build-layout noise (pkg/internal/cmd)', () => {
    expect(deriveDomainFromPath('pkg/internal/scheduler'.split('/'))).toBe('scheduler');
  });

  it('applies canonical role names for well-known directories', () => {
    expect(deriveDomainFromPath('src/services'.split('/'))).toBe('services');
    expect(deriveDomainFromPath('src/main/java/com/acme/model'.split('/'))).toBe('domain');
    expect(deriveDomainFromPath('app/utils'.split('/'))).toBe('utilities');
  });

  it('returns null when the path is nothing but noise', () => {
    expect(deriveDomainFromPath('src/main/java/com'.split('/'))).toBeNull();
    expect(deriveDomainFromPath([])).toBeNull();
    expect(deriveDomainFromPath(['(root)'])).toBeNull();
  });

  it('ignores dotfile directory segments', () => {
    expect(deriveDomainFromPath('.github/workflows'.split('/'))).toBe('workflows');
  });

  it('exposes the reverse-DNS package roots as noise', () => {
    for (const d of ['com', 'org', 'io', 'net', 'main', 'java', 'src']) {
      expect(DOMAIN_NOISE_DIRS.has(d)).toBe(true);
    }
  });
});
