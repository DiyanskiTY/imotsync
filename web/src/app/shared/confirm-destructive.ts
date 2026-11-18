import { inject } from '@angular/core';
import { ConfirmationService } from 'primeng/api';

export interface DestructiveConfirmation {
  header: string;
  message: string;
  accept: () => void;
  acceptLabel?: string;
  icon?: string;
}

/**
 * Asks before an action that removes something: a red accept button, a neutral Cancel.
 * Call it in an injection context; it returns the function to call per action.
 */
export function injectConfirmDestructive(): (confirmation: DestructiveConfirmation) => void {
  const confirmation = inject(ConfirmationService);
  return ({ acceptLabel = 'Delete', icon = 'pi pi-exclamation-triangle', ...rest }) =>
    confirmation.confirm({
      ...rest,
      icon,
      acceptLabel,
      rejectLabel: 'Cancel',
      acceptButtonProps: { severity: 'danger' },
      rejectButtonProps: { severity: 'secondary', outlined: true },
    });
}
