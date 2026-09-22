import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  arrowSvg,
  bleedCenter,
  composeDuoThumbnail,
  dominantHue,
  hexToHsl,
  hslToHex,
  isSkinTone,
  prepareSticker,
  touchingEdges,
} from './duo.js';
import { DEFAULT_THUMBNAIL_TEMPLATE } from './template.js';

const brand = {
  colors: { primary: '#FFCC00', secondary: '#1A1A2E', background: '#0F0F1A', text: '#FFFFFF' },
  fonts: {},
};

/** Sujet détouré synthétique : un rectangle coloré au milieu d'un canevas transparent. */
const subject = (color: string, opts: { w?: number; h?: number; left?: number } = {}) => {
  const w = opts.w ?? 60;
  const h = opts.h ?? 100;
  return sharp({
    create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: { create: { width: w, height: h, channels: 4, background: color } },
        left: opts.left ?? 70,
        top: 50,
      },
    ])
    .png()
    .toBuffer();
};

describe('couleurs', () => {
  it('convertit hex ↔ hsl', () => {
    const hsl = hexToHsl('#6633cc');
    expect(hsl.h).toBeCloseTo(260, 0);
    expect(hslToHex(hsl)).toBe('#6633cc');
  });

  it('trouve la teinte des grandes surfaces, pas des gris ni de la peau', async () => {
    const purple = (await dominantHue(await subject('#5a3c8c')))!;
    expect(purple).toBeGreaterThan(250);
    expect(purple).toBeLessThan(290);
    expect(await dominantHue(await subject('#808080'))).toBeNull();
    expect(await dominantHue(await subject('#c89678'))).toBeNull(); // ton chair
    expect(await dominantHue(await subject('#dc3c5a'))).toBeGreaterThan(330); // rouge de carte
  });

  it('reconnaît la peau et les gris chauds, pas le rouge ni l’orange vif', () => {
    expect(isSkinTone(200, 150, 120)).toBe(true);
    expect(isSkinTone(137, 104, 112)).toBe(true); // gris chaud
    expect(isSkinTone(220, 60, 90)).toBe(false); // cadre de carte rouge
    expect(isSkinTone(240, 120, 20)).toBe(false); // boîte orange
    expect(isSkinTone(74, 60, 93)).toBe(false); // violet terne
  });
});

describe('sujets détourés', () => {
  it('détecte les bords coupés, pas ceux d’une image opaque', async () => {
    expect(await touchingEdges(await subject('#ff0000'))).toEqual({
      left: false,
      right: false,
      top: false,
      bottom: false,
    });
    const hand = await subject('#ff0000', { w: 130, left: 70 }); // touche le bord droit
    expect((await touchingEdges(hand)).right).toBe(true);
    const opaque = await sharp({
      create: { width: 50, height: 50, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    expect(Object.values(await touchingEdges(opaque)).some(Boolean)).toBe(false);
  });

  it('met à l’échelle, ajoute la marge du liseré et garde la taille du sujet', async () => {
    const s = await prepareSticker(await subject('#ff0000'), {
      heightPx: 300,
      maxWidthPx: 1000,
      tiltDeg: 0,
      outline: { color: '#ffffff', widthPx: 8 },
      glow: { color: '#ff0000', radiusPx: 20, strength: 2 },
      shadow: true,
    });
    expect(s.contentHeight).toBe(300);
    expect(s.contentWidth).toBe(180);
    expect(s.width).toBeGreaterThan(180);
    expect(s.height).toBeGreaterThan(300);
  });

  it('fait sortir du cadre le côté coupé (main qui entre par la droite)', () => {
    const at = bleedCenter(
      { cx: 0.7, cy: 0.5, tiltDeg: 0 },
      {
        contentWidth: 400,
        contentHeight: 600,
        edges: { left: false, right: true, top: false, bottom: false },
      },
      1280,
      720,
    );
    expect(at.cx + 200).toBeGreaterThan(1280); // bord droit du sujet hors canevas
    expect(at.cy).toBe(360);
    const still = bleedCenter(
      { cx: 0.3, cy: 0.5, tiltDeg: 0 },
      {
        contentWidth: 400,
        contentHeight: 600,
        edges: { left: false, right: true, top: false, bottom: false },
      },
      1280,
      720,
    );
    expect(still.cx).toBe(384); // emplacement à gauche : on ne traverse pas l'image
  });

  it('dessine une flèche', () => {
    const svg = arrowSvg(100, 100, [10, 10], [90, 50], 0.3, 4);
    expect(svg).toContain('<path');
    expect(svg).toContain('<polygon');
  });
});

describe('composeDuoThumbnail', () => {
  it('compose les deux formats, avec ou sans carte, variante teaser comprise', async () => {
    const hero = await subject('#5a3c8c');
    const card = await subject('#d02030', { w: 130 });
    for (const format of ['9x16', '16x9'] as const) {
      for (const [secondary, tease] of [
        [card, false],
        [card, true],
        [null, false],
      ] as const) {
        const out = await composeDuoThumbnail({
          hero,
          secondary,
          format,
          template: DEFAULT_THUMBNAIL_TEMPLATE,
          brand,
          title: 'Quel hit ?',
          tease,
        });
        const meta = await sharp(out.png).metadata();
        expect([meta.width, meta.height]).toEqual(format === '9x16' ? [1080, 1920] : [1280, 720]);
        expect(hexToHsl(out.palette.mid).h).toBeGreaterThan(240); // fond dans la couleur du produit
      }
    }
  }, 60_000);

  it('accepte un sujet non détouré (image opaque)', async () => {
    const opaque = await sharp({
      create: { width: 90, height: 160, channels: 3, background: '#2050c0' },
    })
      .jpeg()
      .toBuffer();
    const out = await composeDuoThumbnail({
      hero: opaque,
      secondary: opaque,
      format: '16x9',
      template: DEFAULT_THUMBNAIL_TEMPLATE,
      brand,
      title: 'Test',
    });
    expect(out.width).toBe(1280);
  }, 30_000);
});
