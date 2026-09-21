import React from 'react';
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { HitEffects } from './Effects';
import { musicVolumeAt, punchScaleAt, type Timeline, type TimelineOverlay } from './timeline';

/** Props de la composition « Edit » : une timeline déjà calculée en frames (type, pas interface : Remotion exige un Record). */
export type EditProps = { timeline: Timeline };

const overlayStyles: Record<TimelineOverlay['style'], React.CSSProperties> = {
  // Accroche : gros texte centré dans le tiers haut, hors des zones d'UI TikTok/Reels
  hook: {
    top: '13%',
    fontSize: 112,
    fontWeight: 900,
    textTransform: 'uppercase',
    color: '#FFFFFF',
    WebkitTextStroke: '3px rgba(0,0,0,0.7)',
    textShadow: '0 6px 30px rgba(0,0,0,0.9)',
  },
  // Mise en avant (climax) : bandeau coloré au deux tiers
  callout: {
    top: '62%',
    fontSize: 72,
    fontWeight: 800,
    color: '#0F0F1A',
    backgroundColor: '#FFCC00',
    padding: '12px 32px',
    borderRadius: 16,
    transform: 'rotate(-2deg)',
  },
  // Légende discrète au-dessus de la zone de description
  caption: {
    top: '74%',
    fontSize: 48,
    fontWeight: 600,
    color: '#FFFFFF',
    backgroundColor: 'rgba(0,0,0,0.55)',
    padding: '8px 24px',
    borderRadius: 12,
  },
};

const Overlay: React.FC<{ overlay: TimelineOverlay }> = ({ overlay }) => (
  <AbsoluteFill style={{ alignItems: 'center' }}>
    <div
      style={{
        position: 'absolute',
        maxWidth: '86%',
        textAlign: 'center',
        fontFamily: 'Impact, "Arial Black", Arial, sans-serif',
        lineHeight: 1.1,
        ...overlayStyles[overlay.style],
      }}
    >
      {overlay.text}
    </div>
  </AbsoluteFill>
);

export const Edit: React.FC<EditProps> = ({ timeline }) => {
  const { durationInFrames, width, height } = useVideoConfig();
  const frame = useCurrentFrame();
  // Coup de zoom global des effets « hit », par-dessus le cadrage propre à chaque segment
  const punch = punchScaleAt(frame, timeline.effects);
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <AbsoluteFill style={{ transform: `scale(${punch})`, overflow: 'hidden' }}>
        {timeline.segments.map((s, i) => (
          <Sequence key={`s${i}`} from={s.from} durationInFrames={s.durationInFrames}>
            <AbsoluteFill style={{ overflow: 'hidden' }}>
              <OffthreadVideo
                src={s.src}
                startFrom={s.startFromFrame}
                endAt={s.endAtFrame}
                playbackRate={s.playbackRate}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  // Cadrage : zoom autour du point d'intérêt ; flou pour teaser sans révéler
                  transform: `scale(${s.framing.zoom})`,
                  transformOrigin: `${s.framing.focusX * 100}% ${s.framing.focusY * 100}%`,
                  filter: s.blur > 0 ? `blur(${s.blur}px)` : undefined,
                }}
              />
            </AbsoluteFill>
          </Sequence>
        ))}
      </AbsoluteFill>
      <HitEffects effects={timeline.effects} sfx={timeline.sfx.hit} width={width} height={height} />
      {timeline.overlays.map((o, i) => (
        <Sequence key={`o${i}`} from={o.from} durationInFrames={o.durationInFrames}>
          <Overlay overlay={o} />
        </Sequence>
      ))}
      {timeline.music ? (
        <Audio
          src={timeline.music.src}
          volume={(f) => musicVolumeAt(f, timeline.music!, durationInFrames)}
        />
      ) : null}
    </AbsoluteFill>
  );
};
