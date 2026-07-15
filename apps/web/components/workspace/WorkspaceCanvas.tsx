'use client';

import dynamic from 'next/dynamic';

import type { CanvasState } from './canvas-types';

const TldrawCanvas = dynamic(
  () => import('./TldrawCanvas').then((module) => module.TldrawCanvas),
  {
    loading: () => (
      <div className="canvas-loading" role="status">
        <span className="canvas-loading-mark" />
        Loading workspace…
      </div>
    ),
    ssr: false,
  },
);

type WorkspaceCanvasProps = {
  onStateChange: (state: CanvasState) => void;
};

export function WorkspaceCanvas({ onStateChange }: WorkspaceCanvasProps) {
  return (
    <div className="canvas-host">
      <TldrawCanvas onStateChange={onStateChange} />
    </div>
  );
}
