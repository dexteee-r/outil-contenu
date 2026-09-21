import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { composeThumbnail, contactSheet, escapeXml, fitTitle, wrapTitle } from './compose.js';
import {
  DEFAULT_THUMBNAIL_TEMPLATE,
  parseThumbnailTemplate,
  resolveColor,
  thumbnailTemplateSchema,
} from './template.js';

const brand = {
  colors: { primary: '#FFCC00', secondary: '#1A1A2E', background: '#0F0F1A', text: '#FFFFFF' },
  fonts: {},
};

describe('thumbnailTemplateSchema', () => {
  it('fournit un gabarit complet par défaut, pour les deux formats', () => {
    expect(DEFAULT_THUMBNAIL_TEMPLATE.formats['9x16'].title.maxLines).toBe(3);
    expect(DEFAULT_THUMBNAIL_TEMPLATE.formats['16x9'].title.align).toBe('left');
    expect(DEFAULT_THUMBNAIL_TEMPLATE.font.uppercase).toBe(true);
  });

  it('accepte une surcharge partielle et refuse les clés inconnues ou hors bornes', () => {
    const tpl = parseThumbnailTemplate({
      formats: { '9x16': { title: { x: 0.1, y: 0.7, w: 0.8 } } },
    });
    expect(tpl.formats['9x16'].title).toEqual({
      x: 0.1,
      y: 0.7,
      w: 0.8,
      maxLines: 3,
      align: 'center',
      fontSize: 0.085,
    });
    expect(tpl.formats['16x9']).toEqual(DEFAULT_THUMBNAIL_TEMPLATE.formats['16x9']);
    expect(thumbnailTemplateSchema.safeParse({ police: 'x' }).success).toBe(false);
    expect(
      thumbnailTemplateSchema.safeParse({ formats: { '9x16': { title: { x: 2, y: 0, w: 1 } } } })
        .success,
    ).toBe(false);
  });

  it('résout les couleurs de marque ou laisse les hex', () => {
    expect(resolveColor('brand.primary', brand)).toBe('#FFCC00');
    expect(resolveColor('#123456', brand)).toBe('#123456');
  });
});

describe('wrapTitle / fitTitle / escapeXml', () => {
  it('coupe aux espaces sans dépasser la largeur', () => {
    expect(wrapTitle('PULL ULTRA RARE DANS CE BOOSTER', 12)).toEqual([
      'PULL ULTRA',
      'RARE DANS CE',
      'BOOSTER',
    ]);
    expect(wrapTitle('INCROYABLEMENT', 6)).toEqual(['INCROY', 'ABLEME', 'NT']);
    expect(wrapTitle('   ', 10)).toEqual([]);
  });

  it('réduit la police jusqu’à respecter maxLines, puis tronque', () => {
    const short = fitTitle('PULL', 800, 100, 3);
    expect(short).toEqual({ fontSize: 100, lines: ['PULL'] });
    const long = fitTitle('UNE PHRASE VRAIMENT TRÈS LONGUE POUR UNE MINIATURE', 600, 100, 2);
    expect(long.fontSize).toBeLessThan(100);
    expect(long.lines.length).toBeLessThanOrEqual(2);
  });

  it('échappe les caractères XML', () => {
    expect(escapeXml(`<a & "b" 'c'>`)).toBe('&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;');
  });
});

describe('composeThumbnail', () => {
  const background = () =>
    sharp({ create: { width: 640, height: 640, channels: 3, background: '#3355AA' } })
      .png()
      .toBuffer();

  it('produit un PNG aux dimensions du format, avec le titre ajusté', async () => {
    const bg = await background();
    for (const [format, size] of [
      ['9x16', [1080, 1920]],
      ['16x9', [1280, 720]],
    ] as const) {
      const out = await composeThumbnail({
        background: bg,
        format,
        template: DEFAULT_THUMBNAIL_TEMPLATE,
        brand,
        title: 'Pull ultra rare & <réaction>',
      });
      const meta = await sharp(out.png).metadata();
      expect([meta.width, meta.height]).toEqual(size);
      expect(meta.format).toBe('png');
      expect(out.fitted.lines.join(' ')).toBe('PULL ULTRA RARE & <RÉACTION>');
    }
  }, 30_000);

  it('incruste un logo quand la zone existe', async () => {
    const logo = await sharp({
      create: { width: 200, height: 100, channels: 4, background: '#FF0000FF' },
    })
      .png()
      .toBuffer();
    const out = await composeThumbnail({
      background: await background(),
      format: '9x16',
      template: DEFAULT_THUMBNAIL_TEMPLATE,
      brand,
      title: 'X',
      logo,
    });
    // pixel au centre de la zone logo (x 0.06+0.11, y ≈ 0.05+0.03) : rouge du logo
    const { data } = await sharp(out.png)
      .extract({ left: Math.round(0.17 * 1080), top: Math.round(0.08 * 1920), width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200);
    expect(data[1]).toBeLessThan(80);
  }, 30_000);

  it('assemble une planche contact, avec étiquettes optionnelles', async () => {
    const bg = await background();
    const sheet = await contactSheet([bg, bg, bg, bg], { columns: 2, cellWidth: 100 });
    const meta = await sharp(sheet).metadata();
    expect(meta.width).toBe(2 * 100 + 3 * 12);
    expect(meta.height).toBe(2 * 100 + 3 * 12);
    const labelled = await contactSheet([bg, bg], {
      columns: 2,
      cellWidth: 100,
      labels: ['a', 'b'],
    });
    const m2 = await sharp(labelled).metadata();
    expect(m2.height).toBe(100 + 9 + 2 * 12); // bandeau de 9 px (9 % de la largeur)
  });
});
