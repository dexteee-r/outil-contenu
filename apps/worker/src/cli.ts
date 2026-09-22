import { Command } from 'commander';
import {
  AccountConfigError,
  closeDb,
  formatDoctorReport,
  listAccounts,
  listTables,
  loadAccount,
  openDb,
  runDoctor,
} from '@outil/core';
import { createContext } from './context.js';
import {
  registerInspirationCommands,
  registerInspirationWebCommand,
} from './inspiration-commands.js';
import { registerPipelineCommands } from './pipeline-commands.js';

const program = new Command()
  .name('outil')
  .description('Outil IA de création & publication de contenu — CLI du worker');

program
  .command('doctor')
  .description('Vérifie les prérequis : Node, ffmpeg, binaires natifs, .env, comptes')
  .action(async () => {
    const report = formatDoctorReport(await runDoctor());
    for (const line of report.lines) console.log(line);
    if (report.fails) process.exitCode = 1;
  });

program
  .command('db:migrate')
  .description('Crée la base SQLite si besoin et applique les migrations manquantes')
  .action(() => {
    const ctx = createContext();
    const db = openDb({ file: ctx.paths.db });
    const tables = listTables(db);
    closeDb(db);
    console.log(`Base : ${ctx.paths.db}`);
    console.log(`Tables : ${tables.join(', ')}`);
  });

program
  .command('config:check')
  .description('Valide la config d’un compte (ou de tous les comptes) dans accounts/')
  .argument('[slug]', 'compte à vérifier ; tous si omis')
  .action((slug: string | undefined) => {
    const ctx = createContext();
    const slugs = slug ? [slug] : listAccounts(ctx.accountsDir);
    if (slugs.length === 0) {
      console.error(`Aucun compte trouvé dans ${ctx.accountsDir}`);
      process.exitCode = 1;
      return;
    }

    let failed = false;
    for (const s of slugs) {
      try {
        const loaded = loadAccount(s, ctx.accountsDir);
        const c = loaded.config;
        console.log(`✔ ${s} — ${c.displayName} (${c.contentType}, ${c.platforms.join(', ')})`);
        console.log(
          `    durée ${c.durationRange.min}-${c.durationRange.max} s · sous-titres ${c.subtitles ? 'oui' : 'non'} · budget ${describeBudget(c.budget)}`,
        );
        for (const w of loaded.warnings) console.log(`    ⚠ ${w}`);
      } catch (err) {
        failed = true;
        if (err instanceof AccountConfigError) {
          console.error(`✖ ${s}`);
          for (const issue of err.issues) console.error(`    ${issue}`);
        } else {
          throw err;
        }
      }
    }
    if (failed) process.exitCode = 1;
  });

function describeBudget(b: { mode: string; monthlyLimitEur?: number }): string {
  switch (b.mode) {
    case 'unlimited':
      return 'illimité (suivi seulement)';
    case 'threshold':
      return `alerte au-delà de ${b.monthlyLimitEur} €/mois`;
    case 'cap':
      return `plafond strict ${b.monthlyLimitEur} €/mois`;
    default:
      return b.mode;
  }
}

registerPipelineCommands(program);
registerInspirationCommands(program);
registerInspirationWebCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
