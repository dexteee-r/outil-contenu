import React from 'react';
import { AbsoluteFill, Audio, OffthreadVideo, Sequence, useVideoConfig } from 'remotion';
import { musicVolumeAt, type Timeline, type TimelineOverlay } from './timeline';

/** Props de la composition « Edit » : une timeline déjà calculée en frames (type, pas interface : Remotion exige un Record). */
export type EditProps = { timeline: Timeline };

const overlayStyles: Record<TimelineOverlay['style'], React.CSSProperties> = {
  // Accroche : gros texte centré dans le tiers haut, hors des zones d'UI TikTok/Reels
  hook: {
    top: '14%',
    fontSize: 88,
    fontWeight: 900,
    textTransform: 'uppercase',
    color: '#FFFFFF',
    textShadow: '0 4px 24px rgba(0,0,0,0.85)',
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
  const { durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {timeline.segments.map((s, i) => (
        <Sequence key={`s${i}`} from={s.from} durationInFrames={s.durationInFrames}>
          <OffthreadVideo
            src={s.src}
            startFrom={s.startFromFrame}
            endAt={s.endAtFrame}
            playbackRate={s.playbackRate}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </Sequence>
      ))}
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
