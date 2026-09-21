import path from 'node:path';
import fs from 'node:fs';
import {
  edlDurationSec,
  hitSfxPath,
  loadMusicIndex,
  makeSyntheticHitSfx,
  musicDir,
  probeVideo,
  selectTrack,
  sfxDir,
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

  // Son des effets « hit » : bibliothèque sfx/, sinon substitution synthétique mise en cache
  let hitSfx: string | null = null;
  if (edl.effects.some((e) => e.type === 'hit')) {
    hitSfx = hitSfxPath(sfxDir(p.ctx.repoRoot));
    if (!hitSfx) {
      hitSfx = path.join(p.ctx.paths.root, 'cache', 'sfx-hit-placeholder.mp3');
      if (!fs.existsSync(hitSfx)) await makeSyntheticHitSfx(hitSfx);
      p.log('render : pas de son « hit » dans sfx/sfx.json — son de substitution');
    }
  }

  const out = path.join(state.workDir, 'video.mp4');
  let last = -20;
  const result = await renderEdl({
    edl,
    clips,
    out,
    music: state.music ? { path: state.music.file } : null,
    sfx: { hit: hitSfx },
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
