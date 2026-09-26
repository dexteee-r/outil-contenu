import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pangoFont, readFontNames, renderTextWithFont } from './fonts.js';

// Les polices de marque ne sont pas versionnées : on teste sur une police système si elle existe
const ARIAL_BLACK = 'C:/Windows/Fonts/ariblk.ttf';
const hasArialBlack = fs.existsSync(ARIAL_BLACK);

describe('polices de marque', () => {
  it.skipIf(!hasArialBlack)('lit le nom de famille inscrit dans le fichier', () => {
    const names = readFontNames(ARIAL_BLACK)!;
    expect(names.family).toBe('Arial Black');
    expect(pangoFont(names, 50)).toBe('Arial Black 50'); // style « Normal » implicite
  });

  it('refuse un fichier qui n’est pas une police', () => {
    const file = path.join(os.tmpdir(), `pas-une-police-${process.pid}.ttf`);
    fs.writeFileSync(file, 'bonjour');
    try {
      expect(readFontNames(file)).toBeNull();
    } finally {
      fs.rmSync(file);
    }
  });

  it('décrit la police pour Pango, « Regular » implicite', () => {
    expect(pangoFont({ family: 'Montserrat Black', style: 'Regular' }, 120.4)).toBe(
      'Montserrat Black 120',
    );
    expect(pangoFont({ family: 'Burbank Big Condensed', style: 'Bold' }, 80)).toBe(
      'Burbank Big Condensed Bold 80',
    );
  });

  it.skipIf(!hasArialBlack)(
    'rend un texte rogné, plus large quand la taille augmente',
    async () => {
      const small = await renderTextWithFont('QUEL HIT ?', ARIAL_BLACK, 40, '#111111');
      const big = await renderTextWithFont('QUEL HIT ?', ARIAL_BLACK, 80, '#111111');
      expect(big.width).toBeGreaterThan(small.width * 1.8);
      expect(small.height).toBeLessThan(40 * 1.2); // rogné au plus près des lettres
    },
  );
});
