# Runbook — que faire quand…

Emplacements : code `C:\Users\momoe\tools\Outil montage AI repo` ; données `DATA_ROOT` du `.env`
(`E:\contenu`) : `raw\`, `processing\`, `ready\`, `outil.sqlite`, `logs\`, `backups\`.

## L'icône n'apparaît pas après le double-clic

1. Regarder dans la flèche `^` près de l'horloge (icônes cachées).
2. Si le démarrage a échoué, le Bloc-notes s'ouvre avec le journal de lancement : lire la dernière
   erreur (souvent `.env` invalide ou disque `E:` absent).
3. Lancer `launchers\Outil contenu (console).cmd` : même outil, avec une fenêtre qui affiche tout.
4. Journal de l'outil : `E:\contenu\logs\outil-<date>.log`.
5. Raccourci cassé (repo déplacé…) : `pnpm cli tray:setup --dir "<dossier du raccourci>"`.

## Un contenu est en échec

- Icône rouge + toast + message Discord. Tableau de bord → le contenu → historique (erreur résumée,
  détail dépliable) → **Reprendre** une fois la cause réglée (clé, quota, réseau).
- Quota Gemini du jour épuisé : attendre le lendemain, ou ajouter un modèle dans
  `MODEL_TAGGING_FALLBACKS`.
- Retoucher un contenu livré : **Relancer avec un retour** (montage ou miniature) ou
  `pnpm content feedback <id> "retour" [--miniature]`.

## Relancer un dossier de rushs déjà traité

Supprimer le fichier `.processed` du dossier dans `raw\<compte>\<session>\` **et** choisir un autre
nom de session (un dossier déjà en base n'est pas repris) — le plus simple : renommer le dossier.

## Changer une clé API ou le webhook Discord

Modifier `.env` à la racine du repo (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `KIE_API_KEY`,
`DISCORD_WEBHOOK_URL`), puis Quitter et relancer l'outil. `pnpm check` vérifie la config.

## Ajouter un compte

Copier `accounts/tcg/` vers `accounts/<slug>/`, adapter `account.yaml`, les prompts et `brand/`,
puis `pnpm config:check <slug>` et créer `raw\<slug>\`. (Étape 8 : isolation et budget.)

## L'outil ne s'arrête pas

Menu → **Forcer l'arrêt** (le contenu en cours sera repris au prochain lancement). En dernier
recours, Gestionnaire des tâches → terminer `node.exe` : l'icône disparaît seule, l'état est sauvé
à chaque étape.

## Restaurer une sauvegarde

Outil arrêté, copier `E:\contenu\backups\<date>\outil.sqlite` sur `E:\contenu\outil.sqlite`
(garder l'ancien à côté) ; `accounts\` de la sauvegarde si besoin. Les 10 dernières sont gardées.
