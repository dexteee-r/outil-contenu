import fs from 'node:fs';
import path from 'node:path';
import {
  buildTaggingPrompt,
  makeProxy,
  mergeTagging,
  proxyPathFor,
  taggingOutputSchema,
  validateTaggingOutput,
  videoMimeType,
  type GeminiPart,
  type LoadedAccount,
} from '@outil/core';
import type { PipelineContext } from '../context.js';
import type { PipelineState } from '../state.js';

/**
 * Tagging : proxies 720p → Files API Gemini → JSON contraint par `taggingOutputSchema` →
 * contrôle de cohérence (ids, bornes). Une incohérence est renvoyée une fois au modèle.
 */
export async function tag(
  p: PipelineContext,
  state: PipelineState,
  account: LoadedAccount,
): Promise<void> {
  const clips = state.clips;
  if (!clips?.length) throw new Error('tag : aucun clip (ingestion manquante)');
  const model = p.ctx.env.MODEL_TAGGING;
  if (!model) throw new Error('MODEL_TAGGING manquant dans .env');
  const gemini = p.gemini();

  const proxyDir = path.join(state.workDir, 'proxy');
  const uploaded = await Promise.all(
    clips.map(async (clip) => {
      const proxy = proxyPathFor(clip.path, proxyDir);
      if (!fs.existsSync(proxy)) await makeProxy({ input: clip.path, output: proxy });
      const file = await gemini.uploadFile(proxy, videoMimeType(proxy));
      p.log(`tag : ${clip.id} envoyé (proxy ${(fs.statSync(proxy).size / 1e6).toFixed(1)} Mo)`);
      return { clip, file };
    }),
  );

  const prompt = buildTaggingPrompt({
    contentType: account.config.contentType,
    clips,
    dir: p.ctx.promptsDir,
  });
  const baseParts: GeminiPart[] = [{ text: prompt }];
  for (const { clip, file } of uploaded) {
    baseParts.push({ text: `clip ${clip.id}` });
    baseParts.push({ fileData: { fileUri: file.uri, mimeType: file.mimeType } });
  }
  const meta = {
    module: 'tagging' as const,
    provider: 'gemini' as const,
    model,
    account: state.account,
    contentId: state.contentId,
  };

  let parts = baseParts;
  for (let attempt = 1; ; attempt++) {
    const { data } = await gemini.generateJson({ model, schema: taggingOutputSchema, parts, meta });
    const issues = validateTaggingOutput(data, clips);
    if (issues.length === 0 || attempt >= 2) {
      if (issues.length) {
        throw new Error(
          `tag : sortie incohérente après ${attempt} tentatives :\n${issues.map((i) => `- ${i.path}: ${i.message}`).join('\n')}`,
        );
      }
      state.tagging = mergeTagging(clips, data, { model });
      state.models = { ...state.models, tagging: model };
      fs.writeFileSync(
        path.join(state.workDir, 'tagging.json'),
        JSON.stringify(state.tagging, null, 2),
      );
      const climax = state.tagging.highlights
        .filter((h) => h.kind === 'climax')
        .sort((a, b) => b.score - a.score)[0];
      p.log(
        `tag : ${state.tagging.highlights.length} moments forts${climax ? ` · climax ${climax.clipId} ${climax.start.toFixed(1)}→${climax.end.toFixed(1)} s (${climax.score.toFixed(2)})` : ' · pas de climax'}`,
      );
      return;
    }
    p.log(`tag : ${issues.length} incohérence(s), renvoi au modèle`);
    parts = [
      ...baseParts,
      {
        text: `Ta réponse précédente contenait des incohérences. Corrige-les et renvoie la sortie complète :\n${issues.map((i) => `- ${i.path}: ${i.message}`).join('\n')}`,
      },
    ];
  }
}
