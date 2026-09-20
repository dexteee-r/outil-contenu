import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, listTables, openDb, type Db } from './index.js';
import { contents, jobs, jobSteps } from './schema.js';

let db: Db | undefined;

afterEach(() => {
  if (db) closeDb(db);
  db = undefined;
});

describe('openDb + migrations', () => {
  it('crée les cinq tables du cahier', () => {
    db = openDb({ file: ':memory:' });
    expect(listTables(db)).toEqual(['api_calls', 'contents', 'feedback', 'job_steps', 'jobs']);
  });

  it('est idempotent (deux ouvertures migrent sans erreur)', () => {
    db = openDb({ file: ':memory:' });
    expect(() => openDb({ file: ':memory:' })).not.toThrow();
  });

  it('insère un contenu, un job et une étape avec les défauts', () => {
    db = openDb({ file: ':memory:' });
    db.insert(contents)
      .values({ id: 'tcg-2026-09-20-abcd', account: 'tcg', sourceDir: 'raw/tcg/2026-09-20' })
      .run();
    const job = db.insert(jobs).values({ contentId: 'tcg-2026-09-20-abcd' }).returning().get();
    expect(job?.status).toBe('queued');
    expect(job?.kind).toBe('pipeline');
    const step = db
      .insert(jobSteps)
      .values({ jobId: job.id, step: 'ingest', status: 'running' })
      .returning()
      .get();
    expect(step?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('applique les clés étrangères', () => {
    db = openDb({ file: ':memory:' });
    expect(() => db!.insert(jobs).values({ contentId: 'inexistant' }).run()).toThrow(/FOREIGN KEY/);
  });
});
