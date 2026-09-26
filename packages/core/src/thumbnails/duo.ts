import sharp, { type OverlayOptions } from 'sharp';
import type { AccountConfig } from '../config/account.js';
import { THUMBNAIL_SIZES, type ThumbnailFormat } from '../schemas/metadata.js';
import { escapeXml } from './compose.js';
import { renderTextWithFont } from './fonts.js';
import { resolveColor, type ThumbnailTemplate } from './template.js';

/**
 * Style « duo » (défaut), tiré de l'analyse de 17 miniatures TCG populaires (accounts/tcg/inspiration) :
 * - le produit réel en très grand, détouré, avec un liseré blanc (effet sticker) ;
 * - la carte hit à côté, entourée d'une lueur de sa propre couleur — ou floutée avec un « ? » (teaser) ;
 * - un fond « énergie » dans la couleur du produit, jamais un fond neutre ;
 * - un texte très court dans une étiquette pleine (1 à 3 mots, un chiffre ou une question) ;
 * - une flèche vers la carte. Pas de bouton « regarde » : aucune référence n'en met.
 */

// ─── Couleurs ────────────────────────────────────────────────────────────────

export interface Hsl {
  /** 0..360 */
  h: number;
  /** 0..1 */
  s: number;
  /** 0..1 */
  l: number;
}

