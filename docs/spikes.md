# Spikes de dérisquage (étape 2)

Comptes-rendus courts : ce qui marche, ce que ça coûte, ce qu'on décide. Les scripts sont dans
`spikes/` et se lancent avec `pnpm -C spikes s1|s2|s3|s4`.

## S4 — Icône de zone de notification (systray2) — 2026-09-20

**Résultat : validé.** `systray2` 2.1.4 (helper Go `tray_windows_release.exe`, 3,5 Mo) fonctionne sur
Windows 11 sans blocage Defender. Icônes `.ico` multi-tailles (16/32/48/256) générées par sharp
depuis un SVG, une par état (gris / vert / ambre / rouge) : nettes selon Markus. Menu, changement
d'icône à chaud (`update-menu`) et ouverture du navigateur OK.

Points appris :

- Le helper est lancé de façon asynchrone : attendre `tray.ready()` avant `onError` / `onExit` / `onClick`.
- Module CommonJS compilé par TypeScript : la classe est sur `.default` sous tsx → petit shim d'import.
- **Pas d'icône orpheline** : quand le processus Node meurt (même tué avec `taskkill /F`), le helper
  se termine tout seul (perte du pipe stdin). Vérifié.
- Inversement, si Node vit et que l'on tue le helper, `onExit` reçoit le code 1 : le tray pourra
  se relancer tout seul dans l'app (étape 9).
- Pas de notification toast dans systray2 : prévoir `node-notifier` pour les toasts Windows.

**Décision : systray2 pour `apps/tray`, Electron non nécessaire.**

## S2 — Rendu Remotion — 2026-09-20

**Résultat : validé bout-en-bout, sur clips synthétiques.** EDL de référence (6 segments, dont un à
1,5×, 2 overlays, musique avec fondu) → MP4 1080x1920 @ 30 fps, H.264 + AAC, 25,73 s pour 25,67 s
attendus, audio présent. Les coupes tombent exactement aux timestamps demandés (vérifié image par
image grâce au timecode incrusté des clips synthétiques : 1,000 / 8,233 / 29,333 / 6,333 s).

Mesures sur le PC de Markus : bundle webpack 4,4 s, **rendu 36 s pour 25,7 s de vidéo (×1,4 temps
réel)**, sources 1080x1920. À re-mesurer avec de vrais rushs 4K (`pnpm -C spikes s2 --clips-dir <dossier>`
avec des fichiers nommés `rush-01.mp4` et `rush-02.mp4`).

Architecture retenue :

- `packages/video` : `timeline.ts` (EDL secondes → frames, pur, testé), composition `Edit`
  (`OffthreadVideo` par segment avec `startFrom`/`endAt`/`playbackRate`, overlays en `Sequence`,
  `Audio` avec fondu), `render.ts` (bundle + `renderMedia`).
- Les rushs ne sont **pas copiés** dans le bundle : un mini serveur HTTP local (`serve.ts`, Range +
  CORS, testé) les expose au navigateur de rendu.
- Imports relatifs **sans extension** dans `packages/video` : le webpack de Remotion ne résout pas `./x.js` → `x.tsx`.

À faire à l'étape 4 : polices de marque (`@remotion/fonts`), ducking sous la voix, transitions,
sous-titres, zones sûres validées sur un vrai téléphone.

## S3 — Miniatures — 2026-09-20 (partiel)

**Composition validée en mode synthétique** (`pnpm -C spikes s3 --synthetic`) : visuel recadré en
« cover » (position `attention`), voile dégradé, titre en Impact avec contour, deux formats
1080x1920 et 1280x720 produits en ~60 ms chacun, planche contact. Gabarit `thumbnail.json` typé
(Zod, fractions du format, défauts complets) et compositeur testés.

**En attente de la clé Gemini** pour la partie IA : 3 visuels générés + 1 image « texte incrusté par le
modèle » pour comparer avec le texte posé par code. Décision Gemini vs Ideogram reportée à ce run.

Pièges rencontrés : Zod 4 — `.default({})` ne re-parse pas la valeur (les sous-défauts ne
s'appliquent pas), utiliser `.prefault({})`.

## S1 — Tagging Gemini — en attente

Script prêt (`pnpm -C spikes s1 --account tcg <rush.mp4>`) : ffprobe → upload Files API (attente de
l'état ACTIVE) → prompt générique + prompt `tcg-opening` → JSON contraint par `taggingOutputSchema` →
contrôle de cohérence (ids, bornes) → coût dans `api_calls`. Option `--generic-only` pour comparer.

Attend : `GEMINI_API_KEY` + `MODEL_TAGGING` dans `.env` (ID exact à vérifier), un vrai rush
d'ouverture TCG. Le modèle Flash n'est pas dans la grille tarifaire tant que son tarif n'est pas
confirmé : ajouter son entrée dans `pricing.json` à la racine (`{ "<id>": { "kind": "tokens",
"inputPerMTok": …, "outputPerMTok": … } }`).
