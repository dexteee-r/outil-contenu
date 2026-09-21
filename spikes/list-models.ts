/**
 * Liste les modèles Gemini accessibles avec la clé du .env (lecture seule, gratuit).
 * Sert à choisir les IDs exacts de MODEL_TAGGING et MODEL_IMAGE.
 * Lancement : pnpm -C spikes models
 */
import { GoogleGenAI } from '@google/genai';
import { createAppContext } from '@outil/core';

const ctx = createAppContext();
if (!ctx.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY manquante dans .env');
const ai = new GoogleGenAI({ apiKey: ctx.env.GEMINI_API_KEY });

const rows: { name: string; display: string; actions: string }[] = [];
for await (const m of await ai.models.list({ config: { pageSize: 100 } })) {
  rows.push({
    name: (m.name ?? '').replace(/^models\//, ''),
    display: m.displayName ?? '',
    actions: (m.supportedActions ?? []).join(','),
  });
}

const skip =
  /embedding|tts|live|audio|robotics|computer-use|deep-research|veo|imagen|learnlm|gemma|aqa/i;
const keep = rows.filter((r) => !skip.test(r.name)).sort((a, b) => a.name.localeCompare(b.name));
console.log(`${rows.length} modèles visibles, ${keep.length} candidats texte/vidéo/image :\n`);
for (const r of keep)
  console.log(`${r.name.padEnd(46)} ${r.display.slice(0, 38).padEnd(40)} ${r.actions}`);
console.log(
  `\nActuellement dans .env : MODEL_TAGGING=${ctx.env.MODEL_TAGGING ?? '?'} · MODEL_IMAGE=${ctx.env.MODEL_IMAGE ?? '?'}`,
);
for (const id of [ctx.env.MODEL_TAGGING, ctx.env.MODEL_IMAGE]) {
  if (id) console.log(`  ${rows.some((r) => r.name === id) ? '✔' : '✖'} ${id}`);
}
