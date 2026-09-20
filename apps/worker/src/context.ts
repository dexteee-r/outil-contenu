import {
  accountsDir,
  dataPaths,
  findRepoRoot,
  loadEnv,
  loadPricing,
  type DataPaths,
  type Env,
  type PricingTable,
} from '@outil/core';

/** Tout ce dont une commande a besoin, calculé une fois depuis .env et la racine du repo. */
export interface AppContext {
  repoRoot: string;
  env: Env;
  paths: DataPaths;
  accountsDir: string;
  pricing: PricingTable;
}

export function createContext(): AppContext {
  const repoRoot = findRepoRoot();
  const env = loadEnv({ repoRoot });
  return {
    repoRoot,
    env,
    paths: dataPaths(env, repoRoot),
    accountsDir: accountsDir(env, repoRoot),
    pricing: loadPricing(repoRoot),
  };
}
