# Étape 6 — Orchestrateur, surveillance de /raw, notifications Discord

2026-09-26.

## Utilisation

- **Double-clic** sur `Surveillance des rushs` (raccourci dans le dossier PERSO, lanceur
  `launchers/Surveillance des rushs.cmd`), ou `pnpm content watch`.
- Déposer les rushs d'une session dans `E:\contenu\raw\<compte>\<dossier>\` (depuis le téléphone
  via Syncthing, ou à la main). Le dossier est traité **2 minutes après le dernier changement**
  (`WATCH_QUIET_MINUTES`), puis le message « prêt » arrive sur Discord.
- `pnpm content watch --once` : un seul passage sans attendre (reprises + dossiers présents).
- `pnpm content notify <id>` : renvoie le message « prêt » d'un contenu livré.
- Fermer la fenêtre ou Ctrl+C : **arrêt propre**, l'étape en cours se termine et le contenu sera
  repris au prochain lancement ; un second Ctrl+C arrête tout de suite (l'état est sauvé à chaque
  étape, la reprise refait seulement l'étape coupée).

## Fonctionnement (`packages/pipeline/src/watch.ts`)

- **Balayage toutes les 15 s** plutôt qu'événements du système de fichiers (chokidar) : Syncthing
  écrit dans des fichiers temporaires puis renomme, ce qui produit des rafales d'événements peu
  fiables sous Windows ; un balayage avec empreinte (nom, taille, date de chaque fichier) est
  simple, robuste et testable avec une horloge injectée.
- Un dossier est **prêt** quand son empreinte n'a pas changé depuis la période de calme, qu'il
  contient au moins une vidéo et **aucun fichier temporaire Syncthing** (`.syncthing.*.tmp`,
  `~syncthing~*`).
- **Idempotence** : un dossier est ignoré s'il porte un marqueur `.processed` (JSON : contenu,
  statut, date) **ou** s'il existe déjà un contenu en base pour ce dossier — les lancements manuels
  (`pnpm content run`) et les dossiers d'avant l'étape 6 ne sont donc jamais retraités.
- **Un contenu à la fois** ; un échec pose un marqueur `failed` (pas de relance en boucle) et part
  sur Discord avec la commande de reprise ; un échec à l'ingestion (dossier illisible) aussi.
- **Rattrapage au lancement** : les contenus `processing` (fenêtre fermée brutalement) et
  `interrupted` (arrêt propre) sont repris automatiquement ; les dossiers arrivés pendant que
  l'outil était fermé sont traités au premier balayage. Les contenus en `failed` attendent un
  `pnpm content resume <id>` (un échec répété coûterait des appels pour rien).
- **Arrêt propre** : `RunOptions.signal` ; le runner vérifie le signal **entre deux étapes**, marque
  job et contenu `interrupted` et lève `InterruptedError`. Garde-fou de 5 min avant sortie forcée.
- **Disque** : au lancement puis toutes les 24 h, alerte Discord si l'espace libre du disque des
  données passe sous `DISK_ALERT_FREE_GB` (50 Go par défaut). Aucune purge automatique.

## Discord (`packages/pipeline/src/discord.ts`)

- Envoi **direct au webhook du salon** (`DISCORD_WEBHOOK_URL` dans `.env`, jamais versionné), sans
  n8n : message multipart avec la miniature 16:9 retenue en pièce jointe (JPEG ≤ 1280 px), lisible
  depuis le téléphone même PC éteint.
- « Prêt » : titre, durée, texte de la miniature, dossier de livraison, légendes par plateforme
  (titre, description, hashtags), rappel de la commande de feedback.
- « Échec » : étape, erreur, commande de reprise. « Disque presque plein » : espace libre.
- Limites Discord respectées (titre 256, champ 1024, 25 champs) ; nouvelles tentatives sur 429/5xx.
- Une panne de Discord ne fait jamais échouer un contenu (journalisée seulement). Les webhooks n8n
  restent possibles en parallèle (`N8N_WEBHOOK_READY_URL` / `N8N_WEBHOOK_FAILED_URL`, JSON brut).

## Validé

- 13 tests (surveillance, période de calme, fichiers Syncthing, marqueurs, arrêt propre puis
  reprise sans refaire l'étape terminée, dossier illisible ; messages et envoi Discord simulés).
- En réel : `pnpm content notify tcg-2026-08-05-be3f` → message reçu ; surveillance lancée, copie
  des 3 rushs OP-10 dans `raw\tcg\2026-09-26` → détecté en 15 s, traité après 30 s de calme
  (`--quiet 0.5`), livré `tcg-2026-09-26-15fa` en 1 min 45, message « prêt » sur Discord,
  marqueur `.processed` posé.

## Reste à faire

- **Syncthing** (côté Markus) : partager le dossier du téléphone vers `E:\contenu\raw\tcg\`, un
  sous-dossier par session (le nom du sous-dossier donne la date du contenu s'il est daté).
- Logs structurés (pino) : les journaux restent en texte horodaté dans la fenêtre ; à revoir avec
  le dashboard (étape 7).
- Tray (étape 9) : il lancera ce worker sans fenêtre de terminal.
