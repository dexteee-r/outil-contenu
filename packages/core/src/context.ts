import { GoogleGenAI, type GenerateContentParameters } from '@google/genai';
import { loadEnv, findRepoRoot, type Env } from './env.js';
import { accountsDir, dataPaths, type DataPaths } from './paths.js';
import { promptsDir } from './prompts/index.js';
import { loadPricing, type PricingTable } from './providers/pricing.js';
import { GeminiProvider, type GeminiProviderOptions, type GeminiSdk } from './providers/gemini.js';
import type { RetryOptions } from './providers/retry.js';
import { KieProvider, type KieProviderOptions } from './providers/kie.js';
import { UsageTracker } from './providers/usage.js';
import type { Db } from './db/index.js';

/** Tout ce dont une commande ou un spike a besoin, calculé une fois depuis .env et la racine du repo. */
export interface AppContext {
  repoRoot: string;
  env: Env;
  paths: DataPaths;
  accountsDir: string;
  promptsDir: string;
  pricing: PricingTable;
}

export function createAppContext(options: { repoRoot?: string } = {}): AppContext {
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const env = loadEnv({ repoRoot });
  return {
    repoRoot,
    env,
    paths: dataPaths(env, repoRoot),
    accountsDir: accountsDir(env, repoRoot),
    promptsDir: promptsDir(repoRoot),
    pricing: loadPricing(repoRoot),
  };
}

export function createUsageTracker(
  ctx: AppContext,
  db: Db,
  onUnknownModel?: (model: string) => void,
): UsageTracker {
  const options: ConstructorParameters<typeof UsageTracker>[1] = {
    pricing: ctx.pricing,
    usdEurRate: ctx.env.USD_EUR_RATE,
  };
  if (onUnknownModel) options.onUnknownModel = onUnknownModel;
  return new UsageTracker(db, options);
}

/** Client Gemini réel, branché sur le suivi des coûts. Exige GEMINI_API_KEY. */
export function createGeminiProvider(
  ctx: AppContext,
  tracker: UsageTracker,
  options?: GeminiProviderOptions,
): GeminiProvider {
  if (!ctx.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY manquante dans .env');
  }
  const ai = new GoogleGenAI({ apiKey: ctx.env.GEMINI_API_KEY });
  // Adaptateur vers le type structurel de GeminiProvider : seule frontière où l'on caste vers le SDK
  const sdk: GeminiSdk = {
    files: {
      upload: (p) => ai.files.upload(p),
      get: (p) => ai.files.get(p),
    },
    models: {
      generateContent: (p) => ai.models.generateContent(p as GenerateContentParameters),
    },
  };
  return new GeminiProvider(sdk, tracker, { retry: retryLog('Gemini'), ...options });
}

/** Client kie.ai (images), branché sur le suivi des coûts. Exige KIE_API_KEY. */
export function createKieProvider(
  ctx: AppContext,
  tracker: UsageTracker,
  options?: KieProviderOptions,
): KieProvider {
  if (!ctx.env.KIE_API_KEY) {
    throw new Error('KIE_API_KEY manquante dans .env');
  }
  return new KieProvider(ctx.env.KIE_API_KEY, tracker, { retry: retryLog('kie.ai'), ...options });
}

/** Journalise chaque nouvelle tentative d'un fournisseur sur la console. */
function retryLog(name: string): RetryOptions {
  return {
    onRetry: ({ attempt, attempts, delayMs, error }) => {
      const reason = error instanceof Error ? error.message.slice(0, 120) : String(error);
      console.warn(
        `  ↻ ${name} indisponible (tentative ${attempt}/${attempts}) : ${reason} — nouvel essai dans ${Math.round(delayMs / 1000)} s`,
      );
    },
  };
}
