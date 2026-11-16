/*
 * Place-name matching between what a broker types ("Sofia", "Mladost 1", "Лозенец") and the
 * Cyrillic names in Realistimo's geo list. Latin input is compared through the Bulgarian
 * Streamlined System, the official transliteration (Transliteration Act, 2009).
 */

const LETTERS: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sht',
  ъ: 'a',
  ь: 'y',
  ю: 'yu',
  я: 'ya',
};

const LETTER = /\p{L}/u;

/**
 * Bulgarian Cyrillic to Latin with the Streamlined System, keeping capitalisation
 * ("Шумен" -> "Shumen"). The one special rule: "ия" at the end of a word is "ia"
 * ("София" -> "Sofia"). Characters outside the Bulgarian alphabet are kept as they are.
 */
export function transliterateBulgarian(text: string): string {
  const chars = [...text.normalize('NFC')];
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] ?? '';
    const lower = char.toLowerCase();
    const next = chars[i + 1] ?? '';
    const afterNext = chars[i + 2] ?? '';
    if (lower === 'и' && next.toLowerCase() === 'я' && !LETTER.test(afterNext)) {
      out += (char === lower ? 'i' : 'I') + (next === next.toLowerCase() ? 'a' : 'A');
      i += 1;
      continue;
    }
    const latin = LETTERS[lower];
    if (latin === undefined) {
      out += char;
    } else if (char === lower) {
      out += latin;
    } else {
      out += latin.charAt(0).toUpperCase() + latin.slice(1);
    }
  }
  return out;
}

/**
 * Prefixes that name the kind of place rather than the place: ж.к. (housing estate),
 * к.к. (resort), в.з. (villa zone), кв. (quarter), м-ст (locality), гр. (town), с. (village).
 * They are matched after transliteration and must be followed by a dot or a space.
 */
const PLACE_PREFIX = /^(?:(?:zh\.?\s?k|k\.?\s?k|v\.?\s?z|kv|m-st|zhg|gr)(?:\.\s*|\s+)|s\.\s*)/;

function compact(latin: string): string {
  return (
    latin
      // Drop accents from Latin input ("Plóvdiv"); Cyrillic is already transliterated here.
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      // Case-, space-, hyphen- and punctuation-insensitive.
      .replace(/[^a-z0-9]+/g, '')
      // "Chayka" and "Chaika", "Sofiya" and "Sofia" compare equal.
      .replace(/y/g, 'i')
      .replace(/i{2,}/g, 'i')
  );
}

export interface PlaceKeys {
  /** The whole name, normalised. */
  exact: string;
  /** The name without a leading kind-of-place prefix (кв., ж.к., к.к., ...). */
  loose: string;
}

/** Comparison keys for a place name in Cyrillic or Latin script. */
export function placeKeys(name: string): PlaceKeys {
  const latin = transliterateBulgarian(name.trim()).toLowerCase();
  return { exact: compact(latin), loose: compact(latin.replace(PLACE_PREFIX, '')) };
}
