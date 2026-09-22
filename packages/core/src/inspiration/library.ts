import fs from 'node:fs';
import path from 'node:path';
import { INSPIRATION_INDEX, type InspirationEntry } from './youtube.js';

/**
 * Bibliothèque d'inspiration d'un compte : les images de accounts/<slug>/inspiration/ et leur
 * index. Sert la page web locale (lister, ajouter une capture, supprimer).
 */

export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export interface InspirationImage {
  name: string;
  bytes: number;
  addedAt: string;
  /** Présent pour les miniatures YouTube récupérées */
  source?: { url: string; title: string | null; channel: string | null };
}

export function inspirationDir(accountsDir: string, account: string): string {
  return path.join(accountsDir, account, 'inspiration');
}

/** Nom de fichier sûr : pas de chemin, pas de caractères interdits sous Windows, extension image. */
export function safeImageName(name: string): string | null {
  const base = path.basename(name.replace(/\\/g, '/'));
  if (base !== name || base.startsWith('.')) return null;
  if (!IMAGE_EXTENSIONS.has(path.extname(base).toLowerCase())) return null;
  // Caractères interdits par Windows, y compris les caractères de contrôle (code < 32)
  if (/[<>:"/\\|?*]/.test(base) || [...base].some((c) => c.charCodeAt(0) < 32)) return null;
  return base;
}

function readIndex(dir: string): InspirationEntry[] {
  const file = path.join(dir, INSPIRATION_INDEX);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as InspirationEntry[];
  } catch {
    return [];
  }
}

/** Images présentes, les plus récentes d'abord, enrichies de leur source YouTube si connue. */
export function listInspiration(dir: string): InspirationImage[] {
  if (!fs.existsSync(dir)) return [];
  const index = readIndex(dir);
  const sourceOf = new Map<string, InspirationEntry>();
  for (const e of index) for (const f of e.files) sourceOf.set(path.basename(f.file), e);
  return fs
    .readdirSync(dir)
    .filter((n) => IMAGE_EXTENSIONS.has(path.extname(n).toLowerCase()))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      const entry = sourceOf.get(name);
      const img: InspirationImage = { name, bytes: stat.size, addedAt: stat.mtime.toISOString() };
      if (entry) img.source = { url: entry.url, title: entry.title, channel: entry.channel };
      return img;
    })
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

/** Reconnaît PNG, JPEG et WebP par leurs premiers octets (on ne fait pas confiance à l'extension). */
export function detectImageType(buf: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'webp';
  return null;
}

/** Enregistre une capture déposée par l'utilisateur ; le nom est rendu unique si besoin. */
export function saveUploadedImage(dir: string, requestedName: string, data: Buffer): string {
  const type = detectImageType(data);
  if (!type) throw new Error('fichier non reconnu comme image (PNG, JPEG ou WebP)');
  if (data.length > MAX_UPLOAD_BYTES) throw new Error('image trop lourde (15 Mo max)');
  const stem =
    path
      .basename(requestedName, path.extname(requestedName))
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'capture';
  fs.mkdirSync(dir, { recursive: true });
  let name = `${stem}.${type}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${stem}-${i}.${type}`;
  fs.writeFileSync(path.join(dir, name), data);
  return name;
}

/** Supprime une image de la bibliothèque et la retire de l'index. */
export function removeInspiration(dir: string, name: string): void {
  const safe = safeImageName(name);
  if (!safe) throw new Error(`nom de fichier refusé : ${name}`);
  const file = path.join(dir, safe);
  if (!fs.existsSync(file)) throw new Error(`image introuvable : ${safe}`);
  fs.rmSync(file);
  const index = readIndex(dir);
  if (index.length) {
    const next = index
      .map((e) => ({ ...e, files: e.files.filter((f) => path.basename(f.file) !== safe) }))
      .filter((e) => e.files.length > 0);
    fs.writeFileSync(path.join(dir, INSPIRATION_INDEX), JSON.stringify(next, null, 2));
  }
}
