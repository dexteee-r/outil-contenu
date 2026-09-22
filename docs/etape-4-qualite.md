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

## v4 — 2026-09-22 — `tcg-2026-08-05-99c4` (miniature « poster »)

Retour de Markus sur v3 : « je vois bien une miniature du booster op10 en position principale avec
2 ou 3 éléments de décor, style miniature moderne, simple ».

Changements :

- **Style `poster` par défaut** : sujet **détouré** en héros (ombre portée, légère inclinaison) sur
  un fond de marque, avec exactement trois éléments de décor — rayons très discrets (8 branches,
  opacité 0,07), halo derrière le sujet, quatre étincelles — gros titre à contour et pastille CTA.
  Mise en page propre à chaque format (vertical : sujet haut, texte dessous ; horizontal : sujet à
  droite, texte à gauche).
- **Détourage** : `recraft/remove-background` via kie.ai (upload base64 → URL temporaire → tâche →
  téléchargement). **1 crédit = 0,005 $**, ~10 s. Le détourage local
  (`@imgly/background-removal-node`, ONNX) fait planter Node 24 en natif (exit -1073741819) :
  abandonné. La clé kie.ai doit autoriser le modèle (401 sinon).
- **Sujet choisi par Claude** (`thumbnailSubject` dans la sortie des légendes) : clip, instant et
  description de l'objet qui donne envie de cliquer — pas forcément le climax. Le prompt demande le
  produit fermé et reconnaissable pour une ouverture ; sur ce contenu Claude a tout de même choisi
  la carte Vergo (elle était le sujet le plus net et le plus vendeur) — à retester sur un rush où le
  booster est mieux filmé.
- Ombre portée : aplat noir masqué par l'alpha du sujet (`dest-in`) ; la première version affichait
  la silhouette en blanc.

Coût de la miniature : **0,005 $** (contre 0,03 $ en génération IA), et c'est le vrai objet.
