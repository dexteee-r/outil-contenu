/**
 * Spike S1 — tagging vidéo avec Gemini (compréhension vidéo native).
 *
 * Question : le climax d'une ouverture TCG (carte qui sort, réaction) est-il trouvé à ±1 s ?
 * Mesure : latence, tokens, coût. Compare le prompt générique seul et générique + spécifique.
 *
 * Lancement : pnpm -C spikes s1 --account tcg <rush1.mp4> [rush2.mp4 …]
 *             options : --generic-only (sans le prompt spécifique au type de contenu)
 * Prérequis : GEMINI_API_KEY et MODEL_TAGGING dans .env, ffprobe dans le PATH.
 * Sortie : spikes/s1-tagging/out/<horodatage>.json + résumé console.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  buildTaggingPrompt,
  closeDb,
  createAppContext,
  createGeminiProvider,
  createUsageTracker,
  loadAccount,
  openDb,
  probeClips,
  taggingOutputSchema,
  validateTaggingOutput,
  videoMimeType,
  type GeminiPart,
} from '@outil/core';

const { values, positionals } = parseArgs({
  options: {
    account: { type: 'string', default: 'tcg' },
    'generic-only': { type: 'boolean', default: false },
  },
  allowPositionals: true,
});
if (positionals.length === 0) {
  console.error('usage : pnpm -C spikes s1 --account tcg <rush.mp4> [...]');
  process.exit(1);
}

const ctx = createAppContext();
const model = ctx.env.MODEL_TAGGING;
if (!model) throw new Error('MODEL_TAGGING manquant dans .env');
const account = loadAccount(values.account, ctx.accountsDir);
const contentType = values['generic-only'] ? 'generic' : account.config.contentType;

const db = openDb({ file: ctx.paths.db });
const tracker = createUsageTracker(ctx, db, (m) =>
  console.warn(
    `⚠ modèle ${m} absent de la grille tarifaire : coût non calculé (ajoute-le dans pricing.json)`,
  ),
);
const gemini = createGeminiProvider(ctx, tracker);

const files = positionals.map((p) => path.resolve(p));
const clips = await probeClips(files);
console.log(
  `Clips :\n${clips.map((c) => `  ${c.id} — ${c.durationSec.toFixed(1)} s, ${c.width}x${c.height}, audio ${c.hasAudio ? 'oui' : 'non'}`).join('\n')}`,
);

// 1. Upload (Files API) — les fichiers restent 48 h côté Google
const t0 = performance.now();
const uploaded = await Promise.all(
  clips.map(async (clip) => {
    const f = await gemini.uploadFile(clip.path, videoMimeType(clip.path));
    console.log(`  ↑ ${clip.id} envoyé (${f.name})`);
    return { clip, file: f };
  }),
);
const uploadMs = Math.round(performance.now() - t0);

// 2. Prompt + parts : texte, puis « clip <id> » + vidéo pour chaque rush
const prompt = buildTaggingPrompt({ contentType, clips, dir: ctx.promptsDir });
const parts: GeminiPart[] = [{ text: prompt }];
for (const { clip, file } of uploaded) {
  parts.push({ text: `clip ${clip.id}` });
  parts.push({ fileData: { fileUri: file.uri, mimeType: file.mimeType } });
}

// 3. Génération contrainte par le schéma
const t1 = performance.now();
const { data, usage } = await gemini.generateJson({
  model,
  schema: taggingOutputSchema,
  parts,
  meta: { module: 'tagging', provider: 'gemini', model, account: account.config.slug },
});
const generateMs = Math.round(performance.now() - t1);
const issues = validateTaggingOutput(data, clips);

// 4. Résumé
console.log(`\nRésumé : ${data.summary}`);
console.log('\nHighlights (triés par score) :');
for (const h of [...data.highlights].sort((a, b) => b.score - a.score)) {
  console.log(
    `  ${h.kind.padEnd(8)} ${h.score.toFixed(2)}  ${h.clipId} ${h.start.toFixed(1)}→${h.end.toFixed(1)} s  ${h.reason}`,
  );
}
if (issues.length) {
  console.log('\n⚠ Incohérences :');
  for (const i of issues) console.log(`  ${i.path}: ${i.message}`);
}
console.log(
  `\nLatence : upload ${(uploadMs / 1000).toFixed(1)} s · génération ${(generateMs / 1000).toFixed(1)} s`,
);
console.log(`Tokens : ${usage.inputTokens} entrée · ${usage.outputTokens} sortie`);

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(
  outFile,
  JSON.stringify(
    { model, contentType, clips, prompt, output: data, issues, usage, uploadMs, generateMs },
    null,
    2,
  ),
);
console.log(`Sortie complète : ${outFile}`);
closeDb(db);
