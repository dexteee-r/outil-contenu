/**
 * Aperçu des polices de marque d'un compte (brand/fonts/) : nom lu dans le fichier + rendu.
 * Lancement : pnpm -C spikes fonts [compte]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createAppContext, readFontNames, renderTextWithFont } from '@outil/core';

const account = process.argv[2] ?? 'tcg';
const ctx = createAppContext();
const dir = path.join(ctx.accountsDir, account, 'brand', 'fonts');
const outDir = path.join(import.meta.dirname, 's3-thumbnail', 'out');
fs.mkdirSync(outDir, { recursive: true });

const parts: { input: Buffer; left: number; top: number }[] = [];
let y = 16;
let width = 0;
for (const f of fs.readdirSync(dir).filter((n) => /\.(ttf|otf)$/i.test(n))) {
  const file = path.join(dir, f);
  console.log(`${f} → ${JSON.stringify(readFontNames(file))}`);
  const t = await renderTextWithFont(`QUEL HIT ? ÉÀ — ${f}`, file, 72, '#111111');
  parts.push({ input: t.png, left: 20, top: y });
  y += t.height + 24;
  width = Math.max(width, t.width + 40);
}
const out = path.join(outDir, 'fonts.png');
await sharp({ create: { width, height: y, channels: 3, background: '#FFCC00' } })
  .composite(parts)
  .png()
  .toFile(out);
console.log(out);
