import { describe, expect, it } from 'vitest';
import { zExperimentCreate } from './index';

const validExperiment = () => ({
  key: 'homepage-hero-copy',
  name: 'Homepage hero copy',
  slot: 'homepage-hero',
  owner: 'growth@bigcabal.com',
  sites: ['techcabal'],
  environments: ['uat'] as const,
  allocation: 0.1,
  variants: [
    { key: 'control', weight: 50 },
    { key: 'short-copy', weight: 50 },
  ],
  targeting: [{ field: 'country', operator: 'in', value: ['NG', 'GH'] }],
  patches: [
    {
      variant: 'short-copy',
      selector: '.hero-headline',
      type: 'text' as const,
      value: 'A shorter headline',
    },
  ],
  primaryEvent: 'newsletter_signup',
  secondaryEvents: [],
  guardrailEvents: ['subscription_cancelled'],
  assignmentSalt: '0123456789abcdef0123456789abcdef',
});

describe('experiment configuration', () => {
  it('accepts a bounded provider-neutral experiment', () => {
    expect(zExperimentCreate.parse(validExperiment()).key).toBe(
      'homepage-hero-copy'
    );
  });

  it('rejects selectors that can escape the registered slot', () => {
    const input = validExperiment();
    input.patches[0]!.selector = 'body > script';
    expect(() => zExperimentCreate.parse(input)).toThrow();
  });

  it('requires unique variants including control', () => {
    const input = validExperiment();
    input.variants = [
      { key: 'variant-a', weight: 50 },
      { key: 'variant-b', weight: 50 },
    ];
    expect(() => zExperimentCreate.parse(input)).toThrow(/control/);
  });

  it('rejects patches for unknown variants', () => {
    const input = validExperiment();
    input.patches[0]!.variant = 'missing';
    expect(() => zExperimentCreate.parse(input)).toThrow(
      /Unknown patch variant/
    );
  });
});
