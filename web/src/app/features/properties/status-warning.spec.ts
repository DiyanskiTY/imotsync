import type { PortalListing } from '../../core/api/models';
import { propertyDetail } from '../../testing/fixtures';
import { statusWarning } from './status-warning';

const names = (key: string) =>
  ({ realistimo: 'Realistimo', bazar: 'Bazar.bg', demo: 'Demo portal' })[key] ?? key;

function listing(overrides: Partial<PortalListing>): PortalListing {
  return { ...propertyDetail().portals[0], ...overrides };
}

const published = listing({ portal: 'realistimo', status: 'published' });
const pending = listing({ portal: 'bazar', status: 'pending' });

describe('statusWarning', () => {
  it('says nothing for Active, or when nothing is online', () => {
    expect(statusWarning('active', [published], names)).toBeNull();
    expect(statusWarning('draft', [], names)).toBeNull();
    expect(statusWarning('archived', [listing({ status: 'removed' })], names)).toBeNull();
    expect(statusWarning('draft', [listing({ status: 'draft' })], names)).toBeNull();
  });

  it('warns that Draft leaves the property online', () => {
    expect(statusWarning('draft', [published, pending], names)).toBe(
      'Still online on Realistimo and Bazar.bg: Draft is only your own label. To take it down, use "Remove from portal" in the Portals panel.',
    );
  });

  it('warns that Archived leaves the property online and blocks updates', () => {
    expect(statusWarning('archived', [published], names)).toBe(
      'Still online on Realistimo: archiving does not remove it there, and changes to an archived property are not sent. Use Delete to take it off every portal first, or "Remove from portal" in the Portals panel.',
    );
  });

  it('counts a listing in error as online when it was published before', () => {
    const failedUpdate = listing({ status: 'error', publishedAt: '2026-11-11T09:00:00Z' });
    const failedFirstPublish = listing({ portal: 'demo', status: 'error', publishedAt: null });
    expect(statusWarning('draft', [failedUpdate], names)).toContain('Still online on Realistimo');
    expect(statusWarning('draft', [failedFirstPublish], names)).toBeNull();
  });
});
