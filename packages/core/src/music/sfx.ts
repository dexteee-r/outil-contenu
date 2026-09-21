import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Bibliothèque d'effets sonores : `sfx/sfx.json` à la racine du repo, un fichier par type d'effet
 * de l'EDL (`hit` = révélation / surprise). Sans fichier, le pipeline génère un son de substitution.
 */
export const sfxIndexSchema = z
  .object({
    hit: z
      .object({
        file: z.string().min(1),
        license: z.string().min(1),
        source: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SfxIndex = z.infer<typeof sfxIndexSchema>;

export const SFX_INDEX_FILE = 'sfx.json';

export function sfxDir(repoRoot: string): string {
  return path.join(repoRoot, 'sfx');
}

export function loadSfxIndex(dir: string): SfxIndex {
  const file = path.join(dir, SFX_INDEX_FILE);
  if (!fs.existsSync(file)) return {};
  return sfxIndexSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Chemin absolu du son « hit » de la bibliothèque, ou null s'il n'est pas déclaré / absent. */
export function hitSfxPath(dir: string, index: SfxIndex = loadSfxIndex(dir)): string | null {
  if (!index.hit) return null;
  const file = path.join(dir, index.hit.file);
  return fs.existsSync(file) ? file : null;
}
