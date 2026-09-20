import sharp from 'sharp';

/**
 * Fabrication d'icônes .ico pour la zone de notification Windows.
 * Un .ico moderne peut contenir directement des PNG (Vista+) : on empaquette
 * plusieurs tailles rendues par sharp, sans dépendance supplémentaire.
 */

export const ICO_SIZES = [16, 32, 48, 256] as const;

export interface IcoImage {
  /** Largeur = hauteur, en pixels (256 max) */
  size: number;
  /** Données PNG */
  png: Buffer;
}

const HEADER_SIZE = 6;
const ENTRY_SIZE = 16;

/** Empaquette des PNG carrés dans un conteneur .ico. */
export function pngsToIco(images: IcoImage[]): Buffer {
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
    entries.writeUInt32LE(img.png.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += img.png.length;
  });

  return Buffer.concat([header, entries, ...images.map((i) => i.png)]);
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

/** Rend un SVG (fonction de la taille) en PNG aux tailles standard, puis en .ico. */
export async function svgToIco(
  svgForSize: (size: number) => string,
  sizes: readonly number[] = ICO_SIZES,
): Promise<Buffer> {
  const images = await Promise.all(
    sizes.map(async (size) => ({
      size,
      png: await sharp(Buffer.from(svgForSize(size)))
        .resize(size, size)
        .png()
        .toBuffer(),
    })),
  );
  return pngsToIco(images);
}