export function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  const hex = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v + m)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(r1)}${hex(g1)}${hex(b1)}`;
}

export function hexToHsl(hex: string): Hsl {
  const n = Number.parseInt(hex.slice(1), 16);
  return rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/**
 * Règle classique de détection de peau en YCbCr (Cb 77–127, Cr 133–173). Elle attrape aussi les
 * gris chauds d'une balance des blancs tiède, mais pas le rouge d'une carte ni un orange vif.
 */
export function isSkinTone(r: number, g: number, b: number): boolean {
  const cb = 128 - 0.1687 * r - 0.3313 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.4187 * g - 0.0813 * b;
  return cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
}

/**
 * Teinte dominante d'une image : celle de ses grandes surfaces colorées (le violet d'un booster
 * OP-10, le rouge d'une carte), pas celle des petits détails saturés (logo doré, visage). L'image
 * est d'abord réduite à 24 px pour que les détails se fondent dans leur surface ; chaque pixel
 * coloré compte pour un. null si l'image est grise ou presque vide.
 */
export async function dominantHue(image: Buffer): Promise<number | null> {
  // Recadré sur le sujet d'abord : un détourage garde souvent tout le cadre d'origine autour
  const trimmed = await sharp(image).ensureAlpha().trim({ threshold: 6 }).png().toBuffer();
  const { data } = await sharp(trimmed)
    .resize(24, 24, { fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bins = new Array<number>(36).fill(0);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] ?? 0) < 200) continue;
    const { h, s, l } = rgbToHsl(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    // Seuil bas : à la caméra, le violet d'un booster sort terne (saturation ~0.2)
    if (s < 0.12 || l < 0.12 || l > 0.88) continue;
    // Peau des mains et gris « chauds » de la balance des blancs : jamais la couleur du sujet
    if (isSkinTone(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0)) continue;
    const bin = Math.floor(h / 10) % 36;
    bins[bin] = (bins[bin] ?? 0) + 1;
    total++;
  }
  if (total < 8) return null;
  // Fenêtre glissante de ±20° : une surface violette étalée sur 240-290° bat un doré concentré
  const weights = [0.5, 1, 1, 1, 0.5];
  let best = 0;
  let bestScore = -1;
  for (let b = 0; b < 36; b++) {
    const score = weights.reduce((acc, w, k) => acc + w * (bins[(b + k - 2 + 36) % 36] ?? 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best * 10 + 5;
}

export interface DuoPalette {
  /** Bords du fond */
  dark: string;
  /** Centre du fond */
  mid: string;
  /** Explosion de lumière derrière le produit */
  burst: string;
  /** Lueur autour de la carte */
  glow: string;
}

export function duoPalette(heroHue: number, secondaryHue: number): DuoPalette {
  return {
    dark: hslToHex({ h: heroHue, s: 0.7, l: 0.07 }),
    mid: hslToHex({ h: heroHue, s: 0.75, l: 0.3 }),
    burst: hslToHex({ h: heroHue, s: 0.95, l: 0.62 }),
    glow: hslToHex({ h: secondaryHue, s: 1, l: 0.6 }),
  };
}

// ─── Sujets détourés (« stickers ») ──────────────────────────────────────────

export interface StickerOptions {
  heightPx: number;
  maxWidthPx: number;
  tiltDeg: number;
  /** Liseré uni autour de la silhouette (effet sticker) */
  outline?: { color: string; widthPx: number } | undefined;
  /** Lueur colorée diffuse autour de la silhouette */
  glow?: { color: string; radiusPx: number; strength: number } | undefined;
  /** Ombre portée douce sous le sujet */
  shadow?: boolean | undefined;
  /** Flou du sujet lui-même (variante teaser) */
  blurPx?: number | undefined;
}

/** Bords de l'image source que le sujet touche (main qui entre dans le champ…). */
export interface Edges {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
}

export interface Sticker {
  png: Buffer;
  width: number;
  height: number;
  /** Taille du sujet seul, avant marge et inclinaison */
  contentWidth: number;
  contentHeight: number;
  edges: Edges;
}

type Mask = { data: Buffer; width: number; height: number };

const rawMask = (m: Mask) => ({ raw: { width: m.width, height: m.height, channels: 1 as const } });

/** Sharp repasse un masque à 1 canal en sRGB (3 canaux identiques) : on n'en garde qu'un. */
function firstChannel(data: Buffer, channels: number, width: number, height: number): Mask {
  if (channels === 1) return { data, width, height };
  const one = Buffer.alloc(width * height);
  for (let i = 0; i < one.length; i++) one[i] = data[i * channels] ?? 0;
  return { data: one, width, height };
}

async function blurMask(m: Mask, sigma: number): Promise<Mask> {
  const { data, info } = await sharp(m.data, rawMask(m))
    .blur(Math.max(0.3, sigma))
    .raw()
    .toBuffer({ resolveWithObject: true });
  return firstChannel(data, info.channels, m.width, m.height);
}

async function alphaMask(png: Buffer): Promise<Mask> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return firstChannel(data, info.channels, info.width, info.height);
}

/**
 * Côtés où le détourage est coupé par le bord de l'image (plus de 3 % du bord opaque). Une image
 * sans aucune transparence (sujet non détouré) ne « touche » rien : ce n'est pas une coupe.
 */
export async function touchingEdges(image: Buffer): Promise<Edges> {
  const small = await sharp(image)
    .ensureAlpha()
    .resize(200, 200, { fit: 'inside' })
    .png()
    .toBuffer();
  const m = await alphaMask(small);
  const at = (x: number, y: number) => m.data[y * m.width + x] ?? 0;
  const share = (n: number, f: (i: number) => number) => {
    let hits = 0;
    for (let i = 0; i < n; i++) if (f(i) > 128) hits++;
    return hits / n;
  };
  const left = share(m.height, (y) => at(0, y));
  const right = share(m.height, (y) => at(m.width - 1, y));
  const top = share(m.width, (x) => at(x, 0));
  const bottom = share(m.width, (x) => at(x, m.height - 1));
  const opaque = Math.min(left, right, top, bottom) > 0.97;
  const cut = (v: number) => !opaque && v > 0.03;
  return { left: cut(left), right: cut(right), top: cut(top), bottom: cut(bottom) };
}

function mapMask(m: Mask, f: (v: number) => number): Mask {
  const data = Buffer.alloc(m.data.length);
  for (let i = 0; i < m.data.length; i++) data[i] = Math.min(255, Math.max(0, f(m.data[i] ?? 0)));
  return { ...m, data };
}

/** Décale un masque vers le bas (ombre portée). */
function shiftDown(m: Mask, dy: number): Mask {
  const data = Buffer.alloc(m.data.length);
  m.data.copy(data, dy * m.width, 0, Math.max(0, m.data.length - dy * m.width));
  return { ...m, data };
}

/** Aplat de couleur dont l'opacité est donnée par le masque. */
async function tinted(m: Mask, color: string): Promise<Buffer> {
  return sharp({ create: { width: m.width, height: m.height, channels: 3, background: color } })
    .joinChannel(m.data, rawMask(m))
    .png()
    .toBuffer();
}

/** Sujet (PNG détouré, ou image opaque) → mis à l'échelle, liseré, lueur, ombre, incliné. */
export async function prepareSticker(image: Buffer, o: StickerOptions): Promise<Sticker> {
  const edges = await touchingEdges(image);
  const trimmed = await sharp(image).ensureAlpha().trim({ threshold: 6 }).png().toBuffer();
  const meta = await sharp(trimmed).metadata();
  const ratio = (meta.width ?? 1) / (meta.height ?? 1);
  let h = Math.round(o.heightPx);
  let w = Math.round(h * ratio);
  if (w > o.maxWidthPx) {
    w = Math.round(o.maxWidthPx);
    h = Math.round(w / ratio);
  }
  const resized = await sharp(trimmed).resize(w, h, { fit: 'fill' }).png().toBuffer();
  const subject = o.blurPx ? await sharp(resized).blur(o.blurPx).png().toBuffer() : resized;

  const outlineW = o.outline?.widthPx ?? 0;
  const glowR = o.glow?.radiusPx ?? 0;
  const shadowDy = o.shadow ? Math.round(h * 0.025) : 0;
  const pad = Math.ceil(Math.max(outlineW * 2.5, glowR * 2.5, shadowDy * 3)) + 4;
  const clear = { r: 0, g: 0, b: 0, alpha: 0 };
  const padded = await sharp(subject)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: clear })
    .png()
    .toBuffer();
  const alpha = await alphaMask(padded);

  const layers: OverlayOptions[] = [];
  if (o.shadow) {
    const soft = await blurMask(shiftDown(alpha, shadowDy), Math.max(1, h * 0.03));
    layers.push({
      input: await tinted(
        mapMask(soft, (v) => v * 0.65),
        '#000000',
      ),
    });
  }
  if (o.glow) {
    const strength = o.glow.strength;
    const soft = await blurMask(alpha, glowR / 2);
    layers.push({
      input: await tinted(
        mapMask(soft, (v) => v * strength),
        o.glow.color,
      ),
    });
  }
  if (o.outline) {
    // Dilatation : flou puis seuil bas, puis un léger flou pour l'anticrénelage
    const grown = await blurMask(alpha, Math.max(0.6, outlineW / 2));
    const edge = await blurMask(
      mapMask(grown, (v) => (v > 10 ? 255 : 0)),
      0.8,
    );
    layers.push({ input: await tinted(edge, o.outline.color) });
  }
  layers.push({ input: padded });

  const composed = await sharp({
    create: { width: alpha.width, height: alpha.height, channels: 4, background: clear },
  })
    .composite(layers)
    .png()
    .toBuffer();
  const rotated = await sharp(composed).rotate(o.tiltDeg, { background: clear }).png().toBuffer();
  const out = await sharp(rotated).metadata();
  return {
    png: rotated,
    width: out.width ?? alpha.width,
    height: out.height ?? alpha.height,
    contentWidth: w,
    contentHeight: h,
    edges,
  };
}

/**
 * Centre du sujet dans son emplacement, décalé pour qu'un bord coupé (la main qui sort du champ)
 * sorte aussi du canevas au lieu d'apparaître comme une coupe nette. Seuls les côtés vers
 * lesquels l'emplacement penche sont concernés (une carte à droite peut sortir à droite).
 */
export function bleedCenter(
  slot: { cx: number; cy: number; tiltDeg: number },
  s: Pick<Sticker, 'contentWidth' | 'contentHeight' | 'edges'>,
  canvasW: number,
  canvasH: number,
): { cx: number; cy: number } {
  let cx = slot.cx * canvasW;
  let cy = slot.cy * canvasH;
  const t = (Math.abs(slot.tiltDeg) * Math.PI) / 180;
  // Distance du centre au point le plus intérieur d'un bord vertical (resp. horizontal) incliné
  const inX = (s.contentWidth / 2) * Math.cos(t) - (s.contentHeight / 2) * Math.sin(t);
  const inY = (s.contentHeight / 2) * Math.cos(t) - (s.contentWidth / 2) * Math.sin(t);
  const m = 0.01 * Math.max(canvasW, canvasH);
  if (s.edges.right && slot.cx >= 0.5) cx = Math.max(cx, canvasW + m - inX);
  if (s.edges.left && slot.cx < 0.5) cx = Math.min(cx, -m + inX);
  if (s.edges.bottom && slot.cy >= 0.5) cy = Math.max(cy, canvasH + m - inY);
  if (s.edges.top && slot.cy < 0.5) cy = Math.min(cy, -m + inY);
  return { cx, cy };
}

/** Calque posé au centre (cx, cy), rogné aux bords du canevas : le sujet peut déborder du cadre. */
export async function placeCentered(
  s: Pick<Sticker, 'png' | 'width' | 'height'>,
  cx: number,
  cy: number,
  canvasW: number,
  canvasH: number,
): Promise<OverlayOptions | null> {
  const left = Math.round(cx - s.width / 2);
  const top = Math.round(cy - s.height / 2);
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(canvasW, left + s.width);
  const y1 = Math.min(canvasH, top + s.height);
  if (x1 <= x0 || y1 <= y0) return null;
  const input = await sharp(s.png)
    .extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 })
    .png()
    .toBuffer();
  return { input, left: x0, top: y0 };
}

// ─── Mise en page ────────────────────────────────────────────────────────────

interface Slot {
  cx: number;
  cy: number;
  /** Hauteur visée, en fraction de la hauteur du canevas */
  height: number;
  /** Largeur max, en fraction de la largeur du canevas */
  maxWidth: number;
  tiltDeg: number;
}

export interface DuoLayout {
  /** Le produit (booster, display) */
  hero: Slot;
  /** La carte hit */
  secondary: Slot;
  /** Produit seul, sans carte */
  solo: Slot;
  label: { cx: number; cy: number; fontSize: number; maxWidth: number; tiltDeg: number };
  /**
   * Flèche vers la carte : la pointe touche le bord gauche de la carte à `tipY` (fraction de sa
   * hauteur), le départ est décalé de `from` (fractions du canevas) ; épaisseur en fraction de la hauteur.
   */
  arrow: { tipY: number; from: [number, number]; bend: number; thickness: number };
  /** Épaisseur du liseré et rayon de la lueur, en fraction de la hauteur */
  outline: number;
  glow: number;
  logo: { x: number; y: number; w: number };
}

export const DUO_LAYOUTS: Record<ThumbnailFormat, DuoLayout> = {
  // Horizontal : produit à gauche, carte à droite, étiquette en bas au centre
  // (le coin bas-droit reste libre : YouTube y affiche la durée)
  '16x9': {
    hero: { cx: 0.29, cy: 0.5, height: 1.02, maxWidth: 0.44, tiltDeg: -6 },
    secondary: { cx: 0.73, cy: 0.46, height: 0.86, maxWidth: 0.42, tiltDeg: 7 },
    solo: { cx: 0.5, cy: 0.46, height: 0.94, maxWidth: 0.8, tiltDeg: -4 },
    label: { cx: 0.5, cy: 0.86, fontSize: 0.1, maxWidth: 0.72, tiltDeg: -3 },
    arrow: { tipY: 0.3, from: [-0.12, -0.17], bend: -0.35, thickness: 0.018 },
    outline: 0.011,
    glow: 0.05,
    logo: { x: 0.03, y: 0.04, w: 0.1 },
  },
  // Vertical : produit en haut à gauche, carte en bas à droite qui le chevauche, étiquette
  // dans le 3:4 central (la grille de profil TikTok/Instagram rogne le haut et le bas)
  '9x16': {
    hero: { cx: 0.37, cy: 0.32, height: 0.48, maxWidth: 0.7, tiltDeg: -7 },
    secondary: { cx: 0.64, cy: 0.67, height: 0.4, maxWidth: 0.62, tiltDeg: 7 },
    solo: { cx: 0.5, cy: 0.44, height: 0.6, maxWidth: 0.9, tiltDeg: -4 },
    label: { cx: 0.5, cy: 0.83, fontSize: 0.058, maxWidth: 0.88, tiltDeg: -3 },
    arrow: { tipY: 0.45, from: [-0.3, -0.04], bend: 0.3, thickness: 0.011 },
    outline: 0.0065,
    glow: 0.03,
    logo: { x: 0.05, y: 0.04, w: 0.18 },
  },
};

const LABEL_FONT = '"Arial Black", "Segoe UI Black", Impact, sans-serif';

/** Fond : dégradé radial dans la couleur du produit, faisceaux de lumière, explosion derrière le produit. */
function backgroundSvg(width: number, height: number, fx: number, fy: number, pal: DuoPalette) {
  const r = Math.hypot(width, height);
  const beams = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2 + 0.2;
    const spread = i % 2 === 0 ? 0.09 : 0.045;
    const p = (angle: number) =>
      `${(fx + Math.cos(angle) * r).toFixed(0)},${(fy + Math.sin(angle) * r).toFixed(0)}`;
    return `<polygon points="${fx.toFixed(0)},${fy.toFixed(0)} ${p(a - spread)} ${p(a + spread)}" fill="#ffffff" opacity="${i % 2 === 0 ? 0.07 : 0.04}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <radialGradient id="bg" cx="${fx}" cy="${fy}" r="${(r * 0.7).toFixed(0)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${pal.mid}"/>
      <stop offset="1" stop-color="${pal.dark}"/>
    </radialGradient>
    <radialGradient id="burst" cx="${fx}" cy="${fy}" r="${(Math.min(width, height) * 0.62).toFixed(0)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${pal.burst}" stop-opacity="0.95"/>
      <stop offset="0.45" stop-color="${pal.burst}" stop-opacity="0.35"/>
      <stop offset="1" stop-color="${pal.burst}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <g>${beams}</g>
  <rect width="${width}" height="${height}" fill="url(#burst)"/>
</svg>`;
}

function vignetteSvg(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <radialGradient id="v" cx="0.5" cy="0.5" r="0.75">
      <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.6"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#v)"/>
</svg>`;
}

