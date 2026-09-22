import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { downloadYoutubeThumbnails, listAccounts } from '@outil/core';
import { createContext } from './context.js';

/** Lit des liens depuis les arguments et/ou un fichier texte (un lien par ligne, # = commentaire). */
export function collectLinks(args: string[], file: string | undefined): string[] {
  const fromFile = file
    ? fs
        .readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    : [];
  return [...args, ...fromFile];
}

/** `inspiration <liens…>` : récupère les miniatures YouTube dans accounts/<compte>/inspiration/. */
export function registerInspirationCommands(program: Command): void {
  program
    .command('inspiration')
    .description(
      'Télécharge les miniatures de vidéos YouTube (et Shorts) dans le dossier d’inspiration du compte',
    )
    .argument('[liens...]', 'liens YouTube (watch, youtu.be, shorts) ou identifiants')
    .option('--account <slug>', 'compte cible', 'tcg')
    .option('--file <chemin>', 'fichier texte avec un lien par ligne')
    .action(async (links: string[], opts: { account: string; file?: string }) => {
      const ctx = createContext();
      if (!listAccounts(ctx.accountsDir).includes(opts.account)) {
        console.error(`Compte inconnu : ${opts.account}`);
        process.exitCode = 1;
        return;
      }
      const all = collectLinks(links, opts.file);
      if (all.length === 0) {
        console.error(
          'Donne au moins un lien : pnpm inspiration <lien> [<lien>…] ou --file liens.txt',
        );
        process.exitCode = 1;
        return;
      }
      const outDir = path.join(ctx.accountsDir, opts.account, 'inspiration');
      let ok = 0;
      for (const link of all) {
        try {
          const entry = await downloadYoutubeThumbnails(link, outDir);
          ok++;
          const formats = entry.files.map((f) => `${f.format} (${f.variant})`).join(', ');
          console.log(`✔ ${entry.channel ?? '?'} — ${entry.title ?? entry.id} : ${formats}`);
        } catch (err) {
          console.error(`✖ ${link} : ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      console.log(`\n${ok}/${all.length} récupérée(s) dans ${outDir}`);
      if (ok < all.length) process.exitCode = 1;
    });
}
