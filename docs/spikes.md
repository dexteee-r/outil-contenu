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

**Partie IA bloquée par le palier gratuit (2026-09-21).** Avec la clé AI Studio gratuite, **tous** les
modèles de génération d'images répondent 429 avec `limit: 0` — `gemini-3-pro-image` (Nano Banana Pro),
`gemini-3.1-flash-image` (Nano Banana 2), `gemini-3.1-flash-lite-image`, `gemini-2.5-flash-image` :
la génération d'images n'est pas incluse dans le palier gratuit, quel que soit le modèle. Ce n'est pas
une surcharge passagère (le retry le détecte désormais et n'insiste pas).

Conséquence : les miniatures IA exigent une clé payante. La facturation Google Cloud a été refusée
(`OR_BACR2_59`, contrôle anti-fraude, hors de notre contrôle) → **passage par kie.ai**, passerelle
payante à l'usage qui héberge GPT Image 2, Nano Banana Pro, Seedream 4.5 et Ideogram V3 derrière une
seule clé (`KieProvider`, coût exact depuis les crédits consommés, 200 crédits = 1 $).

**Premier run IA le 2026-09-21 (`--provider kie`)** :

- **Nano Banana Pro via kie.ai : validé.** Visuel très « miniature » (carte holographique dans une
  main gantée, étincelles, éclairage dramatique), 2 Mo en 26 s, **18 crédits = 0,09 $ l'image**. La
  composition par code (titre Impact + voile + recadrage) fonctionne dans les deux formats ; le
  recadrage 16:9 en position `attention` garde bien la carte.
- **Texte par le modèle** : Nano Banana Pro a gravé « PULL VERGO OP10-004 » en doré, en relief, sans
  faute, intégré à la carte — esthétiquement supérieur au texte posé par code, mais sans garantie de
  police/couleurs de marque, et une génération de plus (0,09 $). Piste pour l'étape 5 : proposer les
  deux (texte code = sûr, texte modèle = variante « premium ») et laisser Markus choisir.
- **GPT Image 2, Seedream 4.5, Ideogram V3 : 401 « The API key is not authorized to use this
  model »** — pas un bug de notre côté : la clé kie.ai est restreinte par modèle. À vérifier dans les
  réglages de la clé sur kie.ai/api-key (autorisations par modèle), puis relancer la comparaison.

Pièges rencontrés : Zod 4 — `.default({})` ne re-parse pas la valeur (les sous-défauts ne
s'appliquent pas), utiliser `.prefault({})`.

## S1 — Tagging Gemini — 2026-09-21

**Résultat : validé sur de vrais rushs.** Trois `.mov` iPhone (ouverture d'un booster One Piece
OP-10 : 3,1 s + 9,0 s + 22,2 s, 1080x1920) → proxies 720p (≤ 3 s chacun) → Files API (11 s) →
`gemini-3.7-flash` avec prompt générique + `tcg-opening`, JSON contraint par le schéma, 0 incohérence.

Ce que le modèle a trouvé :

- **Climax `part-3` 16,5 → 21,5 s, score 0,90 : « Révélation de la carte Vergo (OP10-004) »** —
  vérifié image par image : à 16,5 s la carte précédente glisse et Vergo apparaît, à 21 s elle est
  brandie face caméra. Précision ≤ 0,5 s, meilleure que la cible de ±1 s.
- Noms de cartes lus correctement (Franky, Jora, Kamusari, Vergo…), numéro de carte inclus.
- Hooks pertinents : découpe du booster aux ciseaux (`part-2` 2,5 → 6,0 s), arrivée du booster sur
  la table (`part-1`). Le début instable de `part-2` est bien tagué `inutilisable`.
- Pas de highlight `reaction` : il n'y a pas de visage dans ces rushs, c'est correct.

Mesures : 4 062 tokens en entrée, 1 161 en sortie (coût négligeable, même payant) ; **génération
148 s** — long, à mettre sur le compte de la surcharge du moment (le premier essai avait reçu un 503
« high demand », `gemini-3.8-flash` a échoué 5 fois de suite sur 5 le même après-midi).

Conséquences intégrées :

- **Nouvelles tentatives avec attente exponentielle** (`providers/retry.ts`, 5 essais, 2 s → 30 s)
  sur 429/503/5xx et erreurs réseau, autour de l'upload et de la génération. Les erreurs de contrat
  (JSON hors schéma) ne sont jamais rejouées.
- **Proxy 720p** avant envoi (`media/proxy.ts`) : inutile d'envoyer du 4K HEVC, Gemini échantillonne
  la vidéo en basse résolution. Le rendu final lit toujours le rush d'origine.
- **Rotation des `.mov` de téléphone** lue par ffprobe (`side_data_list` / `tags.rotate`), sinon les
  dimensions seraient inversées.

Décisions : `gemini-3.7-flash` reste le modèle de tagging (disponible, précis) ; le prompt générique +
spécifique suffit, pas de passe frame par frame nécessaire. Tarif à renseigner dans `pricing.json`
(`{ "gemini-3.7-flash": { "kind": "tokens", "inputPerMTok": …, "outputPerMTok": … } }`) pour que
le coût apparaisse dans `api_calls`. Le palier gratuit expose à ces 503 en heure de pointe : la file
d'attente de l'étape 6 absorbera ça ; à trancher après quelques semaines d'usage.
