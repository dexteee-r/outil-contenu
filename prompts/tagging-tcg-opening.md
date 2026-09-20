## Spécifique : ouverture de cartes à collectionner (TCG)

Ces rushs montrent l'ouverture d'un ou plusieurs boosters de cartes à collectionner (Pokémon, One Piece, Magic…). Le montage repose sur un moment précis qu'il faut identifier avec soin :

- Le **climax** est l'instant où la carte rare ou recherchée apparaît à l'écran (la carte est retournée, sortie du paquet ou brandie) et la réaction qui suit immédiatement. Marque-le en `highlight` de `kind` = `climax` avec le `score` le plus élevé du lot. Le `start` doit tomber au plus 1 seconde avant l'apparition de la carte. S'il y a plusieurs cartes rares, un climax par carte, classés par intensité de la réaction.
- La **réaction** (cri, rire, silence surpris, mains qui tremblent, gros plan sur le visage) est un highlight `reaction` distinct, juste après le climax.
- Les **accroches** (`hook`) possibles : le booster montré à la caméra, la première déchirure, une phrase du type « si je sors X… ».
- Dans les tags, nomme la carte si elle est lisible (nom, rareté, effet holographique, numéro) et note le type de produit (booster, display, ETB…).
- Dans `audioEvents`, sois précis sur la déchirure du paquet, le glissement des cartes, l'exclamation.
