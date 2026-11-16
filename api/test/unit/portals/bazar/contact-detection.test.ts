import { describe, expect, it } from 'vitest';
import { findContactDetails } from '../../../../src/portals/bazar/contact-detection.js';

const found = (text: string) => findContactDetails(text).map(({ kind, text }) => [kind, text]);

describe('findContactDetails: phone numbers', () => {
  it.each([
    ['mobile in groups', 'Обадете се на 0888 123 456 за оглед.', '0888 123 456'],
    ['mobile without spaces', 'тел.0888123456', '0888123456'],
    ['mobile with hyphens', 'GSM 0888-123-456', '0888-123-456'],
    ['mobile with a slash', 'GSM: 0899/123-456', '0899/123-456'],
    ['mobile in 3-3-4 groups', 'Viber 088 812 3456', '088 812 3456'],
    ['mobile with a separated leading zero', 'тел. 0 888 123 456', '0 888 123 456'],
    ['international with +', 'Tel. +359 88 812 3456', '+359 88 812 3456'],
    ['international without spaces', '+359888123456', '+359888123456'],
    ['international with 00', '00359 888 123 456', '00359 888 123 456'],
    ['international in brackets', '(+359) 88 812 3456', '(+359) 88 812 3456'],
    ['international Sofia landline', '+359 2 123 4567', '+359 2 123 4567'],
    ['Sofia landline with a slash', 'офис 02/123 4567', '02/123 4567'],
    ['Sofia landline with spaces', '02 123 4567', '02 123 4567'],
    ['Sofia landline with the code in brackets', '(02) 123 45 67', '(02) 123 45 67'],
    ['Plovdiv landline', '032 123 456', '032 123 456'],
    ['Plovdiv landline in pairs', '032/62 34 56', '032/62 34 56'],
    ['non-geographic number', '0700 12 345', '0700 12 345'],
    ['a number right after a price', 'Цена 245 000 0888 123 456', '0888 123 456'],
  ])('finds a %s', (_name, text, phone) => {
    expect(found(text)).toEqual([['phone', phone]]);
  });

  it.each([
    ['a price', 'Цена: 245 000 EUR'],
    ['a price without spaces', 'Цена: 245000 €'],
    ['a price in millions', 'Цена 1 200 000 лв.'],
    ['a price with a zero group', 'Цена 1 050 000 €'],
    ['a price in billions', 'Оценка 1 050 000 000 €'],
    ['a decimal price', '1 250.50 евро'],
    ['an area', '98 м², 98,5 кв.м, двор 1200 кв.м'],
    ['a year', 'построена през 2019 г.'],
    ['a range of years', 'строена 1990-2005'],
    ['a floor', 'етаж 4/6'],
    ['a distance', 'на 400 м от лифта, 2.5 км до центъра, 0.5 дка'],
    ['a date', 'свободен от 01.03.2025'],
    ['a period between dates', 'от 01.03.2025 до 05.10.2025 г.'],
    ['opening hours with dots', 'Работно време 08.00 - 20.00 ч.'],
    ['several opening hours', '08.00-12.00, 13.00-17.00 и 09.00'],
    ['opening hours with colons', '08:00-20:00'],
    ['a reference code', 'Реф. № IS-00001/2025'],
    ['a cadastral identifier', 'идентификатор 68134.905.1234'],
    ['an address', 'ул. Витоша 12, бл. 104, вх. Б, ап. 12'],
    ['a fee', 'Таксата за поддръжка е 12 евро на кв.м годишно.'],
  ])('ignores %s', (_name, text) => {
    expect(found(text)).toEqual([]);
  });

  it.each([
    // EKATTE codes that start with 0: their digits look like a Bulgarian phone number.
    ['a parcel in Burgas', 'Поземлен имот с идентификатор 07079.618.86 в гр. Бургас'],
    ['a flat in Burgas', 'Самостоятелен обект 07079.618.86.1.15.'],
    ['a plot in Bansko', 'УПИ с идентификатор 02676.12.345, гр. Банско'],
    ['a parcel in Bansko with a long number', 'ПИ 02676.501.1234'],
    ['a parcel in Blagoevgrad', 'ПИ 04279.613.25'],
    ['a flat in Sofia', 'идентификатор 68134.4083.123.1.15'],
    ['a cadastral region', 'кадастрален район 07079.5012'],
    ['another dotted identifier', 'Партида 01234.567.89 в регистъра'],
  ])('ignores %s', (_name, text) => {
    expect(found(text)).toEqual([]);
  });

  it.each([
    ['a UK number with +', 'Contact +44 20 7946 0958', '+44 20 7946 0958'],
    ['a German number with 00', 'Звънете на 0049 30 1234567', '0049 30 1234567'],
    ['a US number with brackets and a hyphen', 'Tel: +1 (555) 123-4567', '+1 (555) 123-4567'],
    ['a Polish number in groups', 'тел. +48 123 456 789', '+48 123 456 789'],
    ['a Greek number written together', '+302101234567', '+302101234567'],
    ['a Romanian number with hyphens', '+40-21-123-4567', '+40-21-123-4567'],
  ])('finds %s', (_name, text, phone) => {
    expect(found(text)).toEqual([['phone', phone]]);
  });

  it('still finds a phone number next to a cadastral identifier', () => {
    expect(found('ПИ 07079.618.86, тел. 0888 123 456')).toEqual([['phone', '0888 123 456']]);
  });

  it.each([
    ['an amount added to a price', 'Цена 120 000 € + 12 500 € ДДС'],
    ['a price with a plus sign', 'Цена +12 500 000 евро'],
  ])('ignores %s', (_name, text) => {
    expect(found(text)).toEqual([]);
  });
});

