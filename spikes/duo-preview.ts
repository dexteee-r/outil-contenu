/**
 * Aperçu du style de miniature « duo » : produit + carte hit détourés via kie.ai (mis en cache
 * dans s3-thumbnail/out/), puis composition locale dans les deux formats, variantes normale et teaser.
 * Lancement : pnpm -C spikes duo <produit.png> <carte.png|-> "Titre"
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  closeDb,
  composeDuoThumbnail,
  createAppContext,
  createKieProvider,
  createUsageTracker,
  DEFAULT_THUMBNAIL_TEMPLATE,
  openDb,
  THUMBNAIL_FORMATS,
} from '@outil/core';

const [product, hit, title = 'QUEL HIT ?'] = process.argv.slice(2);
if (!product || !hit)
  throw new Error('usage : pnpm -C spikes duo <produit.png> <carte.png|-> "Titre"');

const outDir = path.join(import.meta.dirname, 's3-thumbnail', 'out');
fs.mkdirSync(outDir, { recursive: true });
const brand = {
  colors: { primary: '#FFCC00', secondary: '#1A1A2E', background: '#0F0F1A', text: '#FFFFFF' },
  fonts: {},
};

const ctx = createAppContext();
const db = openDb({ file: ctx.paths.db });
try {
  const kie = createKieProvider(ctx, createUsageTracker(ctx, db));
  /** Détourage mis en cache à côté de l'image source : cutout-<nom>.png */
  const cutout = async (file: string): Promise<Buffer> => {
    const cached = path.join(outDir, `cutout-${path.basename(file, path.extname(file))}.png`);
    if (fs.existsSync(cached)) return fs.readFileSync(cached);
    const r = await kie.removeBackground(fs.readFileSync(file), {
      module: 'image',
      provider: 'kie',
      model: 'recraft/remove-background',
    });
    fs.writeFileSync(cached, r.image);
    console.log(`détourage ${path.basename(file)} : ${r.costUsd.toFixed(3)} $`);
    return r.image;
  };
  const hero = await cutout(product);
  const secondary = hit === '-' ? null : await cutout(hit);
  for (const format of THUMBNAIL_FORMATS) {
    for (const tease of secondary ? [false, true] : [false]) {
      const t0 = performance.now();
      const out = await composeDuoThumbnail({
        hero,
        secondary,
        format,
        template: DEFAULT_THUMBNAIL_TEMPLATE,
        brand,
        title,
        tease,
      });
      const file = path.join(outDir, `duo-${format}${tease ? '-tease' : ''}.png`);
      fs.writeFileSync(file, out.png);
      console.log(
        `${file} — ${out.width}x${out.height}, ${((performance.now() - t0) / 1000).toFixed(1)} s, fond ${out.palette.mid}, lueur ${out.palette.glow}`,
      );
    }
  }
} finally {
  closeDb(db);
}
