# Outil IA de création & publication de contenu

Pipeline personnel : rushs bruts → vidéo verticale montée + miniatures + légendes, par compte/marque.
Le cahier des charges et le plan de développement sont dans `../docs (hors repo)/`.

## Démarrage

```bash
pnpm install
cp .env.example .env      # puis remplir DATA_ROOT et les clés API
pnpm check                # vérifie Node, ffmpeg, binaires natifs, .env, comptes
pnpm db:migrate           # crée <DATA_ROOT>/outil.sqlite
pnpm config:check tcg     # valide accounts/tcg/account.yaml
pnpm test
```

## Structure

```text
apps/worker      orchestrateur + CLI (pnpm cli <commande>)
packages/core    schémas Zod, base SQLite (Drizzle), config comptes, suivi des coûts API
accounts/<slug>  config d'une marque : account.yaml, brand/, prompts/
packages/core/src/doctor.ts   contrôles de prérequis (pnpm check)
```

## Base de données

Schéma dans `packages/core/src/db/schema.ts`. Après une modification :

```bash
pnpm db:generate   # génère le SQL dans packages/core/drizzle/
pnpm db:migrate    # l'applique
```
