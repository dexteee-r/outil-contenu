# Étape 4 — Qualité du montage (journal des itérations)

Chaque run sur les rushs `E:\contenu\raw\tcg\2026-08-05` (booster One Piece OP-10, pull Vergo) et les
retours de Markus. Le tagging est repris du cache : seuls EDL, rendu, légendes et miniatures tournent.

## v1 — 2026-09-21 — `tcg-2026-08-05-80e5` (walking skeleton)

Retours : trop de décor autour du sujet ; la carte visible dès la seconde 1 ; il manque un SFX/VFX au
hit ; miniatures IA trop complexes, hors thème ; 16:9 mal coupé.

## v2 — 2026-09-21 — `tcg-2026-08-05-adfa`

Changements : `framing` (zoom + point de focus) et `blur` par segment dans l'EDL, effet `hit`
(flash + coup de zoom + étincelles + son), miniature « card » (vraie carte en vignette).
Retours : mieux ; le callout « VERGO EN GROS PLAN » n'a rien à faire dans une vidéo finie ; préférer
une **capture réelle** avec un traitement « miniature YouTube moderne » à la vignette.

## v3 — 2026-09-22 — `tcg-2026-08-05-f402`

Changements :

- **Overlays autorisés par compte** (`overlays: [hook]` par défaut) : plus de texte au climax ; le
  step `edl` retire de toute façon les styles non autorisés.
- **Miniature style `screen`** (défaut) : capture réelle plein cadre, étalonnage (saturation ×1,35,
  contraste, netteté), vignettage, dégradé sous le titre, titre à contour épais + ombre, pastille
  CTA. En 16:9 : capture verticale nette posée sur son propre fond flouté, titre à droite.
- **Image clé** : l'instant le plus net parmi 4 candidats de fin de climax, recadrée avec le focus du
  montage mais **zoom plafonné à 1,3** (la carte entière reste visible).
- Titres de miniature et callouts : règles de prompt (« C'EST VERGO », jamais « gros plan »).
- `prompts/visual-prompt-engineer.md` : prompt système de Markus pour les visuels IA (référence ;
  règles anglais + « avoid official artwork » appliquées à `buildBackgroundPrompt`).

Résultat : EDL 24,4 s, hook flouté à 20 px, zoom 1,3–2,0, hit à 22,0 s, un seul overlay ; miniature
« C'EST VERGO » avec la vraie carte, 0 $ d'image.

## En attente de Markus

- Musique : `music/music.json` vide (moods `hype`, `tension`, `reveal`).
- SFX : `sfx/sfx.json` vide → son de substitution synthétique.
- Webhooks n8n (`N8N_WEBHOOK_READY_URL`, `N8N_WEBHOOK_FAILED_URL`).
- Logo `accounts/tcg/brand/logo.png`.
