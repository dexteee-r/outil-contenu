/**
 * Aperçu du style de miniature « poster » : détourage du sujet via kie.ai puis composition locale.
 * Lancement : pnpm -C spikes poster <image.png> "Titre" [--no-cutout]
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  closeDb,
  composePosterThumbnail,
  createAppContext,
  createKieProvider,
  createUsageTracker,
  DEFAULT_THUMBNAIL_TEMPLATE,
  openDb,
  THUMBNAIL_FORMATS,
} from '@outil/core';

const args = process.argv.slice(2);
const noCutout = args.includes('--no-cutout');
const reuse = args.includes('--reuse-cutout');
const [input, title = "C'est Vergo"] = args.filter((a) => !a.startsWith('--'));
if (!input) throw new Error('usage : pnpm -C spikes poster <image.png> "Titre" [--no-cutout]');

const outDir = path.join(import.meta.dirname, 's3-thumbnail', 'out');
fs.mkdirSync(outDir, { recursive: true });
const brand = {
  colors: { primary: '#FFCC00', secondary: '#1A1A2E', background: '#0F0F1A', text: '#FFFFFF' },
  fonts: {},
};

const frame = fs.readFileSync(input);
let subject: Buffer = frame;
const ctx = createAppContext();
const db = openDb({ file: ctx.paths.db });
try {
  if (reuse) {
    subject = fs.readFileSync(path.join(outDir, 'cutout.png'));
    console.log('détourage réutilisé (cache local)');
  } else if (!noCutout) {
    const kie = createKieProvider(ctx, createUsageTracker(ctx, db));
    const t0 = performance.now();
    const r = await kie.removeBackground(frame, {
      module: 'image',
      provider: 'kie',
      model: 'recraft/remove-background',
    });
    subject = r.image;
    fs.writeFileSync(path.join(outDir, 'cutout.png'), subject);
    console.log(
      `détourage : ${((performance.now() - t0) / 1000).toFixed(0)} s, ${r.creditsConsumed} crédits (${r.costUsd.toFixed(3)} $)`,
    );
  }
  for (const format of THUMBNAIL_FORMATS) {
    const out = await composePosterThumbnail({
      subject,
      format,
      template: DEFAULT_THUMBNAIL_TEMPLATE,
      brand,
      title,
    });
    const file = path.join(outDir, `poster-${format}.png`);
    fs.writeFileSync(file, out.png);
    console.log(`${file} — ${out.width}x${out.height}, ${out.fitted.lines.join(' / ')}`);
  }
} finally {
  closeDb(db);
}
