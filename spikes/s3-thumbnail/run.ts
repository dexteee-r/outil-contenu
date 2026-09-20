/**
 * Spike S3 — miniatures : visuel IA + gabarit de marque composé par code (Sharp).
 *
 * Questions : Gemini rend-il un visuel exploitable ? Le texte posé par code est-il meilleur que
 * le texte incrusté par le modèle ? Les deux formats (1080x1920, 1280x720) sortent-ils propres ?
 *
 * Sans GEMINI_API_KEY (ou avec --synthetic) : fonds synthétiques, pour valider la composition.
 * Avec la clé : 3 variantes générées + 1 image « texte par le modèle » pour comparaison.
 *
 * Lancement : pnpm -C spikes s3 [--account tcg] [--title "PULL ULTRA RARE"] [--synthetic]
 * Sortie : spikes/s3-thumbnail/out/<format>-v<n>.png, model-text.png, contact-sheet.png
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
  createUsageTracker,
  DEFAULT_THUMBNAIL_TEMPLATE,
  loadAccount,
  openDb,
  parseThumbnailTemplate,
  THUMBNAIL_FORMATS,
  type GeminiProvider,
} from '@outil/core';

const { values } = parseArgs({
  options: {
    account: { type: 'string', default: 'tcg' },
    title: { type: 'string', default: 'Pull ultra rare dans ce booster' },
    synthetic: { type: 'boolean', default: false },
    variants: { type: 'string', default: '3' },
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

const variants = Number(values.variants);
const useGemini = !values.synthetic && Boolean(ctx.env.GEMINI_API_KEY);
const scene =
  'Gros plan cinématographique sur une main qui brandit une carte à collectionner holographique brillante, reflets arc-en-ciel, fond sombre avec des étincelles dorées, éclairage dramatique, style photo de produit, sans texte.';

// 1. Fonds : Gemini ou synthétiques
const backgrounds: Buffer[] = [];
let modelTextImage: Buffer | null = null;
let db: ReturnType<typeof openDb> | undefined;
if (useGemini) {
  const model = ctx.env.MODEL_IMAGE;
  if (!model) throw new Error('MODEL_IMAGE manquant dans .env');
  db = openDb({ file: ctx.paths.db });
  const tracker = createUsageTracker(ctx, db, (m) =>
    log(`⚠ modèle ${m} absent de pricing.json : coût non calculé`),
  );
  const gemini: GeminiProvider = createGeminiProvider(ctx, tracker);
  const meta = {
    module: 'image' as const,
    provider: 'gemini' as const,
    model,
    account: account.config.slug,
  };

  for (let i = 0; i < variants; i++) {
    const t0 = performance.now();
    const { images, text } = await gemini.generateImages({
      model,
      prompt: scene,
      aspectRatio: '9:16',
      meta,
    });
    log(
      `variante ${i + 1} : ${images.length} image(s) en ${((performance.now() - t0) / 1000).toFixed(1)} s${text ? ` — « ${text.slice(0, 80)} »` : ''}`,
    );
    backgrounds.push(images[0]!.data);
  }
  // Comparaison : le modèle incruste lui-même le texte
  const t0 = performance.now();
  const { images } = await gemini.generateImages({
    model,
    prompt: `${scene.replace('sans texte.', '')} Incruste en grand le texte « ${values.title.toUpperCase()} » en lettres jaunes épaisses, typographie percutante, parfaitement lisible.`,
    aspectRatio: '9:16',
    meta,
  });
  modelTextImage = images[0]!.data;
  log(`texte par le modèle : ${((performance.now() - t0) / 1000).toFixed(1)} s`);
} else {
  log(
    useGemini
      ? ''
      : 'mode synthétique (pas de clé Gemini ou --synthetic) : fonds générés par Sharp',
  );
  const palettes = [
    ['#2A0A4A', '#FF5E00'],
    ['#03203C', '#00D4FF'],
    ['#3D0000', '#FFD400'],
  ];
  for (let i = 0; i < variants; i++) {
    const [a, b] = palettes[i % palettes.length]!;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
      <defs><radialGradient id="r" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="${b}"/><stop offset="1" stop-color="${a}"/></radialGradient></defs>
      <rect width="1080" height="1920" fill="url(#r)"/>
      <rect x="290" y="560" width="500" height="700" rx="28" fill="#FFFFFF" opacity="0.92" transform="rotate(-8 540 910)"/>
      <rect x="330" y="600" width="420" height="380" rx="16" fill="${a}" opacity="0.8" transform="rotate(-8 540 910)"/>
      <text x="540" y="1180" text-anchor="middle" font-family="Arial" font-size="72" fill="${a}" transform="rotate(-8 540 910)">CARTE ${i + 1}</text>
    </svg>`;
    backgrounds.push(await sharp(Buffer.from(svg)).png().toBuffer());
  }
}

// 2. Composition : chaque variante × chaque format
const outputs: { file: string; png: Buffer }[] = [];
for (const [i, background] of backgrounds.entries()) {
  for (const format of THUMBNAIL_FORMATS) {
    const t0 = performance.now();
    const composed = await composeThumbnail({
      background,
      format,
      template,
      brand: account.config.brand,
      title: values.title,
      logo,
    });
    const file = path.join(outDir, `${format}-v${i + 1}.png`);
    fs.writeFileSync(file, composed.png);
    outputs.push({ file, png: composed.png });
    log(
      `${path.basename(file)} : ${composed.width}x${composed.height}, titre ${composed.fitted.lines.length} ligne(s) à ${composed.fitted.fontSize}px, ${(performance.now() - t0).toFixed(0)} ms`,
    );
  }
  fs.writeFileSync(path.join(outDir, `background-v${i + 1}.png`), background);
}
if (modelTextImage) fs.writeFileSync(path.join(outDir, 'model-text.png'), modelTextImage);

// 3. Planche contact pour comparer d'un coup d'œil
const sheet = await contactSheet(
  [...outputs.map((o) => o.png), ...(modelTextImage ? [modelTextImage] : [])],
  { columns: THUMBNAIL_FORMATS.length, cellWidth: 400 },
);
fs.writeFileSync(path.join(outDir, 'contact-sheet.png'), sheet);
log(`planche contact : ${path.join(outDir, 'contact-sheet.png')}`);
if (db) closeDb(db);
