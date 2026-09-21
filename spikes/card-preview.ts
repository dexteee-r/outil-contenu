/**
 * Aperçu rapide du style de miniature « card » à partir d'une image clé existante.
 * Lancement : pnpm -C spikes card <image-clé.png> "Titre" [out-dir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { composeCardThumbnail, DEFAULT_THUMBNAIL_TEMPLATE, THUMBNAIL_FORMATS } from '@outil/core';

const [
  keyFramePath,
  title = "C'est Vergo",
  outDir = path.join(import.meta.dirname, 's3-thumbnail', 'out'),
] = process.argv.slice(2);
if (!keyFramePath) throw new Error('usage : pnpm -C spikes card <image-clé.png> "Titre"');

const brand = {
  colors: { primary: '#FFCC00', secondary: '#1A1A2E', background: '#0F0F1A', text: '#FFFFFF' },
  fonts: {},
};
const keyFrame = fs.readFileSync(keyFramePath);
fs.mkdirSync(outDir, { recursive: true });
for (const format of THUMBNAIL_FORMATS) {
  const out = await composeCardThumbnail({
    keyFrame,
    format,
    template: DEFAULT_THUMBNAIL_TEMPLATE,
    brand,
    title,
  });
  const file = path.join(outDir, `card-${format}.png`);
  fs.writeFileSync(file, out.png);
  console.log(`${file} — ${out.width}x${out.height}, ${out.fitted.lines.join(' / ')}`);
}
