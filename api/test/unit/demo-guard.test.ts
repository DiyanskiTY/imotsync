import { describe, expect, it } from 'vitest';
import { assertDemoDataAllowed } from '../../src/db/cli.js';
import { makeConfig } from './helpers.js';

const productionSecret = 'z'.repeat(32);

describe('assertDemoDataAllowed (seed and reset)', () => {
  it('allows demo data outside production', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(() => {
        assertDemoDataAllowed(makeConfig({ NODE_ENV }), 'load demo data');
      }).not.toThrow();
    }
  });

  it('refuses in production by default', () => {
    const config = makeConfig({ NODE_ENV: 'production', JWT_SECRET: productionSecret });

    expect(() => {
      assertDemoDataAllowed(config, 'load demo data');
    }).toThrow(/Refusing to load demo data with NODE_ENV=production/);
  });

  it('allows a production demo deployment with ALLOW_DEMO_SEED=true', () => {
    const config = makeConfig({
      NODE_ENV: 'production',
      JWT_SECRET: productionSecret,
      ALLOW_DEMO_SEED: 'true',
    });

    expect(() => {
      assertDemoDataAllowed(config, 'reset the database');
    }).not.toThrow();
  });
});
