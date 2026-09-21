# Étape 3 — Walking skeleton — 2026-09-21

**Résultat : validé bout-en-bout sur de vrais rushs.** `pnpm content run --account tcg --input E:/contenu/raw/tcg/2026-08-05`
(3 `.mov` iPhone, 34 s au total) a produit sans intervention, en **3 min 13 s** :

| Étape | Durée | Résultat |
| --- | --- | --- |
| ingest | 1 s | 3 rushs copiés, sondés (1080x1920, audio) |
| tag (Gemini 3.7 Flash) | 17 s | climax `part-3` 16,5 → 22,0 s (0,85), 2 moments forts, 0 incohérence |
| edl (Claude Sonnet 5) | 17 s | **valide à la première tentative** : 6 segments, 23,8 s, hook « QUELLE CARTE VA SORTIR ? », callout « C'EST VERGO ! » sur le climax, musique `hype` 130-150 bpm |
| render (Remotion) | 67 s (dont téléchargement de Chrome, une fois) | 1080x1920, 23,83 s, sans musique (bibliothèque vide) |
| captions (Claude) | 10 s | 3 plateformes + titre de miniature « C'EST VERGO » |
| thumbnail (GPT Image 2 via kie.ai) | 82 s | 2 formats, 0,03 $ |
| qc / deliver / notify | < 1 s | `E:\contenu\ready\tcg\tcg-2026-08-05-80e5\` + `metadata.json` + `work/` ; webhooks non configurés, ignorés |

Coût enregistré : **0,062 $** (EDL 0,022 + légendes 0,010 + image 0,030 ; tagging sur palier gratuit).

Le montage de Claude : tease d'une seconde sur Vergo, retour au booster en accéléré (1,5×), défilement
des cartes (1,5–1,75×), climax à vitesse normale sans coupe, callout posé sur la révélation. Vérifié
image par image : les coupes correspondent.

## Ce que le skeleton a mis en évidence (à traiter aux étapes 4-5)

- **Légendes** : Instagram a reçu les hashtags à la fois dans `description` et dans `hashtags` malgré la
  règle ; TikTok a glissé `#pokemon` sur une vidéo One Piece. Les instructions du compte (migration du
  Claude Project, étape 8) et une passe sur `prompts/captions-generic.md` régleront ça.
- **Miniature** : GPT Image 2 a encore inventé des cartes One Piece (Barbe Blanche…) — confirmation du
  plan de l'étape 5 : partir de l'image réelle du climax (`work/key-frame.png`, déjà extraite) en
  image-to-image.
- **Overlays** : le hook à 88 px sur 1920 est petit ; à grossir et à styler par compte (étape 4).
- **Musique** : `music/music.json` est vide → rendu sans musique. Markus doit déposer des pistes libres
  de droits avec leurs moods (`hype`, `tension`, `reveal` pour TCG).
- `pipeline` est un nom réservé par pnpm : la commande s'appelle `pnpm content`.

## Architecture en place

- `packages/pipeline` : `state.json` par contenu (Zod, écriture atomique), runner qui saute les
  étapes faites, journalise `job_steps`, marque `jobs`/`contents` en échec, envoie l'alerte d'échec puis
  remonte l'erreur ; `pnpm content resume <id>` repart à la première étape manquante (nouveau job,
  `attempt` incrémenté).
- Fournisseurs créés à la demande : une clé absente ne bloque que l'étape qui en dépend.
- Boucle de correction EDL : le validateur renvoie ses problèmes au modèle avec sa réponse précédente,
  3 tentatives max (testée avec un faux SDK).
- Tests : 129 (runner, reprise, échec + webhook, EDL corrigé, miniature en repli avec ffmpeg réel,
  qc, metadata, notification).
