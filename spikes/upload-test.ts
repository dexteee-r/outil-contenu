/** Inspecte la réponse brute de l'upload de fichier kie.ai. */
import fs from 'node:fs';
import { createAppContext } from '@outil/core';

const ctx = createAppContext();
const png = fs.readFileSync(
  process.argv[2] ?? 'C:/Users/momoe/AppData/Local/Temp/booster-small.png',
);
const res = await fetch('https://kieai.redpandaai.co/api/file-base64-upload', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${ctx.env.KIE_API_KEY ?? ''}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    base64Data: `data:image/png;base64,${png.toString('base64')}`,
    uploadPath: 'images',
    fileName: `test-${Date.now()}.png`,
  }),
});
console.log('HTTP', res.status);
console.log(JSON.stringify(await res.json(), null, 1).slice(0, 800));
