import fs from 'node:fs';
import path from 'node:path';
import {
  edlDurationSec,
  edlSchema,
  formatEdlIssues,
  loadPrompt,
  validateEdl,
  type AnthropicMessage,
  type LoadedAccount,
  type TaggingResult,
} from '@outil/core';
import type { PipelineContext } from '../context.js';
import { currentFeedback, type PipelineState } from '../state.js';

export const EDL_MAX_ATTEMPTS = 3;

/** Dérushage compacté pour le modèle : l'essentiel, sans les chemins ni la provenance. */
export function taggingForPrompt(tagging: TaggingResult): unknown {
  return {
    summary: tagging.summary,
    clips: tagging.clips.map((c) => ({
      clipId: c.id,
      durationSec: c.durationSec,
      hasAudio: c.hasAudio,
      summary: c.summary,
      scenes: c.scenes,
      transcript: c.transcript,
    })),
    highlights: tagging.highlights,
  };
}

/** Message utilisateur initial : contraintes du compte + dérushage. */
export function buildEdlRequest(account: LoadedAccount, tagging: TaggingResult): string {
  const c = account.config;
  return [
    '## Contraintes du compte',
    `- contentType : ${c.contentType}`,
    `- durationRange : ${c.durationRange.min} à ${c.durationRange.max} secondes`,
    `- musicMoods disponibles : ${c.musicMoods.length ? c.musicMoods.join(', ') : 'aucun (choisis un mood libre)'}`,
    `- overlays autorisés : ${c.overlays.length ? c.overlays.join(', ') : 'aucun'} — n'en produis pas d'autre style`,
    '',
    '## Dérushage',
    '```json',
    JSON.stringify(taggingForPrompt(tagging), null, 1),
    '```',
    '',
    'Produis l’EDL.',
  ].join('\n');
}

/**
 * Relance sur feedback : la version livrée est rejouée comme réponse du modèle, suivie du retour
 * de Markus — le modèle corrige sa propre copie au lieu de repartir de zéro.
 */
export function feedbackTurns(previous: unknown, request: string): AnthropicMessage[] {
  return [
    { role: 'assistant', content: JSON.stringify(previous) },
    { role: 'user', content: request },
  ];
}

export function edlFeedbackRequest(text: string): string {
  return [
    `Retour de Markus sur la vidéo montée à partir de cet EDL : « ${text} »`,
    '',
    'Produis un nouvel EDL complet qui applique ce retour. Garde tout ce que le retour ne remet pas en cause (clips, rythme, cadrages, effets) ; ne change que ce qui est demandé.',
  ].join('\n');
}

/**
 * EDL par Claude, contraint par `edlSchema`, puis passé au validateur ; les problèmes sont renvoyés
 * au modèle avec sa réponse précédente, jusqu'à EDL_MAX_ATTEMPTS. Sur une relance avec feedback
 * vidéo, l'EDL livré et le retour sont ajoutés à la conversation.
 */
export async function edl(
  p: PipelineContext,
  state: PipelineState,
  account: LoadedAccount,
): Promise<void> {
  const { tagging, clips } = state;
  if (!tagging || !clips) throw new Error('edl : tagging manquant');
  const model = p.ctx.env.MODEL_EDL;
  const claude = p.anthropic();
  const system = loadPrompt('edl', p.ctx.promptsDir);
  const messages: AnthropicMessage[] = [
    { role: 'user', content: buildEdlRequest(account, tagging) },
  ];
  const fb = currentFeedback(state, 'video');
  if (fb && state.edl) {
    messages.push(...feedbackTurns(state.edl, edlFeedbackRequest(fb.text)));
    p.log(`edl : relance avec le retour « ${fb.text} »`);
  }
  const meta = {
    module: 'edl' as const,
    provider: 'anthropic' as const,
    model,
    account: state.account,
    contentId: state.contentId,
  };

  for (let attempt = 1; attempt <= EDL_MAX_ATTEMPTS; attempt++) {
    const { data, raw } = await claude.generateStructured({
      model,
      schema: edlSchema,
      system,
      messages,
      meta,
      effort: 'medium',
    });
    // Garde-fou : on retire les styles d'overlay que le compte n'autorise pas, quoi que dise le modèle
    const allowed = new Set(account.config.overlays);
    const removed = data.overlays.filter((o) => !allowed.has(o.style)).length;
    data.overlays = data.overlays.filter((o) => allowed.has(o.style));
    if (removed) p.log(`edl : ${removed} overlay(s) retiré(s) (style non autorisé par le compte)`);
    const check = validateEdl(data, { clips, durationRange: account.config.durationRange });
    if (check.ok) {
      state.edl = data;
      state.edlAttempts = attempt;
      state.models = { ...state.models, edl: model };
      fs.writeFileSync(path.join(state.workDir, 'edl.json'), JSON.stringify(data, null, 2));
      p.log(
        `edl : ${data.segments.length} segments, ${edlDurationSec(data).toFixed(1)} s, ${data.overlays.length} overlay(s), musique « ${data.music.mood} » (tentative ${attempt})`,
      );
      p.log(`edl : ${data.notes}`);
      return;
    }
    p.log(`edl : ${check.issues.length} problème(s) à la tentative ${attempt} — renvoi au modèle`);
    messages.push({ role: 'assistant', content: raw || JSON.stringify(data) });
    messages.push({
      role: 'user',
      content: `Cet EDL est invalide :\n${formatEdlIssues(check.issues)}\n\nRenvoie un EDL complet corrigé.`,
    });
  }
  throw new Error(`edl : toujours invalide après ${EDL_MAX_ATTEMPTS} tentatives`);
}
