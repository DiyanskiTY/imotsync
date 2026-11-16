/**
 * Characters XML 1.0 cannot carry at all, not even escaped: C0 controls other than tab,
 * line feed and carriage return, lone UTF-16 surrogates, U+FFFE and U+FFFF. They sneak in
 * through text pasted from word processors, and a single one makes the whole feed invalid.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|\p{Cs}/gu;

/** The text without characters XML 1.0 cannot represent. */
export function xmlSafe(text: string): string {
  return text.replace(XML_ILLEGAL, '');
}

/** Single-line text: every run of whitespace (line breaks included) becomes one space. */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Cuts text to at most `max` characters (code points, so emoji are never split), at a word
 * boundary when one is close, and marks the cut with an ellipsis.
 */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  if (chars.length <= max) return { text, truncated: false };
  const head = chars.slice(0, max - 1).join('');
  const lastSpace = head.search(/\s\S*$/);
  const cut = lastSpace >= head.length * 0.8 ? head.slice(0, lastSpace) : head;
  return { text: `${cut.trimEnd()}…`, truncated: true };
}
