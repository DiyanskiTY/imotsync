/*
 * Finds contact details in listing text. Bazar's General Terms (Art. 18) forbid contact
 * details and URLs in a listing's title and description, so the Bazar adapter blocks
 * publishing when this finds any.
 *
 * The detectors aim at what people actually type in Bulgarian listings, while leaving
 * alone the numbers a property text is full of: prices ('245 000 €', '1 050 000'), areas
 * ('98 м²', '1200 кв.м'), years and dates ('2019 г.', '01.03.2025'), floors ('4/6'), opening
 * hours ('08.00-20.00'), cadastral identifiers ('идентификатор 07079.618.86') and other
 * dotted identifiers ('07079.5012').
 *
 * Phone numbers are found in Bulgarian national and international form (0888 123 456,
 * +359 888 123 456) and, for other countries, in international form ('+44 20 7946 0958').
 */

export type ContactKind = 'phone' | 'email' | 'url';

export interface ContactMatch {
  kind: ContactKind;
  /** The matched text, as written. */
  text: string;
  /** Offset of the match in the input. */
  index: number;
}

/* ---------------------------------------------------------------- e-mail addresses */

const WORD = String.raw`[\p{L}\p{N}]`;
const LABEL = String.raw`${WORD}(?:[\p{L}\p{N}-]*${WORD})?`;

/** name@example.bg, name.surname+tag@mail.example.com, 'name @ example.bg', иван@пример.бг */
const EMAIL = new RegExp(
  String.raw`(?<![\p{L}\p{N}._%+-])${WORD}(?:[\p{L}\p{N}._%+-]*${WORD})?\s{0,2}@\s{0,2}${LABEL}(?:\.${LABEL})*\.\p{L}{2,}(?![\p{L}\p{N}])`,
  'gu',
);

/** Obfuscated forms: 'name(at)example.bg', 'name [at] example [dot] bg', 'name (маймунка) abv.bg'. */
const AT_WORD = String.raw`[(\[{]\s*(?:at|ат|маймунка|кльомба)\s*[)\]}]`;
const DOT_WORD = String.raw`(?:\.|\s*[(\[{]\s*(?:dot|точка)\s*[)\]}]\s*)`;
const OBFUSCATED_EMAIL = new RegExp(
  String.raw`(?<![\p{L}\p{N}._%+-])${WORD}(?:[\p{L}\p{N}._%+-]*${WORD})?\s{0,2}${AT_WORD}\s{0,2}${LABEL}(?:${DOT_WORD}${LABEL})*${DOT_WORD}\p{L}{2,}(?![\p{L}\p{N}])`,
  'giu',
);

/* ---------------------------------------------------------------- web addresses */

/** The rest of a URL: up to the next space, without the punctuation of the sentence around it. */
const URL_REST = String.raw`(?:[^\s<>"'«»]*[^\s<>"'«».,;:!?)\]}])?`;

/** http://..., https://..., ftp://... */
const SCHEME_URL = new RegExp(String.raw`\b(?:https?|ftp):\/\/${URL_REST}`, 'giu');

/** www.example.bg/... */
const WWW_URL = new RegExp(
  String.raw`(?<![\p{L}\p{N}@.-])www\d{0,3}\.[\p{L}\p{N}-]+${URL_REST}`,
  'giu',
);

/**
 * Top-level domains that turn 'word.tld' into a web address. A closed list, so that
 * abbreviations ('e.g.', 'кв.м', 'No.5') and decimals ('2.5') never count.
 */
const TLDS = [
  'bg',
  'com',
  'net',
  'org',
  'eu',
  'info',
  'biz',
  'io',
  'co',
  'me',
  'online',
  'site',
  'website',
  'store',
  'shop',
  'app',
  'dev',
  'pro',
  'xyz',
  'top',
  'club',
  'estate',
  'properties',
  'realty',
  'homes',
  'uk',
  'de',
  'ru',
  'ro',
  'gr',
  'tr',
  'rs',
  'mk',
  'ua',
  'nl',
  'fr',
  'es',
  'ch',
  'pl',
  'cz',
  'us',
];

