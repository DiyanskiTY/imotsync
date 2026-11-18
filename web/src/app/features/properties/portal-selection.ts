import { computed, signal, Signal } from '@angular/core';

export interface PortalChoice {
  key: string;
  /** Ticked until the user decides otherwise. */
  chosenByDefault: boolean;
}

/**
 * Which portals to publish to: each available portal starts ticked or not, and the user's ticks
 * and unticks are kept as overrides. It stores the user's decisions, not a copy of the list, so
 * a reload of the available portals (polling) never undoes them.
 */
export function portalSelection(available: Signal<readonly PortalChoice[]>) {
  const overrides = signal<ReadonlyMap<string, boolean>>(new Map());
  const chosen = computed(() =>
    available()
      .filter((choice) => overrides().get(choice.key) ?? choice.chosenByDefault)
      .map((choice) => choice.key),
  );
  const allChosen = computed(
    () => available().length > 0 && chosen().length === available().length,
  );
  return {
    chosen,
    /** Every available portal is ticked. */
    allChosen,
    /** Some, but not all, are ticked (the "all" checkbox shows a dash). */
    someChosen: computed(() => chosen().length > 0 && !allChosen()),
    isChosen: (key: string): boolean => chosen().includes(key),
    toggle: (key: string, checked: boolean): void =>
      overrides.update((current) => new Map(current).set(key, checked)),
    /** Ticks or unticks every available portal. */
    setAll: (checked: boolean): void =>
      overrides.update((current) => {
        const next = new Map(current);
        for (const choice of available()) {
          next.set(choice.key, checked);
        }
        return next;
      }),
  };
}
