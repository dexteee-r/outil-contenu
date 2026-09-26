import type { Command } from 'commander';
import { desc } from 'drizzle-orm';
import { closeDb, contents, jobs, jobSteps, openDb } from '@outil/core';
import {
  createPipelineContext,
  regenerateThumbnails,
  resumeContent,
  runContent,
  startFeedback,
} from '@outil/pipeline';
import { createContext } from './context.js';

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m: string) => console.log(`[${stamp()}] ${m}`);

/** `pipeline run|resume|feedback|thumbnail|list` : le pipeline en ligne de commande. */
export function registerPipelineCommands(program: Command): void {
  const pipeline = program.command('pipeline').description('Exécution du pipeline sur un contenu');

  pipeline
    .command('run')
    .description('Traite un dossier de rushs de bout en bout (ingestion → notification)')
    .requiredOption('--account <slug>', 'compte cible (accounts/<slug>)')
    .requiredOption('--input <dir>', 'dossier de rushs, ex. E:\\contenu\\raw\\tcg\\2026-08-05')
    .action(async (opts: { account: string; input: string }) => {
      const ctx = createContext();
      const db = openDb({ file: ctx.paths.db });
      try {
        const state = await runContent(createPipelineContext(ctx, db, log), {
          accountSlug: opts.account,
          inputDir: opts.input,
        });
        console.log(`\nLivré dans : ${state.deliveredDir}`);
      } catch (err) {
        console.error(`\nÉchec : ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      } finally {
        closeDb(db);
      }
    });

  pipeline
    .command('resume')
    .description('Reprend un contenu interrompu ou en échec à la première étape manquante')
    .argument('<contentId>', 'identifiant du contenu, ex. tcg-2026-08-05-a3f9')
    .action(async (contentId: string) => {
      const ctx = createContext();
      const db = openDb({ file: ctx.paths.db });
      try {
        const state = await resumeContent(createPipelineContext(ctx, db, log), contentId);
        console.log(`\nLivré dans : ${state.deliveredDir}`);
      } catch (err) {
        console.error(`\nÉchec : ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      } finally {
        closeDb(db);
      }
    });

  pipeline
    .command('feedback')
    .description(
      'Relance un contenu livré avec ton retour : nouveau montage (défaut) ou nouvelle miniature (--miniature)',
    )
    .argument('<contentId>', 'identifiant du contenu, ex. tcg-2026-08-05-a3f9')
    .argument('<retour...>', 'ton retour en texte libre, ex. "coupe plus tôt, garde la réaction"')
    .option('--miniature', 'le retour porte sur la miniature (texte, produit, carte)')
    .action(async (contentId: string, words: string[], opts: { miniature?: boolean }) => {
      const ctx = createContext();
      const db = openDb({ file: ctx.paths.db });
      try {
        const state = await startFeedback(createPipelineContext(ctx, db, log), contentId, {
          target: opts.miniature ? 'thumbnail' : 'video',
          text: words.join(' '),
        });
        console.log(`\nVersion ${state.revision ?? 1} livrée dans : ${state.deliveredDir}`);
      } catch (err) {
        console.error(`\nÉchec : ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      } finally {
        closeDb(db);
      }
    });

  pipeline
    .command('thumbnail')
    .description('Regénère les miniatures d’un contenu livré (sans refaire montage ni rendu)')
    .argument('<contentId>', 'identifiant du contenu, ex. tcg-2026-08-05-a3f9')
    .action(async (contentId: string) => {
      const ctx = createContext();
      const db = openDb({ file: ctx.paths.db });
      try {
        const state = await regenerateThumbnails(createPipelineContext(ctx, db, log), contentId);
        console.log(`\nMiniatures dans : ${state.deliveredDir}`);
      } catch (err) {
        console.error(`\nÉchec : ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      } finally {
        closeDb(db);
      }
    });

  pipeline
    .command('list')
    .description('Derniers contenus, leurs jobs et étapes')
    .option('--limit <n>', 'nombre de contenus', '10')
    .action((opts: { limit: string }) => {
      const ctx = createContext();
      const db = openDb({ file: ctx.paths.db });
      try {
        const rows = db
          .select()
          .from(contents)
          .orderBy(desc(contents.createdAt))
          .limit(Number(opts.limit))
          .all();
        if (rows.length === 0) {
          console.log('Aucun contenu.');
          return;
        }
        const allJobs = db.select().from(jobs).orderBy(desc(jobs.id)).all();
        const allSteps = db.select().from(jobSteps).orderBy(desc(jobSteps.id)).all();
        for (const c of rows) {
          console.log(`${c.id}  [${c.status}]  ${c.account}  ${c.createdAt.slice(0, 16)}`);
          for (const j of allJobs.filter((j) => j.contentId === c.id)) {
            const steps = allSteps
              .filter((s) => s.jobId === j.id)
              .reverse()
              .map(
                (s) => `${s.step}${s.status === 'done' ? '✔' : s.status === 'failed' ? '✖' : '…'}`,
              )
              .join(' ');
            console.log(
              `    job #${j.id} ${j.kind} ${j.status}${j.error ? ` — ${j.error.slice(0, 80)}` : ''}  ${steps}`,
            );
          }
        }
      } finally {
        closeDb(db);
      }
    });
}
