import sharp, { type OverlayOptions, type Sharp } from 'sharp';
import type { AccountConfig } from '../config/account.js';
import { THUMBNAIL_SIZES, type ThumbnailFormat } from '../schemas/metadata.js';
import { escapeXml, fitTitle, type FittedTitle } from './compose.js';
import { resolveColor, type ThumbnailTemplate } from './template.js';

/**
 * Style « screen » : une capture réelle de la vidéo, plein cadre, avec le traitement des
 * miniatures YouTube modernes — étalonnage punchy (contraste, saturation, netteté), vignettage,
 * dégradé sous le texte, titre épais à contour. En 16:9, la capture verticale est posée sur son
 * propre fond flouté (fond de même image, zoomé), titre à côté.
 */

/** Étalonnage « miniature » : plus de contraste et de saturation, un peu de netteté (pur sharp). */
export function gradeForThumbnail(image: Sharp): Sharp {
  return image
    .modulate({ saturation: 1.35, brightness: 1.04 })
    .linear(1.18, -14) // contraste : pente > 1, offset négatif
    .sharpen({ sigma: 1.2 });
}

function vignetteSvg(width: number, height: number, strength: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs><radialGradient id="v" cx="50%" cy="45%" r="75%">
    <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000" stop-opacity="${strength}"/>
  </radialGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#v)"/>
</svg>`;
}

/** Dégradé sombre en bas (ou sur un côté) pour asseoir le titre. */
function textShadeSvg(width: number, height: number, from: number, opacity: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
    <stop offset="${from}" stop-color="#000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000" stop-opacity="${opacity}"/>
  </linearGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#s)"/>
</svg>`;
}

interface TitleBox {
  x: number;
  y: number;
  w: number;
  maxLines: number;
  align: 'left' | 'center';
  fontSize: number;
}

