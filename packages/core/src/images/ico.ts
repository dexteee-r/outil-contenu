import sharp from 'sharp';

/**
 * Fabrication d'icônes .ico (zone de notification Windows, raccourci) sans dépendance de plus.
 * Images en BMP 32 bits avec alpha jusqu'à 128 px, PNG pour 256 px — comme les icônes de Windows :
 * System.Drawing (le tray PowerShell) lit mal les images PNG des petites tailles (couleurs
 * aberrantes, constaté à l'étape 9).
 */

export const ICO_SIZES = [16, 20, 24, 32, 48, 256] as const;

export interface IcoImage {
  /** Largeur = hauteur, en pixels (256 max) */
  size: number;
  /** Image encodée : PNG, ou BMP sans en-tête de fichier (voir `rgbaToDib`) */
  data: Buffer;
}

const HEADER_SIZE = 6;
const ENTRY_SIZE = 16;

/** Empaquette des images carrées dans un conteneur .ico. */
export function packIco(images: IcoImage[]): Buffer {
  if (images.length === 0) throw new Error('au moins une image requise');
  for (const img of images) {
    if (!Number.isInteger(img.size) || img.size < 1 || img.size > 256) {
      throw new Error(`taille invalide : ${img.size} (1 à 256)`);
    }
  }

  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt16LE(0, 0); // réservé
  header.writeUInt16LE(1, 2); // type 1 = icône
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(ENTRY_SIZE * images.length);
  let offset = HEADER_SIZE + entries.length;
  images.forEach((img, i) => {
    const e = i * ENTRY_SIZE;
    entries.writeUInt8(img.size === 256 ? 0 : img.size, e); // 0 signifie 256
    entries.writeUInt8(img.size === 256 ? 0 : img.size, e + 1);
    entries.writeUInt8(0, e + 2); // palette
    entries.writeUInt8(0, e + 3); // réservé
    entries.writeUInt16LE(1, e + 4); // plans
    entries.writeUInt16LE(32, e + 6); // bits par pixel
    entries.writeUInt32LE(img.data.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });

  return Buffer.concat([header, entries, ...images.map((i) => i.data)]);
}

/**
 * Image BMP d'icône : en-tête BITMAPINFOHEADER (hauteur doublée), pixels BGRA de bas en haut,
 * puis masque ET à zéro (la transparence vient du canal alpha).
 */
export function rgbaToDib(size: number, rgba: Buffer): Buffer {
  if (rgba.length !== size * size * 4) throw new Error(`image ${size} px : pixels incomplets`);
  const maskRow = Math.ceil(size / 32) * 4;
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(size, 4);
  info.writeInt32LE(size * 2, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(32, 14);
  info.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = ((size - 1 - y) * size + x) * 4;
      pixels[dst] = rgba[src + 2]!;
      pixels[dst + 1] = rgba[src + 1]!;
      pixels[dst + 2] = rgba[src]!;
      pixels[dst + 3] = rgba[src + 3]!;
    }
  }
  return Buffer.concat([info, pixels, Buffer.alloc(maskRow * size)]);
}

/** Lit l'annuaire d'un .ico (pour les tests et l'inspection). */
export function readIcoDirectory(ico: Buffer): { size: number; bytes: number; offset: number }[] {
  if (ico.readUInt16LE(2) !== 1) throw new Error('pas un fichier .ico');
  const count = ico.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const e = HEADER_SIZE + i * ENTRY_SIZE;
    const w = ico.readUInt8(e);
    return {
      size: w === 0 ? 256 : w,
      bytes: ico.readUInt32LE(e + 8),
      offset: ico.readUInt32LE(e + 12),
    };
  });
}

/** Rend un SVG (fonction de la taille) à chaque taille, puis l'empaquette en .ico. */
export async function svgToIco(
  svgForSize: (size: number) => string,
  sizes: readonly number[] = ICO_SIZES,
): Promise<Buffer> {
  const images = await Promise.all(
    sizes.map(async (size) => {
      const img = sharp(Buffer.from(svgForSize(size))).resize(size, size);
      const data =
        size >= 256
          ? await img.png().toBuffer()
          : rgbaToDib(size, await img.ensureAlpha().raw().toBuffer());
      return { size, data };
    }),
  );
  return packIco(images);
}
