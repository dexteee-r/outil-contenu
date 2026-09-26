import React from 'react';
import { Composition } from 'remotion';
import { Edit, type EditProps } from './Edit';
import { DEFAULT_FPS, OUTPUT_SIZE } from './timeline';

export const COMPOSITION_ID = 'Edit';

const emptyProps: EditProps = {
  timeline: {
    fps: DEFAULT_FPS,
    ...OUTPUT_SIZE,
    durationInFrames: DEFAULT_FPS,
    segments: [],
    overlays: [],
    effects: [],
    music: null,
    sfx: [],
  },
};

export const Root: React.FC = () => (
  <Composition
    id={COMPOSITION_ID}
    component={Edit}
    defaultProps={emptyProps}
    fps={DEFAULT_FPS}
    width={OUTPUT_SIZE.width}
    height={OUTPUT_SIZE.height}
    durationInFrames={DEFAULT_FPS}
    // La durée réelle vient de la timeline passée en props au rendu
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.max(1, props.timeline.durationInFrames),
      fps: props.timeline.fps,
      width: props.timeline.width,
      height: props.timeline.height,
    })}
  />
);
