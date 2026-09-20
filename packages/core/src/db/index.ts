import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Dossier des migrations SQL générées par `pnpm db:generate` (packages/core/drizzle). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface OpenDbOptions {
  /** Chemin du fichier SQLite, ou ':memory:' pour les tests. */
  file: string;
  /** Applique les migrations manquantes à l'ouverture (défaut : true). */
  migrate?: boolean;
}

export function openDb(options: OpenDbOptions): Db {
  if (options.file !== ':memory:') {
    fs.mkdirSync(path.dirname(options.file), { recursive: true });
  }
  const sqlite = new Database(options.file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  if (options.migrate ?? true) {
    migrateDb(db);
  }
  return db;
}

export function migrateDb(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

export function closeDb(db: Db): void {
  db.$client.close();
}

/** Tables applicatives (sans les tables internes de SQLite ni celles de Drizzle). */
export function listTables(db: Db): string[] {
  return db
    .all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '\\_\\_%' escape '\\' order by name`,
    )
    .map((r) => r.name);
}

export { schema };
