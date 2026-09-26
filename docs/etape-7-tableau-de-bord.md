# Étape 7 — Tableau de bord

2026-09-27.

## Utilisation

- **Double-clic sur « Outil contenu »** (dossier PERSO ; `launchers/Outil contenu.cmd` →
  `pnpm start`) : la fenêtre lance la surveillance de `/raw` **et** le tableau de bord, qui s'ouvre
  dans le navigateur sur `http://127.0.0.1:4300`. Fermer la fenêtre arrête tout proprement.
- `pnpm start --lan` : accessible depuis le téléphone sur le Wi-Fi (sans mot de passe — seulement
  sur un réseau de confiance). `--no-watch` : tableau de bord seul. `--port` : autre port.

## Pages

- **Contenus** : cartes avec miniature 16:9 retenue, statut, version, durée, date, coût ; filtre par
  compte (mémorisé) ; journal du worker dépliable ; rafraîchissement toutes les 5 s.
- **Détail** : lecteur vidéo (requêtes par plages : on peut avancer/reculer), miniatures (variante
  retenue ★), légendes par plateforme avec boutons **Copier le titre / la description** (hashtags
  et crédit musique compris), **Relancer avec un retour** (montage ou miniature → version n+1),
  **Reprendre** (échec / interrompu), **Refaire les miniatures**, historique des traitements étape
  par étape (erreurs résumées, détail dépliable), retours, versions précédentes, coûts par module.
- **Déposer** : compte + nom de session (date du jour par défaut), glisser-déposer ou sélection de
  vidéos, barre de progression par fichier ; écrit dans `raw/<compte>/<session>/` via un fichier
  `.part` renommé à la fin (la surveillance ne prend jamais un fichier à moitié copié) ; refuse une
  session déjà traitée.
- **Coûts** : mois en cours par compte face au budget (barre), par module et par jour sur 60 jours,
  en heure locale.
- **Comptes** : configuration en lecture seule et ce qu'il reste à compléter (logo…).
- **Barre d'état** (toutes les pages) : travail en cours et file d'attente, dossiers déposés en
  attente de la période de calme, bouton **Traiter maintenant**.

## Choix techniques

- **Pas de Next.js** (prévu au plan) : un serveur HTTP Node + une page HTML/JS sans build, comme la
  page des miniatures d'inspiration. Surtout, **surveillance et tableau de bord tournent dans le
  même processus** : le tableau de bord voit le travail en cours sans base partagée ni sondage, et
  un seul double-clic lance tout (le tray de l'étape 9 lancera ce même processus).
- **File de travaux unique** (`JobQueue`) : la surveillance, les feedbacks, les reprises et les
  miniatures s'exécutent un par un, dans l'ordre ; l'arrêt propre vaut pour tous.
- **127.0.0.1 par défaut**, fichiers servis uniquement depuis `/ready` (vidéo et miniatures, noms
  contrôlés), dépôts limités à `raw/<compte connu>/<nom simple>/`.

## Corrections faites en route

- **Quota Gemini** : une erreur de quota **journalier** n'est plus retentée ; le dérushage bascule
  sur `MODEL_TAGGING_FALLBACKS` (`gemini-3.6-flash,gemini-3.5-flash`), chacun ayant ses 20
  requêtes/jour — validé en réel sur les rushs du 18 août (`gemini-3.7-flash` épuisé → 3.6).
- `thumbnailHit.what` limité à 160 caractères (un double hit se décrit en plus de 60).
- Instagram : les hashtags ne sont plus écrits dans la description (l'outil les ajoute) ;
  garde-fou contre les doublons dans le tableau de bord et Discord.

## Validé

- 11 tests (API, lecture par plages, dépôt `.part` et refus, actions en file, coûts, noms sûrs).
- En réel : liste, détail (vidéo, miniatures, légendes, historique avec les deux échecs puis la
  réussite du 18 août), dépôt, coûts (0,70 € en septembre pour un budget d'alerte à 5 €).
