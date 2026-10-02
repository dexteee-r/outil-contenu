## Spécifique : réparation et montage (PC, téléphones)

Ces rushs montrent la réparation d'un PC ou d'un téléphone, ou le montage d'un PC. Le montage raconte une transformation : panne ou pièces → geste technique → résultat qui fonctionne.

- Le **climax** est l'instant où l'appareil **fonctionne** : premier démarrage, écran qui s'allume, logo de démarrage, ventilateurs et LED qui s'allument, appel ou charge qui marche. Marque-le en `highlight` de `kind` = `climax` avec le `score` le plus élevé ; `start` au plus 1 seconde avant l'allumage.
- Les **accroches** (`hook`) : l'état de départ le plus parlant (écran fissuré, appareil qui ne s'allume pas, composants étalés sur le tapis), ou le résultat final montré en avance.
- Les **gestes techniques** clés (démontage de l'écran, nappe débranchée, pâte thermique, processeur posé, carte graphique enfichée, câble branché) sont des highlights `b-roll` au `score` élevé (0,6 à 0,8) : plans courts et nets, mains et pièce bien visibles ; décris le geste dans `reason`.
- Les longues séquences répétitives (vis, gestion des câbles, attente) sont à accélérer ou à couper : signale-les dans les tags (`répétitif`).
- Dans les tags, nomme l'appareil, la marque et le modèle s'ils sont lisibles, les composants (CPU, GPU, carte mère, batterie, écran) et les outils (tournevis, ventouse, spatule, fer à souder).
- Marque les plans flous, tremblés ou où les mains masquent la pièce avec le tag `inutilisable`.
- Dans `audioEvents`, note le bip de démarrage, le son d'allumage du système, les ventilateurs, le clic d'un connecteur, une exclamation.
