import { randomBytes } from 'node:crypto';
import path from 'node:path';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Identifiant de contenu : `<compte>-<date>-<4 hex>`, ex. `tcg-2026-08-05-a3f9`.
 * La date vient du nom du sous-dossier de /raw quand il est daté (convention du cahier),
 * sinon du jour courant.
 */
export function makeContentId(
  account: string,
  sourceDir: string,
  now: Date = new Date(),
  suffix: string = randomBytes(2).toString('hex'),
): string {
  const folder = path.basename(sourceDir);
  const date = DATE_RE.test(folder) ? folder : now.toISOString().slice(0, 10);
  return `${account}-${date}-${suffix}`;
}

/** Extensions de rushs acceptées à l'ingestion. */
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

export function isVideoFile(file: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase());
}
