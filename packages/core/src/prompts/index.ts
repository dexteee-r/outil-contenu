import fs from 'node:fs';
import path from 'node:path';
import type { ContentType } from '../config/account.js';
import type { ClipInfo } from '../schemas/tagging.js';

/**
 * Prompts versionnés dans `prompts/` à la racine du repo (partagés entre comptes).
 * Les prompts propres à un compte (légendes) vivent dans `accounts/<slug>/prompts/`.
 */

export function promptsDir(repoRoot: string): string {
  return path.join(repoRoot, 'prompts');
}

export function loadPrompt(name: string, dir: string): string {
  const file = path.join(dir, `${name}.md`);
  if (!fs.existsSync(file)) throw new Error(`prompt introuvable : ${file}`);
  return fs.readFileSync(file, 'utf8').trim();
}

/** Prompt additionnel par type de contenu ; `generic` n'en a pas. */
export const TAGGING_ADDENDUM: Record<ContentType, string | null> = {
  'tcg-opening': 'tagging-tcg-opening',
  'nature-walk': 'tagging-nature-walk',
  generic: null,
};

export function describeClips(clips: ClipInfo[]): string {
  return clips
    .map(
      (c, i) =>
        `${i + 1}. clipId "${c.id}" — ${c.durationSec.toFixed(1)} s, ${c.width}x${c.height}${c.hasAudio ? '' : ', sans piste audio'}`,
    )
    .join('\n');
}

/** Texte complet du prompt de tagging : générique + spécifique au type + liste des clips. */
export function buildTaggingPrompt(params: {
  contentType: ContentType;
  clips: ClipInfo[];
  dir: string;
}): string {
  const parts = [loadPrompt('tagging-generic', params.dir)];
  const addendum = TAGGING_ADDENDUM[params.contentType];
  if (addendum) parts.push(loadPrompt(addendum, params.dir));
  parts.push(
    `## Clips fournis\n\n${describeClips(params.clips)}\n\nChaque vidéo est précédée d'un texte « clip <clipId> ».`,
  );
  return parts.join('\n\n');
}
