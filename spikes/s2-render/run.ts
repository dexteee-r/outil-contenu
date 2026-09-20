/**
 * Spike S2 — rendu Remotion 1080x1920 de l'EDL de référence.
 *
 * Questions : le pipeline EDL → timeline → MP4 fonctionne-t-il de bout en bout (coupes, vitesse,
 * overlays, musique avec fondu) ? Combien de temps prend le rendu sur ce PC ?
 *
 * Sans vrais rushs, génère des clips synthétiques (mire + timecode + bip) aux durées de
 * fixtures/reference/clips.json : le timecode incrusté permet de vérifier à l'œil que les
 * bons instants ont été coupés.
 *
 * Lancement : pnpm -C spikes s2 [--clips-dir <dossier de vrais rushs>]
 * Sortie : spikes/s2-render/out/reference.mp4
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  edlDurationSec,
  loadReferenceClips,
  loadReferenceEdl,
  makeSyntheticClip,
  makeSyntheticMusic,
  probeVideo,
  validateEdl,
  type ClipInfo,
} from '@outil/core';
import { ensureRenderBrowser, renderEdl } from '@outil/video';

const { values } = parseArgs({ options: { 'clips-dir': { type: 'string' } } });
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// 1. Clips : synthétiques (par défaut) ou vrais rushs nommés comme les clips de référence
const edl = loadReferenceEdl();
const reference = loadReferenceClips();
const clipsDir = values['clips-dir']
  ? path.resolve(values['clips-dir'])
  : path.join(outDir, 'synthetic');
const clips: ClipInfo[] = [];
for (const ref of reference) {
  const file = path.join(clipsDir, `${ref.id}.mp4`);
  if (!fs.existsSync(file)) {
    if (values['clips-dir']) throw new Error(`rush attendu : ${file}`);
    log(`génération du clip synthétique ${ref.id} (${ref.durationSec} s)…`);
    await makeSyntheticClip({
      out: file,
      durationSec: ref.durationSec,
      label: ref.id,
      toneHz: 330 + clips.length * 110,
    });
  }
  const probe = await probeVideo(file);
  clips.push({
    ...ref,
    path: file,
    durationSec: probe.durationSec,
    width: probe.width,
    height: probe.height,
    hasAudio: probe.hasAudio,
  });
}
const music = path.join(outDir, 'synthetic', 'music-120bpm.mp3');
if (!fs.existsSync(music)) {
  log('génération de la musique synthétique…');
  await makeSyntheticMusic({ out: music, durationSec: 60, bpm: 120 });
}

// 2. Validation avant rendu (la couche de contrôle du cahier)
const check = validateEdl(edl, { clips, durationRange: { min: 15, max: 60 } });
if (!check.ok) {
  console.error('EDL invalide :', check.issues);
  process.exit(1);
}
log(`EDL valide : ${edl.segments.length} segments, ${edlDurationSec(edl).toFixed(2)} s`);

// 3. Navigateur de rendu (téléchargé une fois)
await ensureRenderBrowser((p) => log(`téléchargement de Chrome Headless Shell ${p.toFixed(0)} %`));

// 4. Rendu
const out = path.join(outDir, 'reference.mp4');
let lastPercent = -10;
const result = await renderEdl({
  edl,
  clips,
  out,
  music: { path: music, volume: 0.35 },
  onProgress: (percent) => {
    if (percent >= lastPercent + 10) {
      lastPercent = percent;
      log(`rendu ${percent} %`);
    }
  },
});

// 5. Contrôle du résultat (ce que fera l'étape qc)
const probe = await probeVideo(out);
const expected = edlDurationSec(edl);
log(`terminé : ${out}`);
log(
  `bundle ${(result.bundleMs / 1000).toFixed(1)} s · rendu ${(result.renderMs / 1000).toFixed(1)} s pour ${expected.toFixed(1)} s de vidéo (×${(result.renderMs / 1000 / expected).toFixed(1)} temps réel)`,
);
log(
  `sortie : ${probe.width}x${probe.height} @ ${probe.fps ?? '?'} fps, ${probe.durationSec.toFixed(2)} s (attendu ${expected.toFixed(2)}), audio ${probe.hasAudio ? 'oui' : 'NON'}`,
);
const durationOk = Math.abs(probe.durationSec - expected) < 0.2;
log(
  durationOk && probe.hasAudio && probe.width === 1080
    ? '✔ contrôle qc OK'
    : '✖ contrôle qc en échec',
);
fs.writeFileSync(
  path.join(outDir, 'reference-report.json'),
  JSON.stringify(
    {
      clips,
      edl,
      timeline: result.timeline,
      bundleMs: result.bundleMs,
      renderMs: result.renderMs,
      probe,
    },
    null,
    2,
  ),
);
process.exit(durationOk ? 0 : 1);
