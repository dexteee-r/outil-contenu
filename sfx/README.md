# Effets sonores

Dépose ici les sons libres de droits utilisés par les effets de l EDL et déclare-les dans `sfx.json` :

```json
{
  "hit": { "file": "hit-reveal.mp3", "license": "Pixabay Content License", "source": "https://…" }
}
```

- `hit` : joué à la révélation (climax) — court (0,3 à 1 s), franc, joyeux.
- Sans `hit` déclaré, le pipeline génère un son de substitution synthétique dans `<DATA_ROOT>/cache/`.
- Les fichiers audio ne sont pas versionnés (seul `sfx.json` l est).
