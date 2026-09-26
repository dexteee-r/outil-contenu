import path from 'node:path';
import fs from 'node:fs';
import {
  edlDurationSec,
  loadMusicIndex,
  loadSfxIndex,
  makeSyntheticHitSfx,
  musicDir,
  probeDurationSec,
  probeVideo,
  selectTrack,
  SFX_KINDS,
  sfxDir,
  sfxPathFor,
  type SfxKindName,
} from '@outil/core';
import { renderEdl } from '@outil/video';
import type { PipelineContext } from '../context.js';
import type { PipelineState } from '../state.js';

/** Rendu Remotion de l'EDL en 1080x1920, avec la piste musicale de la bibliothèque si une convient. */
export async function render(p: PipelineContext, state: PipelineState): Promise<void> {
  const { edl, clips } = state;
  if (!edl || !clips) throw new Error('render : EDL manquant');

  const dir = musicDir(p.ctx.repoRoot);
  const track = selectTrack(loadMusicIndex(dir), {
    mood: edl.music.mood,
    tempoRange: edl.music.tempoRange,
    minDurationSec: edlDurationSec(edl),
  });
  if (track) {
    state.music = { file: path.join(dir, track.file), title: track.title, license: track.license };
    p.log(`render : musique « ${track.title} » (${track.bpm} bpm)`);
  } else {
    state.music = null;
    p.log(`render : aucune piste « ${edl.music.mood} » dans music/music.json — rendu sans musique`);
  }

  // Habillage sonore : bibliothèque sfx/ ; pour le « hit », substitution synthétique si absent
  const library = sfxDir(p.ctx.repoRoot);
  const index = loadSfxIndex(library);
  const sfx: Partial<Record<SfxKindName, { path: string; durationSec: number }>> = {};
  for (const kind of SFX_KINDS) {
    let file = sfxPathFor(library, kind, index);
    if (!file && kind === 'hit' && edl.effects.some((e) => e.type === 'hit')) {
      file = path.join(p.ctx.paths.root, 'cache', 'sfx-hit-placeholder.mp3');
      if (!fs.existsSync(file)) await makeSyntheticHitSfx(file);
      p.log('render : pas de son « hit » dans sfx/sfx.json — son de substitution');
    }
    if (file) sfx[kind] = { path: file, durationSec: await probeDurationSec(file) };
  }
  const declared = Object.keys(sfx);
  if (declared.length) p.log(`render : sons ${declared.join(', ')}`);

  const out = path.join(state.workDir, 'video.mp4');
  let last = -20;
  const result = await renderEdl({
    edl,
    clips,
    out,
    music: state.music ? { path: state.music.file } : null,
    sfx,
    onProgress: (percent) => {
      if (percent >= last + 20) {
        last = percent;
        p.log(`render : ${percent} %`);
      }
    },
  });
  const probe = await probeVideo(out);
  state.render = {
    path: out,
    durationSec: probe.durationSec,
    width: probe.width,
    height: probe.height,
    renderMs: result.renderMs,
  };
  p.log(
    `render : ${probe.width}x${probe.height}, ${probe.durationSec.toFixed(2)} s, rendu en ${(result.renderMs / 1000).toFixed(0)} s`,
  );
}
