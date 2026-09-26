import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Bibliothèque musicale libre de droits : `music/music.json` à la racine du repo, alimenté par
 * Markus. Le pipeline choisit une piste selon le mood et le tempo demandés par l'EDL.
 */

export const musicTrackSchema = z
  .object({
    /** Chemin relatif au dossier music/ */
    file: z.string().min(1),
    title: z.string().min(1),
    moods: z.array(z.string().min(1)).min(1),
    bpm: z.number().int().positive(),
    durationSec: z.number().positive(),
    /** Licence et source, pour pouvoir prouver le droit d'usage */
    license: z.string().min(1),
    source: z.string().optional(),
    /** Piste protégée (risque Content ID) : choisie seulement si aucune piste libre ne convient */
    restricted: z.boolean().optional(),
    /** Crédit à mettre en description quand la licence l'exige */
    credit: z.string().optional(),
  })
  .strict();
export type MusicTrack = z.infer<typeof musicTrackSchema>;

export const musicIndexSchema = z.object({ tracks: z.array(musicTrackSchema) }).strict();
export type MusicIndex = z.infer<typeof musicIndexSchema>;

export const MUSIC_INDEX_FILE = 'music.json';

export function musicDir(repoRoot: string): string {
  return path.join(repoRoot, 'music');
}

/** Charge l'index ; un index absent vaut bibliothèque vide (pas une erreur). */
export function loadMusicIndex(dir: string): MusicIndex {
  const file = path.join(dir, MUSIC_INDEX_FILE);
  if (!fs.existsSync(file)) return { tracks: [] };
  return musicIndexSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export interface MusicRequest {
  mood: string;
  tempoRange: { min: number; max: number };
  /** La piste doit couvrir au moins cette durée */
  minDurationSec: number;
}

/**
 * Meilleure piste pour la demande : mood exact requis ; durée suffisante requise ; les pistes
 * libres passent avant les pistes protégées (`restricted`) ; puis tempo dans la plage (sinon
 * pénalité selon l'écart). Renvoie null si aucune piste ne convient.
 */
export function selectTrack(index: MusicIndex, req: MusicRequest): MusicTrack | null {
  const mood = req.mood.toLowerCase();
  const candidates = index.tracks.filter(
    (t) => t.moods.some((m) => m.toLowerCase() === mood) && t.durationSec >= req.minDurationSec,
  );
  if (candidates.length === 0) return null;
  const distance = (t: MusicTrack) => {
    if (t.bpm >= req.tempoRange.min && t.bpm <= req.tempoRange.max) return 0;
    return Math.min(Math.abs(t.bpm - req.tempoRange.min), Math.abs(t.bpm - req.tempoRange.max));
  };
  const rank = (t: MusicTrack) => (t.restricted ? 1000 : 0) + distance(t);
  return candidates.slice().sort((a, b) => rank(a) - rank(b))[0]!;
}
