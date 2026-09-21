/**
 * Spike S3 — miniatures : visuel IA + gabarit de marque composé par code (Sharp).
 *
 * Questions : quel modèle rend le meilleur visuel pour la marque ? Le texte posé par code est-il
 * meilleur que le texte incrusté par le modèle ? Les deux formats (1080x1920, 1280x720) sortent-ils propres ?
 *
 * Fournisseurs :
 *   --provider kie     kie.ai (KIE_API_KEY) : --models gpt-image-2,nano-banana-pro,seedream-4.5,ideogram-v3
 *   --provider gemini  clé Google (MODEL_IMAGE) — exige la facturation activée
 *   --synthetic        fonds générés par Sharp, pour valider la composition sans API
 * Par défaut : IMAGE_PROVIDER du .env (gemini).
 *
 * Lancement : pnpm -C spikes s3 --provider kie --models gpt-image-2 --title "Pull Vergo" [--variants 1] [--model-text]
 * Sortie : spikes/s3-thumbnail/out/<format>-<modèle>-v<n>.png, background-*.png, model-text-*.png, contact-sheet.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import {
  closeDb,
  composeThumbnail,
  contactSheet,
  createAppContext,
  createGeminiProvider,
  createKieProvider,
  createUsageTracker,
  DEFAULT_THUMBNAIL_TEMPLATE,
  loadAccount,
  openDb,
  parseThumbnailTemplate,
  THUMBNAIL_FORMATS,
} from '@outil/core';

const { values } = parseArgs({
  options: {
    account: { type: 'string', default: 'tcg' },
    title: { type: 'string', default: 'Pull ultra rare dans ce booster' },
    provider: { type: 'string' },
    models: { type: 'string', default: 'gpt-image-2' },
    variants: { type: 'string', default: '1' },
    synthetic: { type: 'boolean', default: false },
    // Génère aussi une image où le modèle incruste lui-même le titre, pour comparer
    'model-text': { type: 'boolean', default: false },
  },
});
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const ctx = createAppContext();
const account = loadAccount(values.account, ctx.accountsDir);
const template = fs.existsSync(account.files.thumbnailTemplate)
  ? parseThumbnailTemplate(JSON.parse(fs.readFileSync(account.files.thumbnailTemplate, 'utf8')))
  : DEFAULT_THUMBNAIL_TEMPLATE;
const logo =
  account.files.logo && fs.existsSync(account.files.logo)
    ? fs.readFileSync(account.files.logo)
    : undefined;
if (!logo) log('pas de logo (accounts/tcg/brand/logo.png absent) : composition sans logo');

const provider = values.synthetic ? 'synthetic' : (values.provider ?? ctx.env.IMAGE_PROVIDER);
const variants = Number(values.variants);
const scene =
  'Gros plan cinématographique sur une main qui brandit une carte à collectionner holographique brillante, reflets arc-en-ciel, fond sombre avec des étincelles dorées, éclairage dramatique, style photo de produit, sans aucun texte ni lettre.';
const sceneWithText = `${scene.replace('sans aucun texte ni lettre.', '')} Incruste en grand le texte « ${values.title.toUpperCase()} » en lettres jaunes épaisses, typographie percutante, parfaitement lisible.`;

interface Background {
  label: string;
  png: Buffer;
  /** Image « texte par le modèle » à comparer (facultatif) */
  modelText?: Buffer;
}
const backgrounds: Background[] = [];
let db: ReturnType<typeof openDb> | undefined;

