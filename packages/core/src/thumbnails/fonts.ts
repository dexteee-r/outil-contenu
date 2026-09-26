import fs from 'node:fs';
import sharp from 'sharp';

/**
 * Polices de marque en fichier (accounts/<slug>/brand/fonts/*.ttf|otf) : le moteur SVG de Sharp ne
 * voit que les polices installées dans le système ; le texte est donc rendu par Pango avec
 * `fontfile`, qui exige le nom de famille exact inscrit dans le fichier — lu dans la table `name`.
 */

export interface FontNames {
  /** Famille (« Montserrat », « Burbank Big Condensed ») */
  family: string;
  /** Style (« Black », « Bold », « Regular ») */
  style: string;
}

/** Lit famille et style dans la table `name` d'un fichier TrueType / OpenType (null si illisible). */
export function readFontNames(file: string): FontNames | null {
  const buf = fs.readFileSync(file);
  if (buf.length < 12) return null;
  const numTables = buf.readUInt16BE(4);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > buf.length) return null;
    if (buf.toString('latin1', rec, rec + 4) === 'name') nameOffset = buf.readUInt32BE(rec + 8);
  }
  if (nameOffset < 0 || nameOffset + 6 > buf.length) return null;
  const count = buf.readUInt16BE(nameOffset + 2);
  const strings = nameOffset + buf.readUInt16BE(nameOffset + 4);
  const found = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const r = nameOffset + 6 + i * 12;
    if (r + 12 > buf.length) break;
    const platform = buf.readUInt16BE(r);
    const encoding = buf.readUInt16BE(r + 2);
    const nameId = buf.readUInt16BE(r + 6);
    const length = buf.readUInt16BE(r + 8);
    const offset = strings + buf.readUInt16BE(r + 10);
    if (![1, 2, 16, 17].includes(nameId) || offset + length > buf.length) continue;
    let text: string | null = null;
    if (platform === 3 && (encoding === 1 || encoding === 10)) {
      // Windows : UTF-16 big-endian
      const bytes = Buffer.from(buf.subarray(offset, offset + length));
      bytes.swap16();
      text = bytes.toString('utf16le');
    } else if (platform === 1 && encoding === 0) {
      text = buf.toString('latin1', offset, offset + length);
    }
    // Windows prime sur Mac ; on garde la première entrée Windows trouvée
    if (text && (!found.has(nameId) || platform === 3)) found.set(nameId, text);
  }
  // 1/2 = famille/style « courts », ceux que fontconfig apparie (« Burbank Big Cd Bd »,
  // « Montserrat Black ») ; 16/17 (typographiques, « Burbank Big Condensed » / « Bold ») en repli
  const family = found.get(1) ?? found.get(16);
  const style = (found.get(1) ? found.get(2) : found.get(17)) ?? 'Regular';
  return family ? { family, style } : null;
}

/** Description Pango (« Montserrat Black 120 ») ; le style normal (Regular, Normal…) est implicite. */
export function pangoFont(names: FontNames, sizePx: number): string {
  const style = /^(regular|normal|book|roman)$/i.test(names.style) ? '' : ` ${names.style}`;
  return `${names.family}${style} ${Math.round(sizePx)}`;
}

function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Texte rendu avec un fichier de police, en PNG transparent rogné au plus près des lettres.
 * `sizePx` = taille de police en pixels (dpi 72).
 */
export async function renderTextWithFont(
  text: string,
  fontFile: string,
  sizePx: number,
  color: string,
): Promise<{ png: Buffer; width: number; height: number }> {
  const names = readFontNames(fontFile);
  if (!names) throw new Error(`police illisible : ${fontFile}`);
  const raw = await sharp({
    text: {
      text: `<span foreground="${color}">${escapeMarkup(text)}</span>`,
      font: pangoFont(names, sizePx),
      fontfile: fontFile,
      rgba: true,
      dpi: 72,
    },
  })
    .png()
    .toBuffer();
  const { data, info } = await sharp(raw).trim().png().toBuffer({ resolveWithObject: true });
  return { png: data, width: info.width, height: info.height };
}
