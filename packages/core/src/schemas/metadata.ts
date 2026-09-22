import { z } from 'zod';
import { PLATFORMS, type Platform } from '../config/account.js';

/**
 * Contrats de livraison : légendes (produites par Claude) et `metadata.json`
 * (écrit par le pipeline dans /ready/<compte>/<content-id>/ à côté de la vidéo et des miniatures).
 */

export const THUMBNAIL_FORMATS = ['9x16', '16x9'] as const;
export type ThumbnailFormat = (typeof THUMBNAIL_FORMATS)[number];

/** Dimensions de sortie par format (décision du 2026-09-20 : les deux sont produits systématiquement). */
export const THUMBNAIL_SIZES: Record<ThumbnailFormat, { width: number; height: number }> = {
  '9x16': { width: 1080, height: 1920 },
  '16x9': { width: 1280, height: 720 },
};

export const captionSchema = z
  .object({
    title: z.string().min(1).max(100),
    description: z.string(),
    hashtags: z.array(
      z.string().regex(/^#?[\p{L}\p{N}_]+$/u, 'hashtag sans espace ni ponctuation'),
    ),
  })
  .strict();
export type Caption = z.infer<typeof captionSchema>;

/** Légendes par plateforme, telles que livrées (seulement les plateformes du compte). */
export const captionsSchema = z.partialRecord(z.enum(PLATFORMS), captionSchema);
export type Captions = z.infer<typeof captionsSchema>;

/**
 * Sortie attendue du modèle de légendes pour un compte donné : une entrée requise par plateforme
 * ciblée, rien d'autre (schéma construit à la volée depuis `account.platforms`).
 */
export function captionsOutputSchemaFor(platforms: readonly Platform[]) {
  const shape = Object.fromEntries(platforms.map((p) => [p, captionSchema])) as Record<
    Platform,
    typeof captionSchema
  >;
  return z
    .object({
      ...shape,
      /** Texte incrusté sur la miniature : 2 à 5 mots, percutant */
      thumbnailTitle: z.string().min(2).max(32),
      /** Sujet à mettre en héros sur la miniature (produit, carte, objet) */
      thumbnailSubject: z
        .object({
          clipId: z.string().min(1),
          atSec: z.number().nonnegative(),
          what: z.string().min(2).max(60),
        })
        .strict(),
    })
    .strict();
}

/** Sépare les légendes par plateforme du titre de miniature dans une sortie du modèle. */
export interface ThumbnailSubject {
  clipId: string;
  atSec: number;
  what: string;
}

export function splitCaptionsOutput(output: Record<string, unknown>): {
  captions: Captions;
  thumbnailTitle: string;
  thumbnailSubject: ThumbnailSubject;
} {
  const { thumbnailTitle, thumbnailSubject, ...rest } = output;
  return {
    captions: captionsSchema.parse(rest),
    thumbnailTitle: String(thumbnailTitle),
    thumbnailSubject: thumbnailSubject as ThumbnailSubject,
  };
}

export const metadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    contentId: z.string().min(1),
    account: z.string().min(1),
    /** Incrémentée à chaque relance sur feedback */
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    video: z
      .object({
        path: z.string().min(1), // relatif au dossier de livraison
        durationSec: z.number().positive(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    thumbnails: z.array(
      z
        .object({
          path: z.string().min(1),
          format: z.enum(THUMBNAIL_FORMATS),
          variant: z.number().int().positive(),
          selected: z.boolean(),
        })
        .strict(),
    ),
    captions: captionsSchema,
    /** Marquage AI Act : ce qui a été généré par IA et par qui */
    aiDisclosure: z
      .object({
        video: z.boolean(),
        images: z.boolean(),
        providers: z.array(z.string()),
      })
      .strict(),
    /** Rushs d'origine (noms de fichiers dans /raw) */
    sourceFiles: z.array(z.string().min(1)),
    /** Modèles utilisés, pour l'historique et les évals */
    models: z
      .object({
        tagging: z.string().optional(),
        edl: z.string().optional(),
        captions: z.string().optional(),
        image: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type Metadata = z.infer<typeof metadataSchema>;

export const METADATA_FILENAME = 'metadata.json';
