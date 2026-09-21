import { createHash } from 'node:crypto';
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
  type ClipInfo,
  type GeminiPart,
  type LoadedAccount,
  type TaggingOutput,
} from '@outil/core';
import type { PipelineContext } from '../context.js';
import type { PipelineState } from '../state.js';

/**
 * Clé de cache du tagging : mêmes rushs (nom + taille + durée), même type de contenu, même prompt
 * → même sortie. Évite de repayer et de réattendre Gemini quand on relance le même dossier.
 */
export function taggingCacheKey(clips: ClipInfo[], contentType: string, prompt: string): string {
  const h = createHash('sha1');
  for (const c of clips) {
    h.update(`${c.id}|${path.basename(c.path)}|${fs.statSync(c.path).size}|${c.durationSec}\n`);
  }
  h.update(`${contentType}\n${prompt}`);
  return h.digest('hex');
}

function cacheFile(p: PipelineContext, key: string): string {
  return path.join(p.ctx.paths.root, 'cache', 'tagging', `${key}.json`);
}

function readCache(p: PipelineContext, key: string): TaggingOutput | null {
  const file = cacheFile(p, key);
  if (!fs.existsSync(file)) return null;
  const parsed = taggingOutputSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  return parsed.success ? parsed.data : null;
}

function writeCache(p: PipelineContext, key: string, output: TaggingOutput): void {
  const file = cacheFile(p, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(output));
}

/**
 * Tagging : proxies 720p → Files API Gemini → JSON contraint par `taggingOutputSchema` →
 * contrôle de cohérence (ids, bornes). Une incohérence est renvoyée une fois au modèle.
 * Le résultat est mis en cache par empreinte des rushs.
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

  const prompt = buildTaggingPrompt({
    contentType: account.config.contentType,
    clips,
    dir: p.ctx.promptsDir,
  });
  const key = taggingCacheKey(clips, account.config.contentType, prompt);
  const cached = readCache(p, key);

  let output: TaggingOutput;
  let usedModel = model;
  if (cached && validateTaggingOutput(cached, clips).length === 0) {
    output = cached;
    usedModel = `${model} (cache)`;
    p.log(`tag : dérushage repris du cache (${key.slice(0, 8)})`);
  } else {
    output = await tagWithGemini(p, state, clips, prompt, model);
    writeCache(p, key, output);
  }

  state.tagging = mergeTagging(clips, output, { model: usedModel });
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
}

async function tagWithGemini(
  p: PipelineContext,
  state: PipelineState,
  clips: ClipInfo[],
  prompt: string,
  model: string,
): Promise<TaggingOutput> {
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
    if (issues.length === 0) return data;
    if (attempt >= 2) {
      throw new Error(
        `tag : sortie incohérente après ${attempt} tentatives :\n${issues.map((i) => `- ${i.path}: ${i.message}`).join('\n')}`,
      );
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
