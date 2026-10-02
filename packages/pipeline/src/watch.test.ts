import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { apiCalls, closeDb, contents, jobs, makeSyntheticClip, openDb, type Db } from '@outil/core';
import { createPipelineContext, type PipelineContext } from './context.js';
import type { StepFn } from './runner.js';
import {
  autoRetryCandidates,
  InboxTracker,
  PROCESSED_MARKER,
  runWatcher,
  scanInbox,
  SYNCTHING_TEMP,
  WatchControl,
  type InboxFolder,
} from './watch.js';
import { makeTestContext, writeTestAccount } from './test-helpers.js';

let dir: string;
let db: Db;
afterEach(() => {
  closeDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(): { p: PipelineContext; raw: string; logs: string[] } {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outil-watch-'));
  writeTestAccount(dir, 'tcg');
  db = openDb({ file: ':memory:' });
  const logs: string[] = [];
  const p = createPipelineContext(makeTestContext(dir), db, (m) => logs.push(m));
  const raw = p.ctx.paths.raw('tcg');
  fs.mkdirSync(raw, { recursive: true });
  return { p, raw, logs };
}

const folder = (raw: string, name: string, files: Record<string, string>) => {
  const d = path.join(raw, name);
  fs.mkdirSync(d, { recursive: true });
  for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(d, f), content);
  return d;
};

describe('scanInbox', () => {
  it('liste les dossiers non traités, repère les transferts Syncthing en cours', () => {
    const { p, raw } = setup();
    folder(raw, '2026-09-26', { 'a.MOV': 'x', 'notes.txt': 'y' });
    folder(raw, '2026-09-27', { 'b.mp4': 'x', '.syncthing.c.mp4.tmp': 'partiel' });
    folder(raw, '2026-09-28', { 'c.mp4': 'x', [PROCESSED_MARKER]: '{}' });
    const known = folder(raw, '2026-09-29', { 'd.mp4': 'x' });
    db.insert(contents).values({ id: 'tcg-x', account: 'tcg', sourceDir: known }).run();
    folder(raw, 'vide', { 'lisez-moi.txt': 'x' });

    const found = scanInbox(p);
    expect(found.map((f) => path.basename(f.dir)).sort()).toEqual([
      '2026-09-26',
      '2026-09-27',
      'vide',
    ]);
    const byName = Object.fromEntries(found.map((f) => [path.basename(f.dir), f]));
    expect(byName['2026-09-26']!.videos).toEqual(['a.MOV']);
    expect(byName['2026-09-27']!.hasTemp).toBe(true);
    expect(byName['2026-09-27']!.videos).toEqual(['b.mp4']); // le .tmp n'est pas une vidéo
    expect(byName.vide!.videos).toEqual([]);
  });

  it('reconnaît les fichiers temporaires de Syncthing', () => {
    expect(SYNCTHING_TEMP.test('.syncthing.IMG_0042.MOV.tmp')).toBe(true);
    expect(SYNCTHING_TEMP.test('~syncthing~IMG_0042.MOV.tmp')).toBe(true);
    expect(SYNCTHING_TEMP.test('IMG_0042.MOV')).toBe(false);
  });
});

describe('InboxTracker', () => {
  const f = (signature: string, extra: Partial<InboxFolder> = {}): InboxFolder => ({
    account: 'tcg',
    dir: '/raw/tcg/d',
    videos: ['a.mp4'],
    hasTemp: false,
    signature,
    ...extra,
  });

  it('attend la période de calme, repart de zéro si le dossier bouge', () => {
    let t = 0;
    const tracker = new InboxTracker(120_000, () => t);
    expect(tracker.ready([f('a:1')])).toEqual([]); // découvert
    t = 60_000;
    expect(tracker.ready([f('a:1')])).toEqual([]); // pas encore calme
    t = 90_000;
    expect(tracker.ready([f('a:2')])).toEqual([]); // le fichier grossit : on recommence
    t = 200_000;
    expect(tracker.ready([f('a:2')])).toEqual([]); // 110 s seulement
    t = 210_000;
    expect(tracker.ready([f('a:2')])).toHaveLength(1);
  });

  it('jamais prêt pendant un transfert ni sans vidéo ; prêt tout de suite sans période de calme', () => {
    let t = 0;
    const tracker = new InboxTracker(1000, () => t);
    tracker.ready([f('s', { hasTemp: true })]);
    t = 10_000;
    expect(tracker.ready([f('s', { hasTemp: true })])).toEqual([]);
    expect(tracker.ready([f('s', { videos: [] })])).toEqual([]);
    expect(new InboxTracker(0).ready([f('s')])).toHaveLength(1);
  });
});

describe('runWatcher', () => {
  /** Étapes neutres : le worker est testé, pas le pipeline ; « deliver » marque le contenu prêt. */
  const neutral = (p: PipelineContext, extra: Partial<Record<string, StepFn>> = {}) => {
    const noop: StepFn = () => Promise.resolve();
    const deliver: StepFn = (_p, s) => {
      p.db.update(contents).set({ status: 'ready' }).where(eq(contents.id, s.contentId)).run();
      return Promise.resolve();
    };
    return {
      tag: noop,
      edl: noop,
      render: noop,
      captions: noop,
      thumbnail: noop,
      qc: noop,
      deliver,
      notify: noop,
      ...extra,
    };
  };

  it('traite un dossier déposé, pose le marqueur, ne le retraite pas', async () => {
    const { p, raw } = setup();
    const d = path.join(raw, '2026-09-26');
    fs.mkdirSync(d);
    await makeSyntheticClip({
      out: path.join(d, 'rush.mp4'),
      durationSec: 1,
      width: 64,
      height: 128,
      fps: 12,
    });

    const n = await runWatcher(p, { quietMs: 60_000, intervalMs: 10, once: true, run: neutral(p) });
    expect(n).toBe(1);
    const marker = JSON.parse(fs.readFileSync(path.join(d, PROCESSED_MARKER), 'utf8')) as {
      status: string;
      contentId: string;
    };
    expect(marker.status).toBe('ready');
    expect(db.select().from(contents).get()!.status).toBe('ready');

    expect(await runWatcher(p, { quietMs: 0, intervalMs: 10, once: true, run: neutral(p) })).toBe(
      0,
    );
  }, 60_000);

  it('arrêt propre : interrompu entre deux étapes, repris au lancement suivant', async () => {
    const { p, raw, logs } = setup();
    const d = path.join(raw, '2026-09-26');
    fs.mkdirSync(d);
    await makeSyntheticClip({
      out: path.join(d, 'rush.mp4'),
      durationSec: 1,
      width: 64,
      height: 128,
      fps: 12,
    });

    const controller = new AbortController();
    const stopDuringTag: StepFn = () => {
      controller.abort(); // Ctrl+C pendant le dérushage
      return Promise.resolve();
    };
    await runWatcher(p, {
      quietMs: 0,
      intervalMs: 10,
      once: true,
      signal: controller.signal,
      run: neutral(p, { tag: stopDuringTag }),
    });
    const row = db.select().from(contents).get()!;
    expect(row.status).toBe('interrupted');
    expect(db.select().from(jobs).get()!.status).toBe('interrupted');
    expect(logs.some((l) => l.includes('interrompu avant « edl »'))).toBe(true);

    const executed: string[] = [];
    const track =
      (name: string): StepFn =>
      () => {
        executed.push(name);
        return Promise.resolve();
      };
    const n = await runWatcher(p, {
      quietMs: 0,
      intervalMs: 10,
      once: true,
      run: neutral(p, { tag: track('tag'), edl: track('edl') }),
    });
    expect(n).toBe(1);
    expect(executed).toEqual(['edl']); // le dérushage, terminé avant l'arrêt, n'est pas refait
    expect(db.select().from(contents).get()!.status).toBe('ready');
  }, 60_000);

  it('en pause : rien ne part tout seul, « traiter maintenant » passe quand même', async () => {
    const { p, raw } = setup();
    const d = path.join(raw, '2026-09-26');
    fs.mkdirSync(d);
    await makeSyntheticClip({
      out: path.join(d, 'rush.mp4'),
      durationSec: 1,
      width: 64,
      height: 128,
      fps: 12,
    });
    const control = new WatchControl();
    control.paused = true;
    const opts = { quietMs: 0, intervalMs: 10, once: true, run: neutral(p), control };

    expect(await runWatcher(p, opts)).toBe(0);
    expect(fs.existsSync(path.join(d, PROCESSED_MARKER))).toBe(false);
    expect(control.lastScan?.folders.map((f) => f.dir)).toEqual([d]); // toujours visible

    control.scanNow();
    expect(await runWatcher(p, opts)).toBe(1);
    expect(fs.existsSync(path.join(d, PROCESSED_MARKER))).toBe(true);
  }, 60_000);

  it('plafond atteint : le dossier attend, sans marqueur ni contenu créé, une seule alerte', async () => {
    const { p, raw, logs } = setup();
    writeTestAccount(dir, 'tcg', { budget: { mode: 'cap', monthlyLimitEur: 0.01 } });
    db.insert(apiCalls)
      .values({
        module: 'edl',
        provider: 'anthropic',
        model: 'x',
        account: 'tcg',
        costEur: 0.02,
        durationMs: 1,
        status: 'ok',
      })
      .run();
    const d = folder(raw, '2026-10-03', { 'rush.mp4': 'x' });
    const control = new WatchControl();
    const opts = { quietMs: 0, intervalMs: 10, once: true, run: neutral(p), control };

    expect(await runWatcher(p, opts)).toBe(0);
    expect(fs.existsSync(path.join(d, PROCESSED_MARKER))).toBe(false);
    expect(db.select().from(contents).all()).toEqual([]);
    expect(logs.filter((l) => l.includes('budget tcg : plafond atteint'))).toHaveLength(1);
    expect(logs.some((l) => l.startsWith('⛔') && l.includes('en attente'))).toBe(true);
  });

  it('nouvel essai automatique : panne passagère seulement, après 30 min, 3 échecs au plus', () => {
    const { p } = setup();
    const now = Date.parse('2026-10-03T12:00:00Z');
    const ago = (min: number) => new Date(now - min * 60_000).toISOString();
    const content = (id: string, failures: { error: string; at: string }[], done = false) => {
      db.insert(contents)
        .values({ id, account: 'tcg', sourceDir: `/raw/${id}`, status: 'failed' })
        .run();
      if (done) db.insert(jobs).values({ contentId: id, status: 'done' }).run();
      for (const f of failures) {
        db.insert(jobs)
          .values({ contentId: id, status: 'failed', error: f.error, finishedAt: f.at })
          .run();
      }
    };
    const overloaded = '{"error":{"code":503,"message":"high demand","status":"UNAVAILABLE"}}';
    content('a-surcharge', [{ error: overloaded, at: ago(45) }]);
    content('b-trop-tot', [{ error: overloaded, at: ago(10) }]);
    content('c-quota-jour', [{ error: 'Quota exceeded: GenerateRequestsPerDay', at: ago(90) }]);
    content('d-contrat', [{ error: 'EDL invalide : segment hors clip', at: ago(90) }]);
    content('e-trois-echecs', [
      { error: overloaded, at: ago(200) },
      { error: overloaded, at: ago(120) },
      { error: overloaded, at: ago(60) },
    ]);
    // Deux échecs, mais après un succès antérieur (feedback) : le compteur repart de zéro
    content('f-apres-succes', [{ error: overloaded, at: ago(60) }], true);

    expect(autoRetryCandidates(p, now)).toEqual([
      { contentId: 'a-surcharge', failures: 1 },
      { contentId: 'f-apres-succes', failures: 1 },
    ]);
  });

  it('dossier illisible : marqueur « failed » et alerte, pas de boucle', async () => {
    const { p, raw, logs } = setup();
    const d = folder(raw, '2026-09-26', { 'casse.mp4': 'pas une vidéo' });
    await runWatcher(p, { quietMs: 0, intervalMs: 10, once: true, run: neutral(p) });
    const marker = JSON.parse(fs.readFileSync(path.join(d, PROCESSED_MARKER), 'utf8')) as {
      status: string;
    };
    expect(marker.status).toBe('failed');
    expect(logs.some((l) => l.includes('échec non relayé'))).toBe(true); // pas de webhook en test
    expect(await runWatcher(p, { quietMs: 0, intervalMs: 10, once: true, run: neutral(p) })).toBe(
      0,
    );
  }, 60_000);
});
