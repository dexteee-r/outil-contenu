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
 * Meilleure piste pour la demande : mood exact requis ; tempo dans la plage (sinon pénalité selon
 * l'écart) ; durée suffisante requise. Renvoie null si aucune piste ne convient.
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
  return candidates.slice().sort((a, b) => distance(a) - distance(b))[0]!;
}
