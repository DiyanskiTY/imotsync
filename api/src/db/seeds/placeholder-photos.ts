import sharp from 'sharp';

export const PHOTO_WIDTH = 1600;
export const PHOTO_HEIGHT = 1067;

export interface PlaceholderPhotoOptions {
  filePath: string;
  refCode: string;
  photoNumber: number;
  photoCount: number;
  /** Background hue (0-360), so each demo property gets its own colour. */
  hue: number;
}

export interface PlaceholderPhoto {
  width: number;
  height: number;
  sizeBytes: number;
}

/** HSL (degrees, %, %) to a #rrggbb colour. */
function hsl(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const value = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

const escapeXml = (text: string) => text.replace(/[<>&'"]/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * Writes a placeholder JPEG: coloured background, a simple house outline, the property's
 * reference code and the photo number. Clearly not a real photo of a real property.
 */
export async function createPlaceholderPhoto(
  options: PlaceholderPhotoOptions,
): Promise<PlaceholderPhoto> {
  const { filePath, refCode, photoNumber, photoCount, hue } = options;
  const lightness = 46 - photoNumber * 3;
  const font = "'DejaVu Sans', 'Segoe UI', Arial, sans-serif";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PHOTO_WIDTH}" height="${PHOTO_HEIGHT}" viewBox="0 0 ${PHOTO_WIDTH} ${PHOTO_HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${hsl(hue, 38, lightness + 12)}"/>
      <stop offset="1" stop-color="${hsl(hue, 42, lightness - 8)}"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <g opacity="0.6" fill="none" stroke="#ffffff" stroke-width="16" stroke-linejoin="round" stroke-linecap="round">
    <path d="M600 460 L800 290 L1000 460"/>
    <path d="M660 410 V640 H940 V410"/>
    <path d="M770 640 V540 H830 V640"/>
  </g>
  <text x="800" y="800" text-anchor="middle" font-family="${font}" font-size="110" font-weight="bold" fill="#ffffff">${escapeXml(refCode)}</text>
  <text x="800" y="885" text-anchor="middle" font-family="${font}" font-size="48" fill="#ffffff" fill-opacity="0.9">Photo ${photoNumber} of ${photoCount}</text>
  <text x="800" y="1030" text-anchor="middle" font-family="${font}" font-size="30" fill="#ffffff" fill-opacity="0.7">ImotSync demo data - made-up property</text>
</svg>`;

  const info = await sharp(Buffer.from(svg)).jpeg({ quality: 80, mozjpeg: true }).toFile(filePath);
  return { width: info.width, height: info.height, sizeBytes: info.size };
}
