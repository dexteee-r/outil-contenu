import sharp, { type OverlayOptions } from 'sharp';
import type { AccountConfig } from '../config/account.js';
import { THUMBNAIL_SIZES, type ThumbnailFormat } from '../schemas/metadata.js';
import { escapeXml, fitTitle, type FittedTitle } from './compose.js';
import { resolveColor, type ThumbnailTemplate } from './template.js';

/**
 * Style « poster » : le sujet détouré (booster, carte, objet) en héros sur un fond graphique de
 * marque, avec trois éléments de décor seulement — halo, rayons, étincelles — et un gros titre.
 * C'est la grammaire des miniatures sociales modernes : un sujet, un fond franc, un texte court.
 */

export interface PosterLayout {
  /** Centre et hauteur du sujet, en fractions du canevas */
  hero: { cx: number; cy: number; height: number; tiltDeg: number };
  title: {
    x: number;
    y: number;
    w: number;
    maxLines: number;
    align: 'left' | 'center';
    fontSize: number;
  };
  ctaHeight: number;
}

export const POSTER_LAYOUTS: Record<ThumbnailFormat, PosterLayout> = {
  // Vertical : sujet dans le tiers haut/milieu, texte dessous, hors des zones d'UI TikTok/Reels
  '9x16': {
    hero: { cx: 0.5, cy: 0.4, height: 0.64, tiltDeg: -5 },
    title: { x: 0.06, y: 0.72, w: 0.88, maxLines: 2, align: 'center', fontSize: 0.082 },
    ctaHeight: 0.05,
  },
  // Horizontal : sujet à droite, texte à gauche (lecture naturelle des miniatures YouTube)
  '16x9': {
    hero: { cx: 0.74, cy: 0.5, height: 0.88, tiltDeg: -5 },
    title: { x: 0.05, y: 0.22, w: 0.44, maxLines: 3, align: 'left', fontSize: 0.16 },
    ctaHeight: 0.1,
  },
};

/** Fond : aplat de marque + rayons partant du sujet + halo — les deux premiers éléments de décor. */
function backgroundSvg(
  width: number,
  height: number,
  layout: PosterLayout,
  background: string,
  primary: string,
): string {
  const cx = layout.hero.cx * width;
  const cy = layout.hero.cy * height;
  const r = Math.hypot(width, height);
  // Rayons discrets : 8 branches fines, presque transparentes (le sujet doit rester le héros)
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2 + 0.26;
    const spread = 0.055;
    const p = (angle: number) =>
      `${(cx + Math.cos(angle) * r).toFixed(0)},${(cy + Math.sin(angle) * r).toFixed(0)}`;
    return `<polygon points="${cx.toFixed(0)},${cy.toFixed(0)} ${p(a - spread)} ${p(a + spread)}" fill="${primary}" opacity="0.07"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <radialGradient id="halo" cx="${cx}" cy="${cy}" r="${(r * 0.45).toFixed(0)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${primary}" stop-opacity="0.38"/>
      <stop offset="0.6" stop-color="${primary}" stop-opacity="0.12"/>
      <stop offset="1" stop-color="${primary}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${background}" stop-opacity="1"/>
      <stop offset="1" stop-color="#000000" stop-opacity="1"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <g>${rays}</g>
  <rect width="${width}" height="${height}" fill="url(#halo)"/>
</svg>`;
}

