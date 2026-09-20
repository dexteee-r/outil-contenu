import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { clipInfoSchema, type ClipInfo } from './tagging.js';
import { edlSchema, type Edl } from './edl.js';

/** Dossier `fixtures/` à la racine du repo. */
export const FIXTURES_DIR = fileURLToPath(new URL('../../../../fixtures/', import.meta.url));

function readJson(...segments: string[]): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, ...segments), 'utf8')) as unknown;
}

/** Clips et EDL de référence (écrits à la main) : base du spike S2 et des tests de rendu. */
export function loadReferenceClips(): ClipInfo[] {
  return z.array(clipInfoSchema).parse(readJson('reference', 'clips.json'));
}

export function loadReferenceEdl(): Edl {
  return edlSchema.parse(readJson('reference', 'edl.json'));
}
