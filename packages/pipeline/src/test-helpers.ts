import fs from 'node:fs';
import path from 'node:path';
import {
  accountsDir,
  dataPaths,
  envSchema,
  findRepoRoot,
  promptsDir,
  type AppContext,
} from '@outil/core';

/**
 * Aides de test : un contexte d'application isolé dans un dossier temporaire (données, comptes),
 * qui réutilise les prompts et la grille tarifaire du repo.
 */
export function makeTestContext(dir: string, extraEnv: Record<string, string> = {}): AppContext {
  const env = envSchema.parse({
    DATA_ROOT: path.join(dir, 'data'),
    ACCOUNTS_DIR: path.join(dir, 'accounts'),
    MODEL_TAGGING: 'gemini-test',
    MODEL_IMAGE: 'gpt-image-2',
    ...extraEnv,
  });
  const repoRoot = findRepoRoot(import.meta.dirname);
  return {
    repoRoot,
    env,
    paths: dataPaths(env, dir),
    accountsDir: accountsDir(env, dir),
    promptsDir: promptsDir(repoRoot),
    pricing: {},
  };
}

/** Compte minimal valide dans <dir>/accounts/<slug>. */
export function writeTestAccount(
  dir: string,
  slug: string,
  overrides: Record<string, unknown> = {},
): void {
  const accountDir = path.join(dir, 'accounts', slug);
  fs.mkdirSync(path.join(accountDir, 'prompts'), { recursive: true });
  const yaml = [
    `slug: ${slug}`,
    `displayName: ${slug.toUpperCase()}`,
    'contentType: tcg-opening',
    'platforms: [youtube-shorts, tiktok]',
    'brand:',
    '  colors: { primary: "#FFCC00", secondary: "#1A1A2E", background: "#0F0F1A", text: "#FFFFFF" }',
    'musicMoods: [hype]',
    'durationRange: { min: 15, max: 60 }',
    ...Object.entries(overrides).map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
  ].join('\n');
  fs.writeFileSync(path.join(accountDir, 'account.yaml'), yaml);
  fs.writeFileSync(path.join(accountDir, 'prompts', 'captions.md'), 'Ton : enthousiaste.');
}
