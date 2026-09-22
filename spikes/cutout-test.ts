/**
 * Test du détourage local (@imgly/background-removal-node) sur une image de rush.
 * Lancement : pnpm -C spikes cutout <image.png> [sortie.png]
 */
import fs from 'node:fs';
import sharp from 'sharp';
import { removeBackground } from '@imgly/background-removal-node';

const [input, output = 'C:/Users/momoe/AppData/Local/Temp/cutout.png'] = process.argv.slice(2);
if (!input) throw new Error('usage : pnpm -C spikes cutout <image.png>');

const t0 = performance.now();
// Chemin Windows : passer un Blob, sinon « C:/ » est lu comme un protocole d URI
const blob = await removeBackground(new Blob([fs.readFileSync(input)], { type: 'image/png' }));
const png = Buffer.from(await blob.arrayBuffer());
console.log(
  `détourage : ${((performance.now() - t0) / 1000).toFixed(1)} s, ${(png.length / 1e6).toFixed(1)} Mo`,
);

// Recadrage sur la zone opaque (le sujet)
const trimmed = await sharp(png).trim({ threshold: 1 }).png().toBuffer();
const meta = await sharp(trimmed).metadata();
console.log(`sujet : ${meta.width}x${meta.height}`);
fs.writeFileSync(output, trimmed);
// Aperçu sur fond jaune pour voir la découpe
const preview = await sharp({
  create: {
    width: meta.width ?? 100,
    height: meta.height ?? 100,
    channels: 3,
    background: '#FFCC00',
  },
})
  .composite([{ input: trimmed }])
  .png()
  .toBuffer();
fs.writeFileSync(output.replace('.png', '-preview.png'), preview);
console.log(output);
