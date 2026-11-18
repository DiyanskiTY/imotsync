import { summarizeBulkDelete } from './bulk-delete-summary';

describe('summarizeBulkDelete', () => {
  it('mentions each outcome once, in a fixed order', () => {
    expect(
      summarizeBulkDelete([
        { propertyId: 3, result: 'deletion_scheduled' },
        { propertyId: 1, result: 'deleted' },
        { propertyId: 2, result: 'deleted' },
        { propertyId: 4, result: 'not_found' },
      ]),
    ).toEqual({
      severity: 'success',
      detail:
        '2 deleted. 1 archived and scheduled for deletion; its page shows when. 1 already gone.',
    });
  });

  it('warns when a property could not be deleted', () => {
    expect(
      summarizeBulkDelete([
        { propertyId: 1, result: 'error', error: { code: 'INTERNAL_ERROR', message: 'x' } },
      ]),
    ).toEqual({ severity: 'warn', detail: '1 could not be deleted; try again.' });
  });
});
