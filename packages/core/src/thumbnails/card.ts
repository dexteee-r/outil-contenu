import sharp, { type OverlayOptions } from 'sharp';
import type { AccountConfig } from '../config/account.js';
import { THUMBNAIL_SIZES, type ThumbnailFormat } from '../schemas/metadata.js';
import { escapeXml, fitTitle, type FittedTitle } from './compose.js';
import { resolveColor, type ThumbnailTemplate } from './template.js';

/**
 * Style « card » : la vraie image clé (la carte tirée, l'objet…) en vignette inclinée sur un fond
 * aux couleurs du compte, gros titre et pastille d'appel à l'action. Simple, moderne, aucune image IA.
 * Le 16:9 n'est pas un recadrage du 9:16 : chaque format a sa propre mise en page.
 */

export interface CardLayout {
  /** Vignette : centre et hauteur, en fractions du canevas */
  card: { cx: number; cy: number; height: number; ratio: number; tiltDeg: number };
  /** Zone du titre */
  title: {
    x: number;
    y: number;
    w: number;
    maxLines: number;
    align: 'left' | 'center';
    fontSize: number;
  };
  /** Position de la pastille d'appel à l'action (centre x, haut y) */
  cta: { cx: number; y: number; height: number };
}

export const CARD_LAYOUTS: Record<ThumbnailFormat, CardLayout> = {
  '9x16': {
    card: { cx: 0.5, cy: 0.35, height: 0.54, ratio: 0.72, tiltDeg: -6 },
    title: { x: 0.06, y: 0.64, w: 0.88, maxLines: 2, align: 'center', fontSize: 0.075 },
    cta: { cx: 0.5, y: 0.84, height: 0.055 },
  },
  '16x9': {
    card: { cx: 0.27, cy: 0.5, height: 0.66, ratio: 0.72, tiltDeg: -6 },
    title: { x: 0.52, y: 0.22, w: 0.44, maxLines: 3, align: 'left', fontSize: 0.15 },
    cta: { cx: 0.74, y: 0.7, height: 0.11 },
  },
};

/** Fond : couleur de marque + halo de la couleur primaire derrière la vignette. */
function backgroundSvg(
  width: number,
  height: number,
  layout: CardLayout,
  background: string,
  primary: string,
): string {
  const cx = layout.card.cx * width;
  const cy = layout.card.cy * height;
  const r = Math.max(width, height) * 0.55;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs><radialGradient id="halo" cx="${cx}" cy="${cy}" r="${r}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${primary}" stop-opacity="0.45"/>
    <stop offset="0.55" stop-color="${primary}" stop-opacity="0.08"/>
    <stop offset="1" stop-color="${primary}" stop-opacity="0"/>
  </radialGradient></defs>
  <rect width="${width}" height="${height}" fill="${background}"/>
  <rect width="${width}" height="${height}" fill="url(#halo)"/>
</svg>`;
}

/** Image clé → vignette portrait à coins arrondis, ombrée et inclinée (PNG avec transparence). */
export async function makeCardTile(
  keyFrame: Buffer,
  heightPx: number,
  ratio: number,
  tiltDeg: number,
): Promise<{ png: Buffer; width: number; height: number }> {
  const h = Math.round(heightPx);
  const w = Math.round(h * ratio);
  const radius = Math.round(h * 0.05);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${radius}" fill="#fff"/></svg>`,
  );
  const rounded = await sharp(keyFrame)
    .resize(w, h, { fit: 'cover', position: 'attention' })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  // Ombre : le même rectangle en noir, flouté, décalé
  const pad = Math.round(h * 0.12);
  const shadow = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w + pad * 2}" height="${h + pad * 2}"><rect x="${pad}" y="${pad + Math.round(h * 0.03)}" width="${w}" height="${h}" rx="${radius}" fill="#000" fill-opacity="0.55"/></svg>`,
    ),
  )
    .blur(pad / 3)
    .png()
    .toBuffer();
  const tile = await sharp(shadow)
    .composite([{ input: rounded, left: pad, top: pad }])
    .rotate(tiltDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const meta = await sharp(tile).metadata();
  return { png: tile, width: meta.width ?? w, height: meta.height ?? h };
}

