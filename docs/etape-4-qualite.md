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

## v5 — 2026-09-22 — `tcg-2026-08-05-b4ff` (miniature « duo », tirée de l'inspiration)

Markus a rempli `accounts/tcg/inspiration/` avec 17 miniatures TCG populaires (Valouzz, La Flèche,
DavidLafarge, JirayaTV, Hctuan…). Ce qu'elles ont en commun :

- le **produit réel en très grand** (booster, display, carte), net et saturé, qui déborde souvent du
  cadre ; souvent **produit + carte hit** côte à côte, la carte entourée d'une **lueur** ;
- un **fond coloré dans la couleur du produit** (décor flouté ou « énergie »), jamais neutre ;
- un **texte très court** (1 à 3 mots, un chiffre ou une question : « -2000€ », « J'arrête ? »,
  « 0,0002% ») dans une **étiquette pleine**, ou pas de texte du tout ;
- une **flèche** ou un « ? » pour créer la curiosité ; **aucun bouton « regarde »** ;
- un visage expressif sur 15 sur 17 : Markus filme ses mains, donc c'est le seul point non repris
  (piste : une petite banque de photos réaction détourées).

Changements :

- **Style `duo` par défaut** (`packages/core/src/thumbnails/duo.ts`) : produit détouré en très grand
  (liseré blanc « sticker », ombre), carte hit détourée à côté avec une lueur de sa propre couleur,
  fond = dégradé radial + faisceaux + le produit lui-même agrandi et flouté, dans la **teinte
  dominante du produit** ; étiquette jaune de marque (texte mesuré au rendu, police réduite si
  besoin) ; flèche courbe vers la carte. **Variante 2 teaser** : carte floutée + gros « ? »
  (`selected: false`). Mise en page 16:9 (produit à gauche, carte à droite, coin bas-droit libre pour
  la durée YouTube) et 9:16 (éléments dans le 3:4 central que rognent les grilles de profil).
- **Teinte dominante** : image réduite à 24 px (les détails se fondent dans leur surface), seuil de
  saturation bas (le violet OP-10 sort terne à la caméra), **peau et gris chauds exclus** (règle YCbCr).
  Sans ces règles le fond sortait jaune (logo doré) puis orange (gris chauds).
- **Bords coupés** : si le détourage touche un bord de l'image (la main qui entre dans le champ), ce
  côté sort aussi du canevas au lieu d'apparaître comme une coupe nette.
- **Pas de recadrage avant détourage** : le zoom du montage (×1,3) coupait le booster posé sur la
  table ; les styles détourés partent maintenant de l'image entière.
- **Claude choisit deux sujets** : `thumbnailSubject` (le produit fermé) et `thumbnailHit` (la
  meilleure carte face visible, ou `null`), et un `thumbnailTitle` de 1 à 3 mots, ≤ 16 caractères,
  qui ne nomme jamais la carte. Sur ce contenu : booster OP-10 à 2,0 s, Vergo à 21,0 s, « QUEL HIT ? ».
- **`pnpm content thumbnail <id>`** : regénère les miniatures d'un contenu livré sans refaire montage
  ni rendu (rushs relus depuis `/raw`, `metadata.json` mis à jour) — 0,01 $ pour deux détourages.
- Sharp : un masque brut à 1 canal ressort en sRGB (3 canaux) après `blur()` — d'où des rayures dans
  la première version ; `linear()` s'applique avant `ensureAlpha()` dans un même pipeline.

Coût de la miniature : **0,01 $** (deux détourages), 4 images (2 formats × 2 variantes).

## Boucle de feedback — 2026-09-26

```bash
pnpm content feedback <id> "coupe plus tôt, garde la réaction"
pnpm content feedback <id> --miniature "mets le nom du set dans l'étiquette"
```

- Relance un contenu **livré** (statut `ready`) en version n+1 (`packages/pipeline/src/feedback.ts`).
  Seules les étapes concernées sont refaites : retour vidéo → `edl`, `render` ; retour miniature →
  `captions` (Claude revoit texte, produit et carte), `thumbnail` ; puis `qc`, `deliver`, `notify`.
  Le reste (dérushage, légendes ou vidéo) est repris tel quel.
- Claude reçoit sa version livrée **comme sa propre réponse**, suivie du retour, avec la consigne de
  ne changer que ce qui est demandé : il corrige sa copie au lieu de repartir de zéro.
- Livraison : la version précédente (vidéo, miniatures, `metadata.json`, EDL) est rangée dans
  `v<n>/` ; le dossier du contenu montre toujours la dernière version. `metadata.version`,
  `contents.version`, un job `feedback` et une ligne `feedback` (liée au job) sont enregistrés ; les
  retours sont aussi gardés dans `state.feedback`.
- Rushs relus depuis `/raw` (les copies de `/processing` disparaissent à la livraison).
- Limite : un retour miniature agit sur les **choix** (texte, instants) ; la mise en page du style
  `duo` (tailles, positions) se règle dans le code, pas par feedback.

Test réel sur `tcg-2026-08-05-b4ff` : « l'intro floutée est trop longue, arrive plus vite au
booster » → teaser de 1,0 s à 0,6 s, les 5 autres segments identiques, rendu en 35 s, v1 dans `v1/`.

## Musiques, sons et police de marque — 2026-09-26

Ressources copiées depuis la bibliothèque de Markus (`F:\1 - MONTAGES PHOTO ET Vidéo`), jamais
versionnées : 11 musiques (`music/`), 31 sons (`sfx/hit|riser|whoosh|pop/`), 6 polices
(`accounts/tcg/brand/fonts/`).

- **Musiques** : ambiances classées en faisant écouter 45 s de chaque piste à Gemini (hype 4,
  tension 4, reveal 3, calm 7). One Piece OST est marquée `restricted` (Content ID) : choisie
  seulement si aucune piste libre ne convient. TheFatRat et Silverman Sound ont un `credit`.
- **Habillage sonore automatique** (`buildSfxCues`, sans rien demander à l'EDL) : son de hit joué
  en entier (il était coupé à 0,8 s avec l'effet visuel), montée de tension qui finit pile sur le
  hit, whoosh aux changements de plan (pas près du hit, pas pendant la montée, 0,6 s d'écart
  minimum), pop à l'apparition d'un texte. Index `sfx.json` étendu à `riser`, `whoosh`, `pop`.
  Volumes : hit 0,75 (0,9 donnait un pic à -0,2 dBFS avec la musique), montée 0,45, whoosh 0,35.
- **Police de marque** : `brand.fonts.title` pointe un fichier (`brand/fonts/Montserrat-Black.ttf`).
  Le moteur SVG de Sharp ne voit que les polices installées : l'étiquette et le « ? » sont rendus
  par Pango avec `fontfile`, sous le nom de famille **court** lu dans la table `name` du fichier
  (`Burbank Big Cd Bd`, pas `Burbank Big Condensed` — sinon police de secours).
  Aperçu : `pnpm -C spikes fonts tcg`.
- **Quota Gemini gratuit : 20 requêtes par jour et par modèle** (`gemini-3.7-flash` compris, celui
  du dérushage). Le classement des musiques l'a épuisé pour la journée (tentatives répétées sur des
  503) ; le reste est passé par `gemini-3.5-flash` / `3.6-flash`, qui ont chacun leur quota. À
  surveiller dès qu'il y aura plusieurs vidéos par jour.

Run réel `tcg-2026-08-05-be3f` : musique « TheFatRat — Xenogenesis » (reveal), sons hit, riser,
whoosh, pop, étiquette en Montserrat Black.
