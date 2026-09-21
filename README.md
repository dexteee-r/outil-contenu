# Outil IA de création & publication de contenu

Pipeline personnel : rushs bruts → vidéo verticale montée + miniatures + légendes, par compte/marque.
Le cahier des charges et le plan de développement sont hors repo, dans
`Desktop\PERSO - Outil IA de création & publication de contenu\docs (hors repo)\` (un raccourci vers ce repo est à côté).
Les données (rushs, rendus, base SQLite) vivent dans `DATA_ROOT` (`.env`), par exemple `E:\contenu` :
`raw\<compte>\<date>\` pour déposer les rushs, `ready\<compte>\<id>\` pour récupérer les livrables.

## Démarrage

```bash
pnpm install
cp .env.example .env      # puis remplir DATA_ROOT et les clés API
pnpm check                # vérifie Node, ffmpeg, binaires natifs, .env, comptes
pnpm db:migrate           # crée <DATA_ROOT>/outil.sqlite
pnpm config:check tcg     # valide accounts/tcg/account.yaml
pnpm test
pnpm -C spikes models     # liste les modèles Gemini accessibles avec la clé
```

## Structure

```text
apps/worker      orchestrateur + CLI (pnpm cli <commande>)
packages/core    schémas Zod, base SQLite (Drizzle), config comptes, providers (Gemini), coûts, miniatures
packages/video   composition Remotion + rendu (EDL → MP4 1080x1920)
accounts/<slug>  config d'une marque : account.yaml, brand/, prompts/, thumbnail.json
prompts/         prompts partagés versionnés (tagging générique + par type de contenu)
fixtures/        clips + EDL de référence (JSON) ; les rushs vidéo ne sont pas versionnés
spikes/          scripts de dérisquage de l'étape 2 (compte-rendu dans docs/spikes.md)
packages/core/src/doctor.ts   contrôles de prérequis (pnpm check)
```

## Contrats de données

Dans `packages/core/src/schemas/` — source unique (Zod) pour les types TS, la validation et
le JSON Schema envoyé aux modèles (`toJsonSchema()` pour Gemini, `zodOutputFormat()` du SDK pour Claude).

| Contrat                           | Fichier                | Produit par        | Contrôle                                                                   |
| --------------------------------- | ---------------------- | ------------------ | -------------------------------------------------------------------------- |
| `TaggingOutput` → `TaggingResult` | `tagging.ts`           | Gemini (tag)       | `validateTaggingOutput()` : ids de clips, bornes dans la durée             |
| `Edl`                             | `edl.ts`               | Claude (edl)       | `validateEdl()` : clips, bornes, durée totale, segments, overlays          |
| `Captions`                        | `metadata.ts`          | Claude (captions)  | `captionsOutputSchemaFor(platforms)` : une entrée par plateforme du compte |
| `Metadata`                        | `metadata.ts`          | pipeline (deliver) | schéma de `metadata.json`                                                  |
| `AccountConfig`                   | `../config/account.ts` | Markus (YAML)      | `loadAccount()`                                                            |

Les schémas destinés aux modèles ont tous leurs champs requis et aucune valeur par défaut
(contrainte des sorties structurées). L'EDL de référence est dans `fixtures/reference/edl.json`.

## Base de données

Schéma dans `packages/core/src/db/schema.ts`. Après une modification :

```bash
pnpm db:generate   # génère le SQL dans packages/core/drizzle/
pnpm db:migrate    # l'applique
```