if (provider === 'synthetic') {
  log('mode synthétique : fonds générés par Sharp');
  const palettes = [
    ['#2A0A4A', '#FF5E00'],
    ['#03203C', '#00D4FF'],
    ['#3D0000', '#FFD400'],
  ];
  for (let i = 0; i < Math.max(variants, 3); i++) {
    const [a, b] = palettes[i % palettes.length]!;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
      <defs><radialGradient id="r" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="${b}"/><stop offset="1" stop-color="${a}"/></radialGradient></defs>
      <rect width="1080" height="1920" fill="url(#r)"/>
      <rect x="290" y="560" width="500" height="700" rx="28" fill="#FFFFFF" opacity="0.92" transform="rotate(-8 540 910)"/>
      <rect x="330" y="600" width="420" height="380" rx="16" fill="${a}" opacity="0.8" transform="rotate(-8 540 910)"/>
      <text x="540" y="1180" text-anchor="middle" font-family="Arial" font-size="72" fill="${a}" transform="rotate(-8 540 910)">CARTE ${i + 1}</text>
    </svg>`;
    backgrounds.push({
      label: `synthetic-${i + 1}`,
      png: await sharp(Buffer.from(svg)).png().toBuffer(),
    });
  }
} else {
  db = openDb({ file: ctx.paths.db });
  const tracker = createUsageTracker(ctx, db, (m) =>
    log(`⚠ modèle ${m} absent de pricing.json : coût non calculé`),
  );

  if (provider === 'kie') {
    const kie = createKieProvider(ctx, tracker);
    log(`kie.ai : ${await kie.credits()} crédits disponibles`);
    const models = values.models
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    for (const model of models) {
      const meta = {
        module: 'image' as const,
        provider: 'kie' as const,
        model,
        account: account.config.slug,
      };
      for (let i = 0; i < variants; i++) {
        const t0 = performance.now();
        try {
          const r = await kie.generateImage({ model, prompt: scene, aspectRatio: '9:16', meta });
          const bg: Background = { label: `${model}-v${i + 1}`, png: r.image };
          const gen = r.generationMs ? `${(r.generationMs / 1000).toFixed(0)} s` : '?';
          log(
            `${bg.label} : ${(r.image.length / 1e6).toFixed(1)} Mo, ${r.creditsConsumed} crédits (${r.costUsd.toFixed(3)} $), génération ${gen}, total ${((performance.now() - t0) / 1000).toFixed(0)} s`,
          );
          if (values['model-text'] && i === 0) {
            const t = await kie.generateImage({
              model,
              prompt: sceneWithText,
              aspectRatio: '9:16',
              meta,
            });
            bg.modelText = t.image;
            log(`${model} texte par le modèle : ${t.creditsConsumed} crédits`);
          }
          backgrounds.push(bg);
        } catch (err) {
          log(`✖ ${model} : ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } else {
    const model = ctx.env.MODEL_IMAGE;
    if (!model) throw new Error('MODEL_IMAGE manquant dans .env');
    const gemini = createGeminiProvider(ctx, tracker);
    const meta = {
      module: 'image' as const,
      provider: 'gemini' as const,
      model,
      account: account.config.slug,
    };
    for (let i = 0; i < variants; i++) {
      const t0 = performance.now();
      const { images } = await gemini.generateImages({
        model,
        prompt: scene,
        aspectRatio: '9:16',
        meta,
      });
      const bg: Background = { label: `${model}-v${i + 1}`, png: images[0]!.data };
      log(`${bg.label} : ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      if (values['model-text'] && i === 0) {
        const t = await gemini.generateImages({
          model,
          prompt: sceneWithText,
          aspectRatio: '9:16',
          meta,
        });
        bg.modelText = t.images[0]!.data;
      }
      backgrounds.push(bg);
    }
  }
}

if (backgrounds.length === 0) {
  log('aucun visuel généré');
  if (db) closeDb(db);
  process.exit(1);
}

// Composition : chaque visuel × chaque format
const cells: { png: Buffer; label: string }[] = [];
for (const bg of backgrounds) {
  fs.writeFileSync(path.join(outDir, `background-${bg.label}.png`), bg.png);
  for (const format of THUMBNAIL_FORMATS) {
    const t0 = performance.now();
    const composed = await composeThumbnail({
      background: bg.png,
      format,
      template,
      brand: account.config.brand,
      title: values.title,
      logo,
    });
    const file = path.join(outDir, `${format}-${bg.label}.png`);
    fs.writeFileSync(file, composed.png);
    cells.push({ png: composed.png, label: `${bg.label} ${format}` });
    log(
      `${path.basename(file)} : ${composed.width}x${composed.height}, titre ${composed.fitted.lines.length} ligne(s) à ${Math.round(composed.fitted.fontSize)}px, ${(performance.now() - t0).toFixed(0)} ms`,
    );
  }
  if (bg.modelText) {
    fs.writeFileSync(path.join(outDir, `model-text-${bg.label}.png`), bg.modelText);
    cells.push({ png: bg.modelText, label: `${bg.label} texte par le modèle` });
  }
}

const sheet = await contactSheet(
  cells.map((c) => c.png),
  { columns: 3, cellWidth: 360, labels: cells.map((c) => c.label) },
);
fs.writeFileSync(path.join(outDir, 'contact-sheet.png'), sheet);
log(`planche contact : ${path.join(outDir, 'contact-sheet.png')}`);
if (db) closeDb(db);
