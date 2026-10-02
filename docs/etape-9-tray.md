# Étape 9 — Icône dans la zone de notification

2026-10-02.

## Utilisation

- **Double-clic sur « Outil contenu »** (dossier PERSO, ou Bureau) : aucune fenêtre ; une icône
  apparaît près de l'horloge (parfois dans la flèche `^` des icônes cachées : la faire glisser dans
  la barre pour la garder visible) et un toast « Outil contenu lancé » s'affiche.
- **Clic gauche** : tableau de bord. **Clic droit** : menu.
- Un **second double-clic** n'ouvre pas un deuxième outil : il ouvre le tableau de bord de celui
  qui tourne.

| Icône | Signification                                                        |
| ----- | -------------------------------------------------------------------- |
| gris  | en attente de rushs                                                  |
| vert  | traitement en cours (ou arrêt en cours)                              |
| ambre | surveillance en pause                                                |
| rouge | dernier contenu en échec (redevient gris au prochain contenu réussi) |

Menu : statut (contenu + étape en cours, file d'attente, dossiers en période de calme) · Ouvrir le
tableau de bord · Ouvrir le dossier des contenus prêts · Traiter maintenant les dossiers en attente
· Mettre en pause / reprendre la surveillance · Ouvrir le journal · Quitter (puis « Forcer
l'arrêt » pendant l'arrêt).

- **Toasts Windows** sur « prêt » et « échec », en plus de Discord ; un clic sur le toast ouvre le
  tableau de bord.
- **Quitter** = arrêt propre (l'étape en cours se termine, le contenu est repris au prochain
  lancement), puis **sauvegarde** de la base SQLite et de `accounts/` (sans les miniatures
  d'inspiration) dans `<DATA_ROOT>\backups\<date_heure>\` ; les 10 dernières sont gardées.
- **Pause** aussi dans le tableau de bord (bouton à côté de « Traiter maintenant ») : /raw reste
  balayé, rien ne part tout seul, « Traiter maintenant » reste possible.
- **Journal** du jour : `<DATA_ROOT>\logs\outil-AAAA-MM-JJ.log` (seule trace sans fenêtre).

## Choix techniques

- **Icône en PowerShell + WinForms** (`apps/worker/src/tray/tray.ps1`) plutôt que `systray2`
  retenu au spike S4 : présent sur tout Windows, aucun binaire tiers, et `NotifyIcon` affiche aussi
  les toasts (systray2 aurait demandé `node-notifier` en plus). Le script ne fait qu'afficher : il
  reçoit l'état en JSON sur stdin et renvoie les clics sur stdout ; toute la logique est en TS
  (`tray.ts`, testée).
- **Aucun processus orphelin** : Node ferme → stdin de l'icône fermé → elle se retire ; icône tuée →
  Node fait un arrêt propre (pas d'outil invisible qui continue).
- **Lancement sans fenêtre** : raccourci → `conhost.exe --headless cmd /c launchers\outil-tray.cmd`
  (`-WindowStyle Hidden` ne suffit pas quand Windows Terminal est le terminal par défaut). Le
  raccourci se recrée avec `pnpm cli tray:setup --dir <dossier>`.
- **Icônes** : celles du spike S4 (validées), mais encodées en BMP 32 bits sauf 256 px — System.Drawing
  lit mal les petites images PNG d'un .ico (couleurs aberrantes, constaté). Régénérées à chaque
  lancement dans `apps/worker/assets/icons/` (non versionné).
- Toast de démarrage plutôt qu'ouverture automatique du navigateur (`pnpm start` en console
  l'ouvre toujours).

## Corrections faites en route

- Second double-clic sans effet : le journal de lancement, gardé ouvert par le premier outil,
  bloquait la redirection du second. Journal de lancement désormais propre à chaque lancement
  (`%TEMP%`), supprimé si tout va bien, ouvert dans le Bloc-notes si le démarrage échoue.

## Validé

- 229 tests (13 nouveaux : vue du tray, protocole avec faux processus, pause, relais local des
  alertes, sauvegarde, encodage BMP des icônes).
- En réel par Markus : icône, menu, pause/reprise, clic → tableau de bord, toast, Quitter ; puis
  vérifié : plus aucun processus, port 4300 libéré, sauvegarde écrite.
