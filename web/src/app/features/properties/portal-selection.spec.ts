import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { PortalChoice, portalSelection } from './portal-selection';

describe('portalSelection', () => {
  const choices = signal<PortalChoice[]>([
    { key: 'realistimo', chosenByDefault: false },
    { key: 'bazar', chosenByDefault: true },
    { key: 'alo', chosenByDefault: true },
  ]);

  function create() {
    return TestBed.runInInjectionContext(() => portalSelection(choices));
  }

  it('starts from each portal default and reports a partial choice', () => {
    const selection = create();
    expect(selection.chosen()).toEqual(['bazar', 'alo']);
    expect(selection.allChosen()).toBe(false);
    expect(selection.someChosen()).toBe(true);
  });

  it('chooses every portal, and none', () => {
    const selection = create();
    selection.setAll(true);
    expect(selection.chosen()).toEqual(['realistimo', 'bazar', 'alo']);
    expect(selection.allChosen()).toBe(true);
    expect(selection.someChosen()).toBe(false);

    selection.setAll(false);
    expect(selection.chosen()).toEqual([]);
    expect(selection.allChosen()).toBe(false);
    expect(selection.someChosen()).toBe(false);
  });

  it('keeps single choices after choosing all', () => {
    const selection = create();
    selection.setAll(true);
    selection.toggle('bazar', false);
    expect(selection.chosen()).toEqual(['realistimo', 'alo']);
    expect(selection.someChosen()).toBe(true);
  });

  it('is never "all chosen" without portals', () => {
    const selection = TestBed.runInInjectionContext(() => portalSelection(signal([])));
    expect(selection.allChosen()).toBe(false);
  });
});
