import { AppPreset } from './app-preset';

type TokenTree = Record<string, unknown>;

/**
 * Flattens a token tree into the dotted names the theme uses in references:
 * formField.floatLabelFocusColor becomes "form.field.float.label.focus.color".
 */
function flatten(tree: TokenTree, prefix = '', into = new Map<string, string>()) {
  for (const [key, value] of Object.entries(tree)) {
    const name = prefix + key.replace(/[A-Z]/g, (letter) => `.${letter.toLowerCase()}`);
    if (typeof value === 'string') {
      into.set(name, value);
    } else if (typeof value === 'object' && value !== null) {
      flatten(value as TokenTree, `${name}.`, into);
    }
  }
  return into;
}

const preset = AppPreset as unknown as {
  primitive: TokenTree;
  semantic: TokenTree & { colorScheme: { light: TokenTree } };
};
// Same lookup order as the theme: colour scheme first, then semantic, then primitive tokens.
const scopes = [preset.semantic.colorScheme.light, preset.semantic, preset.primitive].map((tree) =>
  flatten(tree),
);

/** Resolves a design token name such as "primary.color" to its final value. */
function token(name: string): string {
  const value = scopes.map((scope) => scope.get(name)).find((found) => found !== undefined);
  if (value === undefined) {
    throw new Error(`Unknown design token "${name}"`);
  }
  const reference = /^\{([\w.]+)\}$/.exec(value);
  return reference ? token(reference[1]) : value;
}

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(first: string, second: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((start) => {
      const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG 2 AA minimum contrast for normal-size text. */
const AA_TEXT = 4.5;

describe('AppPreset (light colour scheme)', () => {
  it('resolves the colours used below to hex values', () => {
    for (const name of ['primary.color', 'primary.contrast.color', 'surface.50']) {
      expect(token(name)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it.each(['primary.color', 'primary.hover.color', 'primary.active.color'])(
    'keeps white text readable on %s',
    (background) => {
      expect(contrast(token('primary.contrast.color'), token(background))).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    },
  );

  it.each(['surface.0', 'surface.50', 'highlight.background'])(
    'keeps primary-coloured text readable on %s',
    (background) => {
      expect(contrast(token('primary.color'), token(background))).toBeGreaterThanOrEqual(AA_TEXT);
    },
  );

  it('keeps the focused float label readable on a form field', () => {
    expect(
      contrast(token('form.field.float.label.focus.color'), token('form.field.background')),
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });
});