/** example.bg, imoti-sofia.com/offer/12, sub.example.co.uk, пример.бг */
const BARE_DOMAIN = new RegExp(
  String.raw`(?<![\p{L}\p{N}@._%+/-])(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:${TLDS.join('|')})|(?:[\p{Script=Cyrillic}0-9](?:[\p{Script=Cyrillic}0-9-]{0,61}[\p{Script=Cyrillic}0-9])?\.)+бг)(?![\p{L}\p{N}-])(?:\/${URL_REST})?`,
  'giu',
);

/* ---------------------------------------------------------------- phone numbers */

/** 01.03.2025, 1/3/25, 01-03-2025 (real days and months): masked before looking for phones. */
const DATE = /(?<!\d)(?:0?[1-9]|[12]\d|3[01])([./-])(?:0?[1-9]|1[0-2])\1(?:\d{4}|\d{2})(?!\d)/g;

/**
 * Bulgarian cadastral identifiers: the 5-digit EKATTE code of the place, then the cadastral
 * region and the parcel, optionally the building and the unit, joined by dots, e.g.
 * 07079.618.86 (a parcel in Burgas) or 68134.4083.123.1.15 (a flat in Sofia). Masked before
 * looking for phones: '07079.618.86' has the digits of a Bulgarian phone number.
 */
const CADASTRAL_ID = /(?<!\d)(?<!\d\.)\d{5}(?:\.\d{1,4}){2,4}(?!\.?\d)/g;