describe('findContactDetails: e-mail addresses', () => {
  it.each([
    ['a plain address', 'Пишете на office@agency.bg.', 'office@agency.bg'],
    [
      'dots, plus and subdomains',
      'ivan.petrov+imoti@mail.example.com',
      'ivan.petrov+imoti@mail.example.com',
    ],
    ['spaces around @', 'office @ agency.bg', 'office @ agency.bg'],
    ['(at)', 'office(at)agency.bg', 'office(at)agency.bg'],
    ['[at] and [dot]', 'office [at] agency [dot] bg', 'office [at] agency [dot] bg'],
    ['a Cyrillic word for @', 'office (маймунка) abv.bg', 'office (маймунка) abv.bg'],
    ['a Cyrillic address', 'иван@пример.бг', 'иван@пример.бг'],
  ])('finds %s', (_name, text, email) => {
    expect(found(text)).toEqual([['email', email]]);
  });

  it('does not report the domain of an e-mail address as a web address too', () => {
    expect(found('office@imoti-sofia.com')).toEqual([['email', 'office@imoti-sofia.com']]);
  });

  it('ignores a lone @ and handles', () => {
    expect(found('Цена @ запитване, @agency')).toEqual([]);
  });
});

describe('findContactDetails: web addresses', () => {
  it.each([
    [
      'an https URL',
      'Вижте https://agency.example/listing/12 за снимки',
      'https://agency.example/listing/12',
    ],
    ['an http URL', 'http://x.bg', 'http://x.bg'],
    ['a www address', 'www.agency.bg', 'www.agency.bg'],
    ['a bare .bg domain', 'Още обяви на agency.bg', 'agency.bg'],
    ['a bare .com domain with a hyphen', 'Imoti-Sofia.com', 'Imoti-Sofia.com'],
    ['a domain with a path', 'facebook.com/agency', 'facebook.com/agency'],
    ['an upper-case domain', 'Вижте на IMOTI.BG!', 'IMOTI.BG'],
    ['a Cyrillic domain', 'пример.бг', 'пример.бг'],
    ['a URL at the end of a sentence', 'Снимки: www.agency.bg/12.', 'www.agency.bg/12'],
    ['a URL in brackets', '(https://agency.example/x?a=1)', 'https://agency.example/x?a=1'],
    ['a domain before a comma', 'agency.bg/offers, тел.', 'agency.bg/offers'],
  ])('finds %s', (_name, text, url) => {
    expect(found(text)).toEqual([['url', url]]);
  });

  it('does not report the digits of a URL as a phone number', () => {
    expect(found('https://agency.example/offers/0888123456')).toEqual([
      ['url', 'https://agency.example/offers/0888123456'],
    ]);
  });

  it.each([
    ['abbreviations', 'e.g. т.е. т.нар. ж.к.Младост, Ap.12, No.5'],
    ['units with dots', 'дворно място 600 кв.м.'],
    ['words joined by a dot', 'Smart TV, Wi-Fi.Real estate'],
    ['decimals', '2.5 km, 3.75'],
  ])('ignores %s', (_name, text) => {
    expect(found(text)).toEqual([]);
  });
});

describe('findContactDetails: several matches', () => {
  it('lists every contact detail in reading order', () => {
    const text =
      'Агенция: www.agency.bg, office@agency.bg или 0888 123 456. Офис: 02/987 6543 (agency.bg).';
    expect(findContactDetails(text)).toEqual([
      { kind: 'url', text: 'www.agency.bg', index: 9 },
      { kind: 'email', text: 'office@agency.bg', index: 24 },
      { kind: 'phone', text: '0888 123 456', index: 45 },
      { kind: 'phone', text: '02/987 6543', index: 65 },
      { kind: 'url', text: 'agency.bg', index: 78 },
    ]);
  });

  it('finds nothing in an ordinary Bulgarian listing text', () => {
    const text =
      'Светъл тристаен апартамент на 4/6 етаж, 98 кв.м, в нова сграда (2019 г.) с асансьор. ' +
      'Цена 245 000 € без ДДС. Свободен от 01.03.2027. Оглед всеки ден 09.00 - 18.00 ч.';
    expect(findContactDetails(text)).toEqual([]);
  });

  it('stays fast on long, unusual input', () => {
    const inputs = [
      'a'.repeat(20_000),
      'a.'.repeat(10_000),
      '0 '.repeat(10_000),
      'ж.'.repeat(10_000),
      'x [at] y [dot] '.repeat(1_300),
    ];
    const started = performance.now();
    for (const input of inputs) findContactDetails(input);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
