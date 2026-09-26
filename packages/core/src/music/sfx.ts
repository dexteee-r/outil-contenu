import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Bibliothèque d'effets sonores : `sfx/sfx.json` à la racine du repo, un fichier par type de son
 * d'habillage. `hit` = révélation / surprise ; `riser` = montée de tension qui aboutit au hit ;
 * `whoosh` = changement de plan ; `pop` = apparition d'un texte. Sans `hit`, le pipeline génère
 * un son de substitution ; sans les autres, ils sont simplement omis.
 */
export const SFX_KINDS = ['hit', 'riser', 'whoosh', 'pop'] as const;
export type SfxKindName = (typeof SFX_KINDS)[number];

const sfxEntrySchema = z
  .object({
    /** Chemin relatif au dossier sfx/ */
    file: z.string().min(1),
    license: z.string().min(1),
    source: z.string().optional(),
  })
  .strict();

export const sfxIndexSchema = z
  .object({
    hit: sfxEntrySchema.optional(),
    riser: sfxEntrySchema.optional(),
    whoosh: sfxEntrySchema.optional(),
    pop: sfxEntrySchema.optional(),
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

/** Chemin absolu d'un son de la bibliothèque, ou null s'il n'est pas déclaré / absent. */
export function sfxPathFor(
  dir: string,
  kind: SfxKindName,
  index: SfxIndex = loadSfxIndex(dir),
): string | null {
  const entry = index[kind];
  if (!entry) return null;
  const file = path.join(dir, entry.file);
  return fs.existsSync(file) ? file : null;
}

/** Chemin absolu du son « hit » de la bibliothèque, ou null s'il n'est pas déclaré / absent. */
export function hitSfxPath(dir: string, index: SfxIndex = loadSfxIndex(dir)): string | null {
  return sfxPathFor(dir, 'hit', index);
}
