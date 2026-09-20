import { defineConfig } from 'drizzle-kit';

// Sert uniquement à `drizzle-kit generate` (création des fichiers SQL de migration).
// L'application des migrations se fait dans le code via `migrateDb()` (src/db/index.ts).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
