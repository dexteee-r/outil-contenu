import fs from 'node:fs';
import {
  captionsOutputSchemaFor,
  loadPrompt,
  splitCaptionsOutput,
  type LoadedAccount,
} from '@outil/core';
import type { PipelineContext } from '../context.js';
import { taggingForPrompt } from './edl.js';
import type { PipelineState } from '../state.js';

/** System prompt : règles génériques + instructions du compte (migrées depuis le Claude Project). */
export function buildCaptionsSystem(p: PipelineContext, account: LoadedAccount): string {
  const generic = loadPrompt('captions-generic', p.ctx.promptsDir);
  const own = fs.existsSync(account.files.captionPrompt)
    ? fs.readFileSync(account.files.captionPrompt, 'utf8').trim()
    : '';
  return own
    ? `${generic}\n\n## Instructions du compte ${account.config.displayName}\n\n${own}`
    : generic;
}

/** Légendes par plateforme + titre de miniature, par Claude, contraints par le schéma du compte. */
export async function captions(
  p: PipelineContext,
  state: PipelineState,
  account: LoadedAccount,
): Promise<void> {
  if (!state.tagging) throw new Error('captions : tagging manquant');
  const model = p.ctx.env.MODEL_CAPTIONS;
  const platforms = account.config.platforms;
  const schema = captionsOutputSchemaFor(platforms);
  const user = [
    `## Plateformes ciblées\n${platforms.join(', ')}`,
    `## Dérushage\n\`\`\`json\n${JSON.stringify(taggingForPrompt(state.tagging), null, 1)}\n\`\`\``,
    state.edl
      ? `## Montage retenu\n${state.edl.notes}\nOverlays : ${state.edl.overlays.map((o) => `« ${o.text} »`).join(', ') || 'aucun'}`
      : '',
    'Rédige les textes de publication.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const { data } = await p.anthropic().generateStructured({
    model,
    schema,
    system: buildCaptionsSystem(p, account),
    messages: [{ role: 'user', content: user }],
    meta: {
      module: 'captions',
      provider: 'anthropic',
      model,
      account: state.account,
      contentId: state.contentId,
    },
    effort: 'low',
  });
  const split = splitCaptionsOutput(data);
  state.captions = split.captions;
  state.thumbnailTitle = split.thumbnailTitle;
  state.thumbnailSubject = split.thumbnailSubject;
  state.models = { ...state.models, captions: model };
  const first = platforms[0] ? split.captions[platforms[0]] : undefined;
  p.log(
    `captions : ${platforms.length} plateforme(s) · titre « ${first?.title ?? '?'} » · miniature « ${split.thumbnailTitle} » sur ${split.thumbnailSubject.what} (${split.thumbnailSubject.clipId} @ ${split.thumbnailSubject.atSec.toFixed(1)} s)`,
  );
}
