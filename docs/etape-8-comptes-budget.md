# Étape 8 — Deuxième compte et garde-fous

2026-10-03.

## Compte dexter.labo

- Dossier `accounts/dexter-labo/` (le slug ne peut pas contenir de point ; affiché « dexter.labo »).
  Dépôt des rushs : `E:\contenu\raw\dexter-labo\<session>\` (raccourci « Déposer les rushs
  dexter.labo » dans PERSO) ou le tableau de bord.
- Nouveau type de contenu **`tech-repair`** (réparation de PC et de téléphones, montage de PC) :
  - dérushage (`prompts/tagging-tech-repair.md`) : climax = l'appareil qui fonctionne (premier
    démarrage, écran qui s'allume) ; accroche = la panne ou les pièces étalées ; gestes techniques
    en plans courts ; séquences répétitives signalées pour être coupées ou accélérées ;
  - légendes et miniature (`prompts/captions-tech-repair.md`) : appareil et panne nommés sans rien
    inventer, question qui engage, étiquette du type « IL REVIT ? » ;
  - miniature **poster** (`thumbnail.json`) : l'appareil détouré en héros, pastille « LE RÉSULTAT ».
- **Provisoire, à fournir par Markus** : couleurs (cyan `#00E5FF` sur fond nuit), logo
  `brand/logo.png`, consignes de légendes réelles (`prompts/captions.md`, à remplacer par le texte
  du Claude Project).
- Le compte « freelance » du cahier des charges est abandonné (pas de besoin).

## Isolation entre comptes

- Le prompt générique des légendes ne contient plus rien de propre au TCG : la grammaire des
  miniatures TCG (produit + carte hit) est passée dans `prompts/captions-tcg-opening.md`, chargé
  seulement pour ce type de contenu (même principe que le dérushage). Un compte n'hérite jamais des
  consignes d'un autre type.
- Testé : deux comptes déposés le même jour sont traités chacun avec sa config, ses identifiants
  (`<compte>-…`) et ses dossiers ; les consignes de dexter.labo ne mentionnent ni booster ni carte.

## Garde-fou budgétaire

Modes par compte dans `account.yaml` → `budget` : `unlimited` (suivi seul), `threshold` (alerte
sans blocage), `cap` (plafond strict). **Les deux comptes sont en plafond strict à 5 €/mois.**

- Contrôle **avant chaque appel payant**, dans le suivi des coûts (`UsageTracker`) : au plafond,
  l'appel est refusé sans rien envoyer au fournisseur.
- **Un contenu commencé va au bout** : il est « admis » au lancement, ses appels passent même si le
  plafond est franchi en route. Le contrôle bloque les **nouvelles** générations : nouveau dossier,
  retour (feedback), miniatures refaites. La reprise d'un contenu déjà commencé reste possible.
- Nouveau dossier déposé au-delà du plafond : rien n'est créé, pas de marqueur `.processed` ; le
  dossier attend dans `/raw` et part tout seul le mois suivant ou dès que le plafond est relevé
  (relu à chaque appel, sans relancer l'outil).
- **Alertes** (Discord + toast) au moment où la dépense franchit le seuil ou le plafond, et quand un
  dossier est refusé ; le tableau de bord refuse « Relancer avec un retour » / « Refaire les
  miniatures » avec le montant dépensé.

## Nouvel essai automatique

Un contenu en échec pour une **panne passagère** (Gemini 503 « high demand », Claude surchargé,
réseau) est relancé tout seul **30 min** après, **3 échecs d'affilée au plus** ; au-delà, il attend
« Reprendre ». Un quota du jour épuisé ou une erreur de contrat (réponse invalide) ne sont jamais
retentés automatiquement. Rien ne part pendant la pause de la surveillance.

## Reporté

- Documents de connaissance via la Files API : aucun document à migrer pour l'instant
  (`knowledgeFiles: []`) ; à faire avec les Claude Projects.
- Repli Gemini Image → Ideogram : les miniatures passent par kie.ai et l'image clé en repli ; pas
  de besoin constaté.

## Validé

- 237 tests (8 nouveaux : plafond, seuil, contenu admis, dossier en attente au plafond, isolation
  des consignes, deux comptes le même jour, sélection des nouveaux essais).
- En réel : plafond TCG abaissé à 0,05 € (0,07 € dépensés en octobre) → `pnpm content thumbnail`
  refusé avec le message, **aucun appel API** passé ; plafond remis à 5 €.
- À faire avec Markus : un vrai contenu dexter.labo de bout en bout.