function titleSvg(
  width: number,
  height: number,
  box: TitleBox,
  template: ThumbnailTemplate,
  brand: AccountConfig['brand'],
  title: string,
): { svg: string; fitted: FittedTitle; bottomY: number } {
  const text = template.font.uppercase ? title.toUpperCase() : title;
  const fitted = fitTitle(text, box.w * width, box.fontSize * height, box.maxLines);
  const lineHeight = fitted.fontSize * 1.02;
  const x = box.align === 'center' ? (box.x + box.w / 2) * width : box.x * width;
  const y0 = box.y * height + fitted.fontSize;
  const fill = resolveColor(template.colors.text, brand);
  const strokeW = Math.max(4, fitted.fontSize * 0.11);
  const tspans = fitted.lines
    .map(
      (line, i) =>
        `<tspan x="${x}" y="${(y0 + i * lineHeight).toFixed(1)}">${escapeXml(line)}</tspan>`,
    )
    .join('');
  const family = template.font.family.replace(/'/g, '');
  const anchor = box.align === 'center' ? 'middle' : 'start';
  // Ombre portée puis texte avec contour noir épais : le traitement YouTube classique
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <g transform="translate(${(fitted.fontSize * 0.05).toFixed(1)} ${(fitted.fontSize * 0.07).toFixed(1)})" opacity="0.55">
    <text font-family='${family}' font-weight="${template.font.weight}" font-size="${fitted.fontSize}" fill="#000" stroke="#000" stroke-width="${strokeW.toFixed(1)}" stroke-linejoin="round" text-anchor="${anchor}">${tspans}</text>
  </g>
  <text font-family='${family}' font-weight="${template.font.weight}" font-size="${fitted.fontSize}" fill="${fill}" stroke="#000" stroke-width="${strokeW.toFixed(1)}" paint-order="stroke" stroke-linejoin="round" text-anchor="${anchor}">${tspans}</text>
</svg>`;
  return { svg, fitted, bottomY: y0 + (fitted.lines.length - 1) * lineHeight };
}

function ctaSvg(
  width: number,
  height: number,
  box: TitleBox,
  template: ThumbnailTemplate,
  brand: AccountConfig['brand'],
  cta: string,
  topY: number,
  ctaHeight: number,
): string {
  const h = ctaHeight * height;
  const fontSize = h * 0.6;
  const text = template.font.uppercase ? cta.toUpperCase() : cta;
  const textW = text.length * fontSize * 0.55;
  const arrowW = h * 0.55;
  const w = textW + arrowW + h * 1.2;
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

export interface ComposeScreenOptions {
  /** Capture réelle (PNG/JPEG), généralement verticale */
  frame: Buffer;
  format: ThumbnailFormat;
  template: ThumbnailTemplate;
  brand: AccountConfig['brand'];
  title: string;
  logo?: Buffer | undefined;
}

export async function composeScreenThumbnail(
  o: ComposeScreenOptions,
): Promise<{ png: Buffer; width: number; height: number; fitted: FittedTitle }> {
  const { width, height } = THUMBNAIL_SIZES[o.format];
  const layers: OverlayOptions[] = [];
  let base: Sharp;
  let box: TitleBox;
  let ctaHeight: number;

  if (o.format === '9x16') {
    // Plein cadre : la capture couvre tout, étalonnée
    base = gradeForThumbnail(
      sharp(o.frame).resize(width, height, { fit: 'cover', position: 'attention' }),
    );
    layers.push({ input: Buffer.from(vignetteSvg(width, height, 0.55)) });
    layers.push({ input: Buffer.from(textShadeSvg(width, height, 0.5, 0.9)) });
    box = { x: 0.06, y: 0.7, w: 0.88, maxLines: 2, align: 'center', fontSize: 0.085 };
    ctaHeight = 0.055;
  } else {
    // 16:9 : fond = la même capture zoomée et floutée ; devant, la capture verticale nette à gauche
    const bg = await gradeForThumbnail(
      sharp(o.frame).resize(width, height, { fit: 'cover', position: 'centre' }),
    )
      .blur(28)
      .modulate({ brightness: 0.6 })
      .png()
      .toBuffer();
    base = sharp(bg);
    const insetH = Math.round(height * 0.84);
    const meta = await sharp(o.frame).metadata();
    const ratio = (meta.width ?? 1080) / (meta.height ?? 1920);
    const insetW = Math.round(insetH * Math.min(ratio, 0.75));
    const inset = await gradeForThumbnail(
      sharp(o.frame).resize(insetW, insetH, { fit: 'cover', position: 'attention' }),
    )
      .png()
      .toBuffer();
    const left = Math.round(width * 0.06);
    const top = Math.round((height - insetH) / 2);
    // Ombre de la capture, puis la capture avec un liseré clair
    layers.push({
      input: await sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${insetW + 80}" height="${insetH + 80}"><rect x="40" y="48" width="${insetW}" height="${insetH}" rx="18" fill="#000" fill-opacity="0.6"/></svg>`,
        ),
      )
        .blur(14)
        .png()
        .toBuffer(),
      left: left - 40,
      top: top - 40,
    });
    const rounded = await sharp(inset)
      .composite([
        {
          input: Buffer.from(
            `<svg width="${insetW}" height="${insetH}"><rect width="${insetW}" height="${insetH}" rx="18" fill="#fff"/></svg>`,
          ),
          blend: 'dest-in',
        },
      ])
      .png()
      .toBuffer();
    layers.push({ input: rounded, left, top });
    layers.push({ input: Buffer.from(vignetteSvg(width, height, 0.45)) });
    box = {
      x: (left + insetW) / width + 0.05,
      y: 0.2,
      w: 1 - (left + insetW) / width - 0.1,
      maxLines: 3,
      align: 'left',
      fontSize: 0.16,
    };
    ctaHeight = 0.11;
  }

  const title = titleSvg(width, height, box, o.template, o.brand, o.title);
  layers.push({ input: Buffer.from(title.svg) });
  if (o.template.cta) {
    layers.push({
      input: Buffer.from(
        ctaSvg(
          width,
          height,
          box,
          o.template,
          o.brand,
          o.template.cta,
          title.bottomY + height * 0.035,
          ctaHeight,
        ),
      ),
    });
  }
  if (o.logo) {
    const logoW = Math.round(width * (o.format === '9x16' ? 0.18 : 0.1));
    const logoPng = await sharp(o.logo).resize({ width: logoW }).png().toBuffer();
    layers.push({ input: logoPng, left: Math.round(width * 0.05), top: Math.round(height * 0.04) });
  }

  const png = await base.composite(layers).png().toBuffer();
  return { png, width, height, fitted: title.fitted };
}
