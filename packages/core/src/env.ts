import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());

export const envSchema = z.object({
  DATA_ROOT: z.string().min(1).default('./data'),
  ACCOUNTS_DIR: optionalString,
  DB_PATH: optionalString,

  GEMINI_API_KEY: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  IDEOGRAM_API_KEY: optionalString,
  KIE_API_KEY: optionalString,

  /** Fournisseur des miniatures : gemini (clé Google) ou kie (kie.ai, plusieurs modèles) */
  IMAGE_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['gemini', 'kie']).default('gemini')),
  MODEL_TAGGING: optionalString,
  MODEL_IMAGE: optionalString,
  MODEL_EDL: z.preprocess(emptyToUndefined, z.string().default('claude-sonnet-5')),
  MODEL_CAPTIONS: z.preprocess(emptyToUndefined, z.string().default('claude-sonnet-5')),
  MODEL_JUDGE: z.preprocess(emptyToUndefined, z.string().default('claude-sonnet-5')),

  /** Webhook Discord : messages « prêt » (miniature en pièce jointe) et « échec » */
  DISCORD_WEBHOOK_URL: optionalUrl,
  /** Alternative : webhooks n8n qui reçoivent le JSON brut et routent eux-mêmes */
  N8N_WEBHOOK_READY_URL: optionalUrl,
  N8N_WEBHOOK_FAILED_URL: optionalUrl,

  /** Surveillance de /raw : minutes sans changement avant de traiter un dossier */
  WATCH_QUIET_MINUTES: z.coerce.number().positive().default(2),
  /** Alerte quand l'espace libre du disque des données passe sous ce seuil (Go) */
  DISK_ALERT_FREE_GB: z.coerce.number().positive().default(50),

  USD_EUR_RATE: z.coerce.number().positive().default(0.92),
});

export type Env = z.infer<typeof envSchema>;

/** Remonte depuis `from` jusqu'au dossier qui contient pnpm-workspace.yaml (racine du repo). */
export function findRepoRoot(from: string = process.cwd()): string {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(from);
    dir = parent;
  }
}

/** Charge `.env` à la racine du repo (sans écraser les variables déjà présentes), puis valide. */
export function loadEnv(options: { repoRoot?: string; source?: NodeJS.ProcessEnv } = {}): Env {
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const envFile = path.join(repoRoot, '.env');
  if (!options.source && fs.existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  const parsed = envSchema.safeParse(options.source ?? process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Variables d'environnement invalides (.env) :\n${issues}`);
  }
  return parsed.data;
}
