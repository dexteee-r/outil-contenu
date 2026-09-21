import { z } from 'zod';
import type { AccountConfig } from '../config/account.js';
import { THUMBNAIL_FORMATS, type ThumbnailFormat } from '../schemas/metadata.js';

/**
 * Gabarit de miniature d'un compte : accounts/<slug>/thumbnail.json.
 * Toutes les positions sont des fractions (0..1) de la largeur/hauteur du format,
 * pour que le même gabarit logique se décline en 9x16 et 16x9.
 * Zod 4 : prefault() (valeur d'entrée, re-parsée) plutôt que default() pour que les
 * sous-objets reçoivent eux aussi leurs valeurs par défaut.
 */

const fraction = z.number().min(0).max(1);

export const zoneSchema = z.object({ x: fraction, y: fraction, w: fraction }).strict();
export type Zone = z.infer<typeof zoneSchema>;

export const titleZoneSchema = zoneSchema
  .extend({
    maxLines: z.number().int().min(1).max(4).default(3),
    align: z.enum(['left', 'center']).default('center'),
    /** Taille de police max, en fraction de la hauteur de l'image */
    fontSize: z.number().min(0.02).max(0.2).default(0.085),
  })
  .strict();
export type TitleZone = z.infer<typeof titleZoneSchema>;

export const formatTemplateSchema = z
  .object({
    title: titleZoneSchema,
    logo: zoneSchema.nullable().default(null), // default (pas prefault) : null est déjà une sortie valide
    /** Voile sombre du bas : commence à `from` (fraction de la hauteur), opacité max `opacity` */
    gradient: z
      .object({ from: fraction, opacity: fraction })
      .strict()
      .prefault({ from: 0.45, opacity: 0.85 }),
  })
  .strict();
export type FormatTemplate = z.infer<typeof formatTemplateSchema>;

/** Référence à une couleur de la marque (`brand.primary`…) ou couleur #RRGGBB. */
const colorRef = z.union([
  z.enum(['brand.primary', 'brand.secondary', 'brand.background', 'brand.text']),
  z.string().regex(/^#[0-9a-fA-F]{6}$/),
]);
export type ColorRef = z.infer<typeof colorRef>;

export const THUMBNAIL_STYLES = ['screen', 'card', 'photo'] as const;
export type ThumbnailStyle = (typeof THUMBNAIL_STYLES)[number];

export const thumbnailTemplateSchema = z
  .object({
    /**
     * screen : capture réelle de la vidéo plein cadre, traitement miniature YouTube (défaut).
     * card : image clé en vignette inclinée sur fond de marque. photo : visuel plein cadre IA ou
     * image clé + voile. Aucun style n'exige d'image IA sauf photo avec fournisseur configuré.
     */
    style: z.enum(THUMBNAIL_STYLES).default('screen'),
    /** Pastille d'appel à l'action du style card (null = aucune) */
    cta: z.string().min(1).max(24).nullable().default('REGARDE'),
    formats: z
      .object({
        '9x16': formatTemplateSchema.prefault({
          title: { x: 0.06, y: 0.6, w: 0.88, maxLines: 3, align: 'center', fontSize: 0.085 },
          logo: { x: 0.06, y: 0.05, w: 0.22 },
          gradient: { from: 0.45, opacity: 0.85 },
        }),
        '16x9': formatTemplateSchema.prefault({
          title: { x: 0.05, y: 0.5, w: 0.6, maxLines: 2, align: 'left', fontSize: 0.16 },
          logo: { x: 0.82, y: 0.06, w: 0.14 },
          gradient: { from: 0.35, opacity: 0.8 },
        }),
      })
      .strict()
      .prefault({}),
    font: z
      .object({
        family: z.string().default('Impact, "Arial Black", Arial, sans-serif'),
        weight: z.number().int().default(900),
        uppercase: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    colors: z
      .object({
        text: colorRef.default('brand.text'),
        stroke: colorRef.default('brand.secondary'),
        highlight: colorRef.default('brand.primary'),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export type ThumbnailTemplate = z.infer<typeof thumbnailTemplateSchema>;

/** Gabarit avec toutes les valeurs par défaut (utilisé si thumbnail.json est absent). */
export const DEFAULT_THUMBNAIL_TEMPLATE: ThumbnailTemplate = thumbnailTemplateSchema.parse({});

export function parseThumbnailTemplate(raw: unknown): ThumbnailTemplate {
  return thumbnailTemplateSchema.parse(raw);
}

export function resolveColor(ref: ColorRef, brand: AccountConfig['brand']): string {
  switch (ref) {
    case 'brand.primary':
      return brand.colors.primary;
    case 'brand.secondary':
      return brand.colors.secondary;
    case 'brand.background':
      return brand.colors.background;
    case 'brand.text':
      return brand.colors.text;
    default:
      return ref;
  }
}

export function isThumbnailFormat(value: string): value is ThumbnailFormat {
  return (THUMBNAIL_FORMATS as readonly string[]).includes(value);
}
