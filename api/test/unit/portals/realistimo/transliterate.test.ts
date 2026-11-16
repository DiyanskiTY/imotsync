import { describe, expect, it } from 'vitest';
import {
  placeKeys,
  transliterateBulgarian,
} from '../../../../src/portals/realistimo/transliterate.js';

describe('transliterateBulgarian (Streamlined System)', () => {
  it.each([
    ['Лозенец', 'Lozenets'],
    ['Младост-1', 'Mladost-1'],
    ['Пловдив', 'Plovdiv'],
    ['Бургас', 'Burgas'],
    ['Чайка', 'Chayka'],
    ['Щъркелово гнездо', 'Shtarkelovo gnezdo'],
    ['Люлин', 'Lyulin'],
    ['Юнак', 'Yunak'],
    ['Жеравна', 'Zheravna'],
    ['Хисаря', 'Hisarya'],
    ['Велико Търново', 'Veliko Tarnovo'],
    ['Шумен', 'Shumen'],
  ])('%s -> %s', (cyrillic, latin) => {
    expect(transliterateBulgarian(cyrillic)).toBe(latin);
  });

  it('writes a word-final "ия" as "ia" and keeps it inside words', () => {
    expect(transliterateBulgarian('София')).toBe('Sofia');
    expect(transliterateBulgarian('СОФИЯ')).toBe('SOFIA');
    expect(transliterateBulgarian('Илиянци')).toBe('Iliyantsi');
    expect(transliterateBulgarian('България е')).toBe('Balgaria e');
  });

  it('keeps Latin text, digits and punctuation', () => {
    expect(transliterateBulgarian('Mladost 1 (east)')).toBe('Mladost 1 (east)');
    expect(transliterateBulgarian('к.к. Чайка')).toBe('k.k. Chayka');
  });
});

describe('placeKeys', () => {
  const same = (a: string, b: string) => expect(placeKeys(a).exact).toBe(placeKeys(b).exact);

  it('compares Cyrillic with its Latin transliteration', () => {
    same('Лозенец', 'Lozenets');
    same('Меден Рудник', 'Meden Rudnik');
    same('Велико Търново', 'veliko tarnovo');
  });

  it('ignores case, spaces, hyphens and dots', () => {
    same('Младост-1', 'Mladost 1');
    same('Младост-1', 'MLADOST1');
    same('Meden Rudnik', 'meden-rudnik');
    same('Gorna Oryahovitsa', 'Gorna-Oryahovitsa');
  });

  it('treats y and i alike', () => {
    same('Чайка', 'Chaika');
    same('София', 'Sofiya');
    same('София', 'SOFIA');
  });

  it('drops accents from Latin input', () => {
    same('Пловдив', 'Plóvdiv');
  });

  it('strips a kind-of-place prefix only in the loose key', () => {
    expect(placeKeys('к.к. Чайка')).toEqual({ exact: 'kkchaika', loose: 'chaika' });
    expect(placeKeys('ж.к. Младост 1').loose).toBe(placeKeys('Mladost 1').exact);
    expect(placeKeys('kv. Lozenets').loose).toBe('lozenets');
    expect(placeKeys('гр. София').loose).toBe('sofia');
    expect(placeKeys('с. Лозен').loose).toBe('lozen');
    // A name that merely starts with the same letters keeps them.
    expect(placeKeys('Кварталът').loose).toBe(placeKeys('Кварталът').exact);
  });

  it('gives empty keys for empty input', () => {
    expect(placeKeys('   ')).toEqual({ exact: '', loose: '' });
  });
});
