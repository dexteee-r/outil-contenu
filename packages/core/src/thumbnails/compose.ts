import sharp, { type OverlayOptions } from 'sharp';
import type { AccountConfig } from '../config/account.js';
import { THUMBNAIL_SIZES, type ThumbnailFormat } from '../schemas/metadata.js';
import { resolveColor, type FormatTemplate, type ThumbnailTemplate } from './template.js';

/**
 * Composition d'une miniature : visuel (généré par IA ou non) + voile + titre + logo,
 * via Sharp. Le texte est posé par code (décision du plan : police et couleurs garanties).
 */

/** Largeur moyenne d'un glyphe en fraction de la taille de police (police condensée type Impact). */
const GLYPH_WIDTH_RATIO = 0.52;
const LINE_HEIGHT = 1.08;

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Découpe un titre en lignes de `maxChars` caractères max, sans couper les mots (sauf mot trop long). */
export function wrapTitle(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (word.length > maxChars) {
      if (current) lines.push(current);
      current = '';
      for (let i = 0; i < word.length; i += maxChars) lines.push(word.slice(i, i + maxChars));
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) current = candidate;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export interface FittedTitle {
  fontSize: number;
  lines: string[];
}

/** Réduit la taille de police jusqu'à ce que le titre tienne dans la zone (largeur et nombre de lignes). */
export function fitTitle(
  text: string,
  zoneWidthPx: number,
  maxFontPx: number,
  maxLines: number,
): FittedTitle {
  let fontSize = maxFontPx;
  const minFont = Math.max(12, maxFontPx * 0.4);
  for (;;) {
    const maxChars = Math.max(1, Math.floor(zoneWidthPx / (fontSize * GLYPH_WIDTH_RATIO)));
    const lines = wrapTitle(text, maxChars);
    if (lines.length <= maxLines || fontSize <= minFont) {
      return { fontSize, lines: lines.slice(0, maxLines) };
    }
    fontSize = Math.floor(fontSize * 0.92);
  }
}

export interface ComposeThumbnailOptions {
  /** Visuel de fond (PNG/JPEG), recadré en « cover » sur le format */
  background: Buffer;
  format: ThumbnailFormat;
  template: ThumbnailTemplate;
  brand: AccountConfig['brand'];
  title: string;
  /** Logo PNG (optionnel) */
  logo?: Buffer | undefined;
}

function gradientSvg(width: number, height: number, tpl: FormatTemplate, color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="${tpl.gradient.from}" stop-color="${color}" stop-opacity="0"/>
    <stop offset="1" stop-color="${color}" stop-opacity="${tpl.gradient.opacity}"/>
  </linearGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
</svg>`;
}

function titleSvg(
  width: number,
  height: number,
  tpl: FormatTemplate,
  template: ThumbnailTemplate,
  brand: AccountConfig['brand'],
  title: string,
): { svg: string; fitted: FittedTitle } {
  const zone = tpl.title;
  const zoneX = zone.x * width;
  const zoneW = zone.w * width;
  const text = template.font.uppercase ? title.toUpperCase() : title;
  const fitted = fitTitle(text, zoneW, zone.fontSize * height, zone.maxLines);
  const lineHeight = fitted.fontSize * LINE_HEIGHT;
  const anchor = zone.align === 'center' ? 'middle' : 'start';
  const x = zone.align === 'center' ? zoneX + zoneW / 2 : zoneX;
  const y0 = zone.y * height + fitted.fontSize;
  const fill = resolveColor(template.colors.text, brand);
  const stroke = resolveColor(template.colors.stroke, brand);
  const tspans = fitted.lines
    .map(
      (line, i) =>
        `<tspan x="${x}" y="${(y0 + i * lineHeight).toFixed(1)}">${escapeXml(line)}</tspan>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <text font-family='${template.font.family.replace(/'/g, '')}' font-weight="${template.font.weight}" font-size="${fitted.fontSize}"
        fill="${fill}" stroke="${stroke}" stroke-width="${Math.max(2, fitted.fontSize * 0.07).toFixed(1)}" paint-order="stroke"
        stroke-linejoin="round" text-anchor="${anchor}">${tspans}</text>
</svg>`;
  return { svg, fitted };
}

export interface ComposedThumbnail {
  png: Buffer;
  width: number;
  height: number;
  fitted: FittedTitle;
}

export async function composeThumbnail(o: ComposeThumbnailOptions): Promise<ComposedThumbnail> {
  const { width, height } = THUMBNAIL_SIZES[o.format];
  const tpl = o.template.formats[o.format];
  const layers: OverlayOptions[] = [];

  layers.push({ input: Buffer.from(gradientSvg(width, height, tpl, o.brand.colors.background)) });

  const { svg, fitted } = titleSvg(width, height, tpl, o.template, o.brand, o.title);
  layers.push({ input: Buffer.from(svg) });

  if (o.logo && tpl.logo) {
    const logoW = Math.round(tpl.logo.w * width);
    const logoPng = await sharp(o.logo)
      .resize({ width: logoW, withoutEnlargement: false })
      .png()
      .toBuffer();
    layers.push({
      input: logoPng,
      left: Math.round(tpl.logo.x * width),
      top: Math.round(tpl.logo.y * height),
    });
  }

  const png = await sharp(o.background)
    .resize(width, height, { fit: 'cover', position: 'attention' })
    .composite(layers)
    .png()
    .toBuffer();
  return { png, width, height, fitted };
}

/** Planche contact : toutes les variantes côte à côte pour choisir d'un coup d'œil. */
export async function contactSheet(
  images: Buffer[],
  options: { columns?: number; cellWidth?: number; labels?: string[] } = {},
): Promise<Buffer> {
  const columns = options.columns ?? Math.min(3, images.length);
  const cellWidth = options.cellWidth ?? 360;
  const cells = await Promise.all(
    images.map(async (img, i) => {
      const resized = await sharp(img).resize({ width: cellWidth }).png().toBuffer();
      const meta = await sharp(resized).metadata();
      const label = options.labels?.[i];
      if (!label) return { buf: resized, height: meta.height ?? cellWidth };
      // Bandeau d'étiquette en bas de la vignette (nom du modèle, variante…)
      const band = Math.round(cellWidth * 0.09);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellWidth}" height="${band}"><rect width="100%" height="100%" fill="#111"/><text x="${cellWidth / 2}" y="${band * 0.68}" text-anchor="middle" font-family="Arial" font-size="${band * 0.55}" fill="#fff">${escapeXml(label)}</text></svg>`;
      const buf = await sharp(resized)
        .extend({ bottom: band, background: '#111' })
        .composite([{ input: Buffer.from(svg), top: meta.height ?? cellWidth, left: 0 }])
        .png()
        .toBuffer();
      return { buf, height: (meta.height ?? cellWidth) + band };
    }),
  );
  const cellHeight = Math.max(...cells.map((c) => c.height));
  const rows = Math.ceil(cells.length / columns);
  const gap = 12;
  return sharp({
    create: {
      width: columns * cellWidth + (columns + 1) * gap,
      height: rows * cellHeight + (rows + 1) * gap,
      channels: 3,
      background: '#202020',
    },
  })
    .composite(
      cells.map((c, i) => ({
        input: c.buf,
        left: gap + (i % columns) * (cellWidth + gap),
        top: gap + Math.floor(i / columns) * (cellHeight + gap),
      })),
    )
    .png()
    .toBuffer();
}
