import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { OVERLAY_STYLES } from '../schemas/edl.js';

export const CONTENT_TYPES = ['tcg-opening', 'nature-walk', 'generic'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const PLATFORMS = ['youtube-shorts', 'tiktok', 'instagram-reels'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const BUDGET_MODES = ['unlimited', 'threshold', 'cap'] as const;
export type BudgetMode = (typeof BUDGET_MODES)[number];

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'couleur attendue au format #RRGGBB');

const budgetSchema = z.discriminatedUnion('mode', [
  // Suivi informatif seulement
  z.object({ mode: z.literal('unlimited') }).strict(),
  // Alerte au dépassement, sans bloquer
  z.object({ mode: z.literal('threshold'), monthlyLimitEur: z.number().positive() }).strict(),
  // Plafond strict : suspend toute nouvelle génération une fois atteint
  z.object({ mode: z.literal('cap'), monthlyLimitEur: z.number().positive() }).strict(),
]);

/**
 * Config d'un compte/marque : accounts/<slug>/account.yaml.
 * Les chemins sont relatifs au dossier du compte.
 */
export const accountConfigSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'slug en minuscules, chiffres et tirets'),
    displayName: z.string().min(1),
    contentType: z.enum(CONTENT_TYPES).default('generic'),
    platforms: z
      .array(z.enum(PLATFORMS))
      .min(1)
      .default([...PLATFORMS]),
    brand: z
      .object({
        logo: z.string().optional(),
        colors: z
          .object({
            primary: hexColor,
            secondary: hexColor,
            background: hexColor,
            text: hexColor,
          })
          .strict(),
        // Nom de police installée ("Arial") ou chemin vers un .ttf/.otf/.woff2
        fonts: z
          .object({ title: z.string().optional(), body: z.string().optional() })
          .strict()
          .default({}),
      })
      .strict(),
    thumbnailTemplate: z.string().default('thumbnail.json'),
    captionPrompt: z.string().default('prompts/captions.md'),
    knowledgeFiles: z.array(z.string()).default([]),
    musicMoods: z.array(z.string()).default([]),
    durationRange: z
      .object({ min: z.number().int().positive(), max: z.number().int().positive() })
      .strict()
      .refine((r) => r.min <= r.max, 'durationRange.min doit être <= durationRange.max')
      .default({ min: 15, max: 60 }),
    subtitles: z.boolean().default(false),
    /** Textes incrustés autorisés dans la vidéo : hook (accroche du début) seul par défaut — pas de texte descriptif au climax */
    overlays: z.array(z.enum(OVERLAY_STYLES)).default(['hook']),
    budget: budgetSchema.default({ mode: 'unlimited' }),
  })
  .strict();

export type AccountConfig = z.infer<typeof accountConfigSchema>;
export type AccountConfigInput = z.input<typeof accountConfigSchema>;

export interface LoadedAccount {
  config: AccountConfig;
  /** Dossier du compte (accounts/<slug>) */
  dir: string;
  /** Chemins absolus des fichiers référencés par la config */
  files: {
    logo: string | undefined;
    captionPrompt: string;
    thumbnailTemplate: string;
    knowledgeFiles: string[];
    fontTitle: string | undefined;
    fontBody: string | undefined;
  };
  /** Fichiers référencés mais absents : non bloquant, à signaler */
  warnings: string[];
}

export class AccountConfigError extends Error {
  constructor(
    public readonly slug: string,
    public readonly issues: string[],
  ) {
    super(`Config du compte "${slug}" invalide :\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'AccountConfigError';
  }
}

const FONT_FILE_RE = /\.(ttf|otf|woff2?)$/i;

export function listAccounts(accountsDir: string): string[] {
  if (!fs.existsSync(accountsDir)) return [];
  return fs
    .readdirSync(accountsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(accountsDir, d.name, 'account.yaml')))
    .map((d) => d.name)
    .sort();
}

export function parseAccountConfig(raw: unknown, slug: string): AccountConfig {
  const parsed = accountConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AccountConfigError(
      slug,
      parsed.error.issues.map((i) => `${i.path.join('.') || '(racine)'}: ${i.message}`),
    );
  }
  if (parsed.data.slug !== slug) {
    throw new AccountConfigError(slug, [
      `slug "${parsed.data.slug}" différent du nom du dossier "${slug}"`,
    ]);
  }
  return parsed.data;
}

export function loadAccount(slug: string, accountsDir: string): LoadedAccount {
  const dir = path.join(accountsDir, slug);
  const file = path.join(dir, 'account.yaml');
  if (!fs.existsSync(file)) {
    throw new AccountConfigError(slug, [`fichier introuvable : ${file}`]);
  }

  let raw: unknown;
  try {
    raw = parseYaml(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new AccountConfigError(slug, [`YAML illisible : ${(err as Error).message}`]);
  }

  const config = parseAccountConfig(raw, slug);
  const warnings: string[] = [];
  const resolve = (rel: string, label: string, required: boolean): string => {
    const abs = path.resolve(dir, rel);
    if (!fs.existsSync(abs)) {
      warnings.push(
        `${label} introuvable : ${rel}${required ? ' (requis avant le premier run)' : ''}`,
      );
    }
    return abs;
  };
  const resolveFont = (font: string | undefined, label: string): string | undefined =>
    font !== undefined && FONT_FILE_RE.test(font) ? resolve(font, label, false) : undefined;

  return {
    config,
    dir,
    files: {
      logo: config.brand.logo === undefined ? undefined : resolve(config.brand.logo, 'logo', true),
      captionPrompt: resolve(config.captionPrompt, 'prompt légendes', true),
      thumbnailTemplate: resolve(config.thumbnailTemplate, 'gabarit miniature', false),
      knowledgeFiles: config.knowledgeFiles.map((f) =>
        resolve(f, 'document de connaissance', true),
      ),
      fontTitle: resolveFont(config.brand.fonts.title, 'police titre'),
      fontBody: resolveFont(config.brand.fonts.body, 'police texte'),
    },
    warnings,
  };
}