/** Characters allowed between the digit groups of one phone number. */
const SEPARATOR = /^[ \t\u00A0\u202F()./+-]{1,3}$/;
/** A single thousands separator, as in '1 050 000' or '1.050.000'. */
const THOUSANDS_SEPARATOR = /^[ \u00A0\u202F.']$/;

interface DigitGroup {
  digits: string;
  start: number;
  end: number;
  /** Separator characters between the previous group of the run and this one. */
  separatorBefore: string;
}

/** Splits the text into runs of digit groups joined by phone-style separators. */
function digitRuns(text: string): DigitGroup[][] {
  const runs: DigitGroup[][] = [];
  let run: DigitGroup[] = [];
  for (const match of text.matchAll(/\d+/g)) {
    const start = match.index;
    const previous = run.at(-1);
    const separatorBefore = previous ? text.slice(previous.end, start) : '';
    if (previous && !SEPARATOR.test(separatorBefore)) {
      runs.push(run);
      run = [];
    }
    run.push({
      digits: match[0],
      start,
      end: start + match[0].length,
      separatorBefore: run.length > 0 ? separatorBefore : '',
    });
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** The '+', '(' or '(+' written right before a number, e.g. '(+359) 88 ...'. */
function prefixBefore(text: string, start: number): string {
  return /[(+][\s(+]{0,2}$/.exec(text.slice(Math.max(0, start - 3), start))?.[0] ?? '';
}

/** Whether a '+' is written right before a number: '+44', '(+44)', '+(44)'. */
function plusBefore(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - 2), start);
  return before.endsWith('+') || before.endsWith('+(');
}

/**
 * Bulgarian numbers: national form 0 + 8 or 9 digits (02 123 4567, 032 123 456,
 * 0888 123 456, 0700 12 345) or international form +359 / 00359 / 359 + 8 or 9 digits.
 */
function isBulgarianPhoneNumber(digits: string): boolean {
  let national: string;
  if (digits.startsWith('00359')) national = digits.slice(5);
  else if (digits.startsWith('359')) national = digits.slice(3);
  else if (digits.startsWith('0') && !digits.startsWith('00')) national = digits.slice(1);
  else return false;
  return (national.length === 8 || national.length === 9) && !national.startsWith('0');
}

/** Longest international number (E.164: country code and number, at most 15 digits). */
const E164_MAX_DIGITS = 15;
/** Shortest international number taken for a phone number. */
const INTERNATIONAL_MIN_DIGITS = 8;

/**
 * Numbers of any country in international form: '+' or '00', then a country code (never 0)
 * and the number, 8 to 15 digits in all, e.g. '+44 20 7946 0958', '0049 30 1234567'.
 */
function isInternationalPhoneNumber(digits: string, plusPrefixed: boolean): boolean {
  let number: string;
  if (plusPrefixed) number = digits;
  else if (digits.startsWith('00')) number = digits.slice(2);
  else return false;
  return (
    !number.startsWith('0') &&
    number.length >= INTERNATIONAL_MIN_DIGITS &&
    number.length <= E164_MAX_DIGITS
  );
}

function findPhoneNumbers(text: string): ContactMatch[] {
  const masked = text
    .replace(DATE, (date) => '#'.repeat(date.length))
    .replace(CADASTRAL_ID, (id) => '#'.repeat(id.length));
  const found: ContactMatch[] = [];

  for (const run of digitRuns(masked)) {
    let i = 0;
    while (i < run.length) {
      const first = run[i];
      if (!first) break;
      // '1 050 000 000' is one number, not a phone number starting at '050'.
      const continuesNumber =
        i > 0 && first.digits.length === 3 && THOUSANDS_SEPARATOR.test(first.separatorBefore);
      let end = -1;
      if (!continuesNumber) {
        const plus = plusBefore(masked, first.start);
        let digits = '';
        let longestGroup = 0;
        let dotted = false;
        let thousands = true;
        // Up to '00' + 15 digits.
        for (let j = i; j < run.length && digits.length < E164_MAX_DIGITS + 2; j += 1) {
          const group = run[j];
          if (!group) break;
          digits += group.digits;
          longestGroup = Math.max(longestGroup, group.digits.length);
          if (j > i && group.separatorBefore.includes('.')) dotted = true;
          if (
            j > i &&
            !(group.digits.length === 3 && THOUSANDS_SEPARATOR.test(group.separatorBefore))
          ) {
            thousands = false;
          }
          // '08.00-20.00' (opening hours) is all two-digit groups joined by dots.
          const looksLikeTimes = dotted && longestGroup <= 2;
          // '07079.5012', '12345.67.89' (identifiers): a phone number never starts with a
          // group of five or more digits that dots continue.
          const looksLikeIdentifier = dotted && first.digits.length >= 5;
          // '+12 500 000' (an amount added to a price) is grouped in thousands like a number.
          const looksLikeAmount = thousands && digits.length <= 9;
          if (looksLikeTimes || looksLikeIdentifier) continue;
          if (
            isBulgarianPhoneNumber(digits) ||
            (!looksLikeAmount && isInternationalPhoneNumber(digits, plus))
          ) {
            end = j;
          }
        }
      }
      if (end >= 0) {
        const last = run[end];
        if (!last) break;
        const start = first.start - prefixBefore(masked, first.start).length;
        found.push({ kind: 'phone', text: text.slice(start, last.end), index: start });
        i = end + 1;
      } else {
        i += 1;
      }
    }
  }
  return found;
}

/* ---------------------------------------------------------------- all together */

function collect(text: string, pattern: RegExp, kind: ContactKind, found: ContactMatch[]): string {
  return text.replace(pattern, (match: string, ...rest: unknown[]) => {
    // replace() passes the offset after the capture groups; it is the first number.
    const index = rest.find((value): value is number => typeof value === 'number') ?? 0;
    found.push({ kind, text: match, index });
    // Masked with a character that is neither a letter, a digit nor a separator, so the
    // detectors that run next neither see the match again nor join text across it.
    return '#'.repeat(match.length);
  });
}

/**
 * Every phone number, e-mail address and web address in the text, in reading order.
 * E-mail addresses are found first, then web addresses, then phone numbers, and each
 * match is hidden from the later detectors, so nothing is reported twice.
 */
export function findContactDetails(text: string): ContactMatch[] {
  const found: ContactMatch[] = [];
  let rest = text;
  rest = collect(rest, EMAIL, 'email', found);
  rest = collect(rest, OBFUSCATED_EMAIL, 'email', found);
  rest = collect(rest, SCHEME_URL, 'url', found);
  rest = collect(rest, WWW_URL, 'url', found);
  rest = collect(rest, BARE_DOMAIN, 'url', found);
  for (const phone of findPhoneNumbers(rest)) {
    found.push({ ...phone, text: text.slice(phone.index, phone.index + phone.text.length) });
  }
  return found.sort((a, b) => a.index - b.index);
}