/**
 * Texte en PNG transparent rogné au plus près des lettres : police de marque (fichier) si le compte
 * en déclare une, sinon police système via SVG. La largeur est donc mesurée, jamais estimée.
 */
export async function renderLabelText(
  text: string,
  sizePx: number,
  color: string,
  fontFile?: string,
): Promise<{ png: Buffer; width: number; height: number }> {
  if (fontFile) return renderTextWithFont(text, fontFile, sizePx, color);
  const w = Math.ceil(sizePx * (text.length + 2));
  const h = Math.ceil(sizePx * 1.8);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><text x="${sizePx / 2}" y="${sizePx * 1.3}" font-family='${LABEL_FONT}' font-weight="900" font-size="${sizePx}" fill="${color}">${escapeXml(text)}</text></svg>`;
  const { data, info } = await sharp(Buffer.from(svg))
    .trim()
    .png()
    .toBuffer({ resolveWithObject: true });
  return { png: data, width: info.width, height: info.height };
}

/** Étiquette : texte court dans un bloc plein incliné, avec ombre ; police réduite si trop large. */
async function labelImage(
  width: number,
  height: number,
  text: string,
  box: DuoLayout['label'],
  fill: string,
  color: string,
  fontFile: string | undefined,
): Promise<Pick<Sticker, 'png' | 'width' | 'height'>> {
  const maxFont = box.fontSize * height;
  const maxW = box.maxWidth * width;
  let font = maxFont;
  let t = await renderLabelText(text, font, color, fontFile);
  while (t.width + font * 0.84 > maxW && font > maxFont * 0.45) {
    font = Math.floor(font * 0.92);
    t = await renderLabelText(text, font, color, fontFile);
  }
  const boxW = Math.round(t.width + font * 0.84);
  const boxH = Math.round(Math.max(font * 1.3, t.height + font * 0.5));
  const off = Math.round(font * 0.09);
  const m = Math.ceil(font * 0.05);
  const rx = (font * 0.2).toFixed(1);
  const canvasW = boxW + off + m * 2;
  const canvasH = boxH + off + m * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">
  <rect x="${m + off}" y="${m + off}" width="${boxW}" height="${boxH}" rx="${rx}" fill="#000" opacity="0.5"/>
  <rect x="${m}" y="${m}" width="${boxW}" height="${boxH}" rx="${rx}" fill="${fill}" stroke="#000" stroke-opacity="0.85" stroke-width="${(font * 0.05).toFixed(1)}"/>
</svg>`;
  const composed = await sharp(Buffer.from(svg))
    .composite([
      {
        input: t.png,
        left: Math.round(m + (boxW - t.width) / 2),
        top: Math.round(m + (boxH - t.height) / 2),
      },
    ])
    .png()
    .toBuffer();
  const png = await sharp(composed)
    .rotate(box.tiltDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const meta = await sharp(png).metadata();
  return { png, width: meta.width ?? canvasW, height: meta.height ?? canvasH };
}

/** Flèche courbe blanche cernée de noir, de `from` vers `to` en pixels (courbure `bend`, signe = côté). */
export function arrowSvg(
  width: number,
  height: number,
  from: [number, number],
  to: [number, number],
  bend: number,
  thickness: number,
): string {
  const [x0, y0] = from;
  const [x1, y1] = to;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy) || 1;
  const qx = (x0 + x1) / 2 - (dy / dist) * bend * dist;
  const qy = (y0 + y1) / 2 + (dx / dist) * bend * dist;
  const t = thickness * height;
  const ang = Math.atan2(y1 - qy, x1 - qx);
  const headLen = t * 2.8;
  const headW = t * 2.6;
  const bx = x1 - Math.cos(ang) * headLen;
  const by = y1 - Math.sin(ang) * headLen;
  const px = -Math.sin(ang) * (headW / 2);
  const py = Math.cos(ang) * (headW / 2);
  const shaft = `M ${x0.toFixed(1)} ${y0.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${(bx + Math.cos(ang) * t * 0.4).toFixed(1)} ${(by + Math.sin(ang) * t * 0.4).toFixed(1)}`;
  const head = `${x1.toFixed(1)},${y1.toFixed(1)} ${(bx + px).toFixed(1)},${(by + py).toFixed(1)} ${(bx - px).toFixed(1)},${(by - py).toFixed(1)}`;
  const o = t * 0.35;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <path d="${shaft}" fill="none" stroke="#000" stroke-width="${(t + o * 2).toFixed(1)}" stroke-linecap="round"/>
  <polygon points="${head}" fill="#000" stroke="#000" stroke-width="${(o * 2).toFixed(1)}" stroke-linejoin="round"/>
  <path d="${shaft}" fill="none" stroke="#fff" stroke-width="${t.toFixed(1)}" stroke-linecap="round"/>
  <polygon points="${head}" fill="#fff"/>
</svg>`;
}

/** Gros « ? » blanc cerné de noir, posé sur la carte floutée de la variante teaser. */
async function questionMark(size: number, fontFile: string | undefined): Promise<Sticker> {
  const t = await renderLabelText('?', size, '#ffffff', fontFile);
  return prepareSticker(t.png, {
    heightPx: t.height,
    maxWidthPx: t.width * 2,
    tiltDeg: 0,
    outline: { color: '#000000', widthPx: size * 0.05 },
  });
}

export interface ComposeDuoOptions {
  /** Produit détouré (PNG transparent) ou image opaque */
  hero: Buffer;
  /** Carte hit détourée, ou null (produit seul) */
  secondary: Buffer | null;
  format: ThumbnailFormat;
  template: ThumbnailTemplate;
  brand: AccountConfig['brand'];
  title: string;
  /** Variante teaser : la carte est floutée et marquée d'un « ? » */
  tease?: boolean | undefined;
  logo?: Buffer | undefined;
  /** Police de marque (fichier .ttf/.otf) pour l'étiquette et le « ? » ; sinon police système */
  fontFile?: string | undefined;
}

export async function composeDuoThumbnail(
  o: ComposeDuoOptions,
): Promise<{ png: Buffer; width: number; height: number; palette: DuoPalette }> {
  const { width, height } = THUMBNAIL_SIZES[o.format];
  const layout = DUO_LAYOUTS[o.format];
  const brandHue = hexToHsl(resolveColor(o.template.colors.highlight, o.brand)).h;
  const heroHue = (await dominantHue(o.hero)) ?? brandHue;
  const secondaryHue = o.secondary ? ((await dominantHue(o.secondary)) ?? brandHue) : brandHue;
  const pal = duoPalette(heroHue, secondaryHue);
  const heroSlot = o.secondary ? layout.hero : layout.solo;
  const outline = { color: '#ffffff', widthPx: layout.outline * height };

  const hero = await prepareSticker(o.hero, {
    heightPx: heroSlot.height * height,
    maxWidthPx: heroSlot.maxWidth * width,
    tiltDeg: heroSlot.tiltDeg,
    outline,
    shadow: true,
  });

  const layers: OverlayOptions[] = [];
  const push = (l: OverlayOptions | null) => {
    if (l) layers.push(l);
  };

  // Texture : le produit lui-même, très agrandi et flou, teinte le fond de ses propres couleurs
  // Canal alpha matérialisé à part : Sharp applique linear() avant ensureAlpha() dans un même pipeline
  const heroRgba = await sharp(o.hero).ensureAlpha().png().toBuffer();
  const texture = await sharp(heroRgba)
    .trim({ threshold: 6 })
    .resize({ height: Math.round(height * 1.3) })
    .blur(Math.max(8, height * 0.04))
    .linear([1, 1, 1, 0.4], [0, 0, 0, 0])
    .png()
    .toBuffer();
  const tm = await sharp(texture).metadata();
  push(
    await placeCentered(
      { png: texture, width: tm.width ?? 0, height: tm.height ?? 0 },
      heroSlot.cx * width,
      heroSlot.cy * height,
      width,
      height,
    ),
  );
  layers.push({ input: Buffer.from(vignetteSvg(width, height)) });

  const heroAt = bleedCenter(heroSlot, hero, width, height);
  if (o.secondary) {
    const slot = layout.secondary;
    const card = await prepareSticker(o.secondary, {
      heightPx: slot.height * height,
      maxWidthPx: slot.maxWidth * width,
      tiltDeg: slot.tiltDeg,
      outline: o.tease ? undefined : outline,
      glow: { color: pal.glow, radiusPx: layout.glow * height, strength: 2.4 },
      blurPx: o.tease ? Math.max(6, height * 0.018) : undefined,
    });
    const cardAt = bleedCenter(slot, card, width, height);
    push(await placeCentered(hero, heroAt.cx, heroAt.cy, width, height));
    push(await placeCentered(card, cardAt.cx, cardAt.cy, width, height));
    if (o.tease) {
      // Centré sur la partie visible du sujet (la main qui sort du cadre ne compte pas)
      const x0 = Math.max(0, cardAt.cx - card.contentWidth / 2);
      const x1 = Math.min(width, cardAt.cx + card.contentWidth / 2);
      const y0 = Math.max(0, cardAt.cy - card.contentHeight / 2);
      const y1 = Math.min(height, cardAt.cy + card.contentHeight / 2);
      const q = await questionMark(card.contentHeight * 0.45, o.fontFile);
      push(await placeCentered(q, (x0 + x1) / 2, (y0 + y1) / 2, width, height));
    }
    if (o.template.duo.arrow) {
      const a = layout.arrow;
      const tip: [number, number] = [
        cardAt.cx - card.contentWidth / 2 - 0.012 * width,
        cardAt.cy - card.contentHeight / 2 + a.tipY * card.contentHeight,
      ];
      const from: [number, number] = [tip[0] + a.from[0] * width, tip[1] + a.from[1] * height];
      layers.push({
        input: Buffer.from(arrowSvg(width, height, from, tip, a.bend, a.thickness)),
      });
    }
  } else {
    push(await placeCentered(hero, heroAt.cx, heroAt.cy, width, height));
  }

  const text = o.template.font.uppercase ? o.title.toLocaleUpperCase('fr-FR') : o.title;
  if (text.trim()) {
    const fill = resolveColor(o.template.duo.label.fill, o.brand);
    const color = resolveColor(o.template.duo.label.text, o.brand);
    const label = await labelImage(
      width,
      height,
      text.trim(),
      layout.label,
      fill,
      color,
      o.fontFile,
    );
    push(
      await placeCentered(label, layout.label.cx * width, layout.label.cy * height, width, height),
    );
  }

  if (o.logo) {
    const logoPng = await sharp(o.logo)
      .resize({ width: Math.round(layout.logo.w * width) })
      .png()
      .toBuffer();
    layers.push({
      input: logoPng,
      left: Math.round(layout.logo.x * width),
      top: Math.round(layout.logo.y * height),
    });
  }

  const png = await sharp(
    Buffer.from(backgroundSvg(width, height, heroSlot.cx * width, heroSlot.cy * height, pal)),
  )
    .composite(layers)
    .png()
    .toBuffer();
  return { png, width, height, palette: pal };
}