function titleSvg(
  width: number,
  height: number,
  layout: CardLayout,
  template: ThumbnailTemplate,
  brand: AccountConfig['brand'],
  title: string,
): { svg: string; fitted: FittedTitle; bottomY: number } {
  const zone = layout.title;
  const text = template.font.uppercase ? title.toUpperCase() : title;
  const fitted = fitTitle(text, zone.w * width, zone.fontSize * height, zone.maxLines);
  const lineHeight = fitted.fontSize * 1.05;
  const x = zone.align === 'center' ? (zone.x + zone.w / 2) * width : zone.x * width;
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
        fill="${fill}" stroke="${stroke}" stroke-width="${Math.max(2, fitted.fontSize * 0.06).toFixed(1)}" paint-order="stroke"
        stroke-linejoin="round" text-anchor="${zone.align === 'center' ? 'middle' : 'start'}">${tspans}</text>
</svg>`;
  return { svg, fitted, bottomY: y0 + (fitted.lines.length - 1) * lineHeight };
}

/** Pastille d'appel à l'action : rectangle arrondi couleur primaire, texte + flèche. */
function ctaSvg(
  width: number,
  height: number,
  layout: CardLayout,
  template: ThumbnailTemplate,
  brand: AccountConfig['brand'],
  cta: string,
  topY: number,
): string {
  const h = layout.cta.height * height;
  const fontSize = h * 0.62;
  const text = template.font.uppercase ? cta.toUpperCase() : cta;
  const textW = text.length * fontSize * 0.55;
  const arrowW = h * 0.6;
  const w = textW + arrowW + h * 1.2;
  const cx = layout.cta.cx * width;
  const x = layout.title.align === 'center' ? cx - w / 2 : layout.title.x * width;
  const y = topY;
  const primary = resolveColor(template.colors.highlight, brand);
  const ax = x + h * 0.6 + textW + h * 0.25;
  const ay = y + h / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(h / 2).toFixed(1)}" fill="${primary}"/>
  <text x="${(x + h * 0.6).toFixed(1)}" y="${(y + h * 0.68).toFixed(1)}" font-family='${template.font.family.replace(/'/g, '')}' font-weight="${template.font.weight}" font-size="${fontSize.toFixed(1)}" fill="${brand.colors.background}">${escapeXml(text)}</text>
  <path d="M ${ax.toFixed(1)} ${(ay - h * 0.2).toFixed(1)} L ${(ax + arrowW * 0.55).toFixed(1)} ${ay.toFixed(1)} L ${ax.toFixed(1)} ${(ay + h * 0.2).toFixed(1)} Z" fill="${brand.colors.background}"/>
</svg>`;
}

export interface ComposeCardOptions {
  keyFrame: Buffer;
  format: ThumbnailFormat;
  template: ThumbnailTemplate;
  brand: AccountConfig['brand'];
  title: string;
  logo?: Buffer | undefined;
}

export async function composeCardThumbnail(
  o: ComposeCardOptions,
): Promise<{ png: Buffer; width: number; height: number; fitted: FittedTitle }> {
  const { width, height } = THUMBNAIL_SIZES[o.format];
  const layout = CARD_LAYOUTS[o.format];
  const primary = resolveColor(o.template.colors.highlight, o.brand);
  const layers: OverlayOptions[] = [];

  let tile = await makeCardTile(
    o.keyFrame,
    layout.card.height * height,
    layout.card.ratio,
    layout.card.tiltDeg,
  );
  // La vignette (ombre + inclinaison comprises) doit tenir dans le canevas
  if (tile.width > width || tile.height > height) {
    const png = await sharp(tile.png).resize({ width, height, fit: 'inside' }).png().toBuffer();
    const meta = await sharp(png).metadata();
    tile = { png, width: meta.width ?? width, height: meta.height ?? height };
  }
  layers.push({
    input: tile.png,
    left: Math.round(layout.card.cx * width - tile.width / 2),
    top: Math.round(layout.card.cy * height - tile.height / 2),
  });

  const title = titleSvg(width, height, layout, o.template, o.brand, o.title);
  layers.push({ input: Buffer.from(title.svg) });

  if (o.template.cta) {
    const ctaTop = Math.max(layout.cta.y * height, title.bottomY + height * 0.03);
    layers.push({
      input: Buffer.from(
        ctaSvg(width, height, layout, o.template, o.brand, o.template.cta, ctaTop),
      ),
    });
  }

  if (o.logo) {
    const logoW = Math.round(width * (o.format === '9x16' ? 0.18 : 0.1));
    const logoPng = await sharp(o.logo).resize({ width: logoW }).png().toBuffer();
    layers.push({ input: logoPng, left: Math.round(width * 0.05), top: Math.round(height * 0.04) });
  }

  const png = await sharp(
    Buffer.from(backgroundSvg(width, height, layout, o.brand.colors.background, primary)),
  )
    .composite(layers)
    .png()
    .toBuffer();
  return { png, width, height, fitted: title.fitted };
}
