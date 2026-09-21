import React from 'react';
import { AbsoluteFill, Audio, Sequence, useCurrentFrame } from 'remotion';
import { flashOpacityAt, HIT_EFFECT_FRAMES, type TimelineEffect } from './timeline';

/**
 * Effet « hit » : flash blanc, étincelles qui partent du centre, son court.
 * Le coup de zoom est appliqué par la composition sur la couche vidéo (punchScaleAt).
 */

const SPARK_COUNT = 18;

/** Étincelles déterministes : angle et vitesse dérivés de l'index, pas d'aléa au rendu. */
function sparkAt(i: number, t: number, width: number, height: number) {
  const angle = (i / SPARK_COUNT) * Math.PI * 2 + (i % 3) * 0.21;
  const speed = 0.55 + ((i * 7) % 5) * 0.09; // fraction de la demi-diagonale par effet
  const progress = Math.min(1, t / HIT_EFFECT_FRAMES);
  const eased = 1 - (1 - progress) ** 2;
  const radius = eased * speed * Math.hypot(width, height) * 0.45;
  return {
    x: width / 2 + Math.cos(angle) * radius,
    y: height / 2 + Math.sin(angle) * radius,
    size: (10 + (i % 4) * 6) * (1 - progress * 0.6),
    opacity: 1 - progress,
  };
}

const Sparks: React.FC<{ width: number; height: number; color: string }> = ({
  width,
  height,
  color,
}) => {
  const t = useCurrentFrame();
  return (
    <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
      {Array.from({ length: SPARK_COUNT }, (_, i) => {
        const s = sparkAt(i, t, width, height);
        return (
          <polygon
            key={i}
            points={`${s.x},${s.y - s.size} ${s.x + s.size * 0.35},${s.y} ${s.x},${s.y + s.size} ${s.x - s.size * 0.35},${s.y}`}
            fill={color}
            opacity={s.opacity}
          />
        );
      })}
    </svg>
  );
};

export const HitEffects: React.FC<{
  effects: TimelineEffect[];
  sfx: string | null;
  width: number;
  height: number;
  color?: string;
}> = ({ effects, sfx, width, height, color = '#FFCC00' }) => {
  const frame = useCurrentFrame();
  const flash = flashOpacityAt(frame, effects);
  return (
    <>
      {effects
        .filter((e) => e.type === 'hit')
        .map((e, i) => (
          <Sequence key={`hit${i}`} from={e.at} durationInFrames={HIT_EFFECT_FRAMES}>
            <AbsoluteFill style={{ pointerEvents: 'none' }}>
              <Sparks width={width} height={height} color={color} />
            </AbsoluteFill>
            {sfx ? <Audio src={sfx} volume={0.9} /> : null}
          </Sequence>
        ))}
      {flash > 0 ? <AbsoluteFill style={{ backgroundColor: '#fff', opacity: flash }} /> : null}
    </>
  );
};