/** Troisième élément de décor : quelques étincelles autour du sujet (déterministes). */
function sparklesSvg(width: number, height: number, layout: PosterLayout, color: string): string {
  const cx = layout.hero.cx * width;
  const cy = layout.hero.cy * height;
  const radius = layout.hero.height * height * 0.62;
  const points = [0.5, 2.2, 4.1, 5.5];
  const shapes = points
    .map((a, i) => {
      const rr = radius * (i % 2 === 0 ? 1 : 0.78);
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr * 0.9;
      const s = (i % 2 === 0 ? 22 : 14) * (width / 1080);
      return `<polygon points="${x},${y - s} ${x + s * 0.3},${y} ${x},${y + s} ${x - s * 0.3},${y}" fill="${color}" opacity="${i % 2 === 0 ? 0.9 : 0.55}"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes}</svg>`;
}

function titleSvg(
  width: number,
  height: number,
  layout: PosterLayout,
  template: ThumbnailTemplate,
  brand: AccountConfig['brand'],
  title: string,
): { svg: string; fitted: FittedTitle; bottomY: number } {
  const box = layout.title;
  const text = template.font.uppercase ? title.toUpperCase() : title;
  const fitted = fitTitle(text, box.w * width, box.fontSize * height, box.maxLines);
  const lineHeight = fitted.fontSize * 1.02;
  const x = box.align === 'center' ? (box.x + box.w / 2) * width : box.x * width;
  const y0 = box.y * height + fitted.fontSize;
  const fill = resolveColor(template.colors.text, brand);
  const strokeW = Math.max(4, fitted.fontSize * 0.1);
  const tspans = fitted.lines
    .map(
      (line, i) =>
        `<tspan x="${x}" y="${(y0 + i * lineHeight).toFixed(1)}">${escapeXml(line)}</tspan>`,
    )
    .join('');
  const family = template.font.family.replace(/'/g, '');
  const anchor = box.align === 'center' ? 'middle' : 'start';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <g transform="translate(${(fitted.fontSize * 0.04).toFixed(1)} ${(fitted.fontSize * 0.06).toFixed(1)})" opacity="0.5">
    <text font-family='${family}' font-weight="${template.font.weight}" font-size="${fitted.fontSize}" fill="#000" stroke="#000" stroke-width="${strokeW.toFixed(1)}" stroke-linejoin="round" text-anchor="${anchor}">${tspans}</text>
  </g>
  <text font-family='${family}' font-weight="${template.font.weight}" font-size="${fitted.fontSize}" fill="${fill}" stroke="#000" stroke-width="${strokeW.toFixed(1)}" paint-order="stroke" stroke-linejoin="round" text-anchor="${anchor}">${tspans}</text>
</svg>`;
  return { svg, fitted, bottomY: y0 + (fitted.lines.length - 1) * lineHeight };
}

function ctaSvg(
  width: number,
  height: number,
  layout: PosterLayout,
  template: ThumbnailTemplate,
  brand: AccountConfig['brand'],
  cta: string,
  topY: number,
): string {
  const h = layout.ctaHeight * height;
  const fontSize = h * 0.6;
  const text = template.font.uppercase ? cta.toUpperCase() : cta;
  const textW = text.length * fontSize * 0.55;
  const arrowW = h * 0.55;
  const w = textW + arrowW + h * 1.2;
  const box = layout.title;
  const x = box.align === 'center' ? (box.x + box.w / 2) * width - w / 2 : box.x * width;
  const primary = resolveColor(template.colors.highlight, brand);
  const ax = x + h * 0.6 + textW + h * 0.25;
  const ay = topY + h / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect x="${x.toFixed(1)}" y="${topY.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(h / 2).toFixed(1)}" fill="${primary}"/>
  <text x="${(x + h * 0.6).toFixed(1)}" y="${(topY + h * 0.68).toFixed(1)}" font-family='${template.font.family.replace(/'/g, '')}' font-weight="${template.font.weight}" font-size="${fontSize.toFixed(1)}" fill="${brand.colors.background}">${escapeXml(text)}</text>
  <path d="M ${ax.toFixed(1)} ${(ay - h * 0.2).toFixed(1)} L ${(ax + arrowW * 0.55).toFixed(1)} ${ay.toFixed(1)} L ${ax.toFixed(1)} ${(ay + h * 0.2).toFixed(1)} Z" fill="${brand.colors.background}"/>
</svg>`;
}

/** Sujet : détouré (PNG transparent) → mis à l'échelle, incliné, avec une ombre portée. */
export async function prepareHero(
  subject: Buffer,
  heightPx: number,
  tiltDeg: number,
  maxWidthPx: number,
): Promise<{ png: Buffer; width: number; height: number }> {
  const trimmed = await sharp(subject).trim({ threshold: 6 }).png().toBuffer();
  const meta = await sharp(trimmed).metadata();
  const ratio = (meta.width ?? 1) / (meta.height ?? 1);
  let h = Math.round(heightPx);
  let w = Math.round(h * ratio);
  if (w > maxWidthPx) {
    w = Math.round(maxWidthPx);
    h = Math.round(w / ratio);
  }
  // ensureAlpha : une image opaque (sujet non détouré) n'a pas de canal alpha à extraire
  const resized = await sharp(trimmed)
    .resize(w, h, { fit: 'inside' })
    .ensureAlpha()
    .png()
    .toBuffer();
  // Ombre : un aplat noir masqué par l'alpha du sujet (`dest-in` garde le noir là où le sujet est opaque)
  const pad = Math.round(h * 0.08);
  const silhouette = await sharp({
    create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.7 } },
  })
    .composite([{ input: resized, blend: 'dest-in' }])
    .png()
    .toBuffer();
  const shadow = await sharp({
    create: {
      width: w + pad * 2,
      height: h + pad * 2,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: silhouette, left: pad, top: pad + Math.round(h * 0.025) }])
    .blur(pad / 2.5)
    .png()
    .toBuffer();
  const withShadow = await sharp(shadow)
    .composite([{ input: resized, left: pad, top: pad }])
    .rotate(tiltDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const out = await sharp(withShadow).metadata();
  return { png: withShadow, width: out.width ?? w, height: out.height ?? h };
}

export interface ComposePosterOptions {
  /** Sujet détouré (PNG transparent) ou image opaque (elle sera posée telle quelle) */
  subject: Buffer;
  format: ThumbnailFormat;
  template: ThumbnailTemplate;
  brand: AccountConfig['brand'];
  title: string;
  logo?: Buffer | undefined;
}

export async function composePosterThumbnail(
  o: ComposePosterOptions,
): Promise<{ png: Buffer; width: number; height: number; fitted: FittedTitle }> {
  const { width, height } = THUMBNAIL_SIZES[o.format];
  const layout = POSTER_LAYOUTS[o.format];
  const primary = resolveColor(o.template.colors.highlight, o.brand);
  const layers: OverlayOptions[] = [];

  let hero = await prepareHero(
    o.subject,
    layout.hero.height * height,
    layout.hero.tiltDeg,
    width * 0.86,
  );
  // Ombre et inclinaison agrandissent le sujet : il doit rester dans le canevas
  const maxW = Math.round(width * 0.92);
  const maxH = Math.round(height * 0.94);
  if (hero.width > maxW || hero.height > maxH) {
    const png = await sharp(hero.png)
      .resize({ width: maxW, height: maxH, fit: 'inside' })
      .png()
      .toBuffer();
    const m = await sharp(png).metadata();
    hero = { png, width: m.width ?? maxW, height: m.height ?? maxH };
  }
  layers.push({
    input: Buffer.from(sparklesSvg(width, height, layout, primary)),
  });
  layers.push({
    input: hero.png,
    left: Math.round(layout.hero.cx * width - hero.width / 2),
    top: Math.round(layout.hero.cy * height - hero.height / 2),
  });

  const title = titleSvg(width, height, layout, o.template, o.brand, o.title);
  layers.push({ input: Buffer.from(title.svg) });
  if (o.template.cta) {
    layers.push({
      input: Buffer.from(
        ctaSvg(
          width,
          height,
          layout,
          o.template,
          o.brand,
          o.template.cta,
          title.bottomY + height * 0.03,
        ),
      ),
    });
  }
  if (o.logo) {
    const logoW = Math.round(width * (o.format === '9x16' ? 0.16 : 0.09));
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
