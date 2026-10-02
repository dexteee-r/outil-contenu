import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '@outil/core';

/**
 * Sauvegarde à chaque arrêt propre : copie cohérente de la base SQLite (API de sauvegarde de
 * SQLite, sûre même base ouverte) et du dossier accounts/, dans <DATA_ROOT>/backups/<horodatage>/.
 * L'outil ne tournant qu'à la demande, c'est plus sûr qu'une tâche planifiée qui supposerait le PC
 * allumé. Seules les `keep` dernières sauvegardes sont gardées.
 */

export const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, '0');

/** Horodatage local, triable et sans caractère interdit sous Windows. */
export function backupName(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
    `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

export interface BackupOptions {
  db: Db;
  accountsDir: string;
  backupRoot: string;
  keep?: number;
  now?: Date;
}

export async function backupData(o: BackupOptions): Promise<{ dir: string; removed: string[] }> {
  let dir = path.join(o.backupRoot, backupName(o.now ?? new Date()));
  // Deux arrêts dans la même seconde : on ne mélange pas deux sauvegardes
  for (let i = 2; fs.existsSync(dir); i++) dir = `${dir.replace(/~\d+$/, '')}~${i}`;
  fs.mkdirSync(dir, { recursive: true });
  await o.db.$client.backup(path.join(dir, 'outil.sqlite'));
  if (fs.existsSync(o.accountsDir)) {
    fs.cpSync(o.accountsDir, path.join(dir, 'accounts'), {
      recursive: true,
      // Miniatures d'inspiration : œuvres d'autres créateurs, re-téléchargeables, potentiellement lourdes
      filter: (src) => path.basename(src) !== 'inspiration',
    });
  }

  const keep = o.keep ?? 10;
  const all = fs
    .readdirSync(o.backupRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && BACKUP_NAME.test(e.name.replace(/~\d+$/, '')))
    .map((e) => e.name)
    .sort();
  const removed = all.slice(0, Math.max(0, all.length - keep));
  for (const name of removed) fs.rmSync(path.join(o.backupRoot, name), { recursive: true });
  return { dir, removed };
}
