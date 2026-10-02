import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, contents, openDb, type Db } from '@outil/core';
import { backupData, backupName } from './backup.js';

let dir: string;
let db: Db;
afterEach(() => {
  closeDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('backupData', () => {
  it('copie la base et accounts/ (sans les miniatures d’inspiration), garde les 10 dernières', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-backup-'));
    db = openDb({ file: path.join(dir, 'outil.sqlite') });
    db.insert(contents).values({ id: 'tcg-x', account: 'tcg', sourceDir: 'raw/tcg/x' }).run();
    const accounts = path.join(dir, 'accounts');
    fs.mkdirSync(path.join(accounts, 'tcg', 'inspiration'), { recursive: true });
    fs.writeFileSync(path.join(accounts, 'tcg', 'account.yaml'), 'slug: tcg');
    fs.writeFileSync(path.join(accounts, 'tcg', 'inspiration', 'yt.jpg'), 'x');
    const backupRoot = path.join(dir, 'backups');
    // 10 sauvegardes plus anciennes, et un dossier étranger qu'on ne touche pas
    for (let d = 1; d <= 10; d++) {
      fs.mkdirSync(path.join(backupRoot, `2026-09-${String(d).padStart(2, '0')}_10-00-00`), {
        recursive: true,
      });
    }
    fs.mkdirSync(path.join(backupRoot, 'à garder'));

    const now = new Date(2026, 9, 2, 18, 5, 9);
    const { dir: out, removed } = await backupData({ db, accountsDir: accounts, backupRoot, now });
    expect(path.basename(out)).toBe('2026-10-02_18-05-09');
    const copy = openDb({ file: path.join(out, 'outil.sqlite'), migrate: false });
    expect(copy.select({ id: contents.id }).from(contents).all()).toEqual([{ id: 'tcg-x' }]);
    closeDb(copy);
    expect(fs.readFileSync(path.join(out, 'accounts', 'tcg', 'account.yaml'), 'utf8')).toBe(
      'slug: tcg',
    );
    expect(fs.existsSync(path.join(out, 'accounts', 'tcg', 'inspiration'))).toBe(false);
    expect(removed).toEqual(['2026-09-01_10-00-00']);
    expect(fs.existsSync(path.join(backupRoot, 'à garder'))).toBe(true);

    // Deuxième arrêt dans la même seconde : dossier distinct
    const again = await backupData({ db, accountsDir: accounts, backupRoot, now });
    expect(path.basename(again.dir)).toBe('2026-10-02_18-05-09~2');
  });

  it('horodatage local triable', () => {
    expect(backupName(new Date(2026, 0, 5, 7, 8, 9))).toBe('2026-01-05_07-08-09');
  });
});
