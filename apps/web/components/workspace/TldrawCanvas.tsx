'use client';

import { useEffect } from 'react';
import { Tldraw, useEditor, useValue, type TLComponents } from 'tldraw';

import type { CanvasItemSummary, CanvasState } from './canvas-types';

const editorComponents: TLComponents = {
  ActionsMenu: null,
  DebugMenu: null,
  HelpMenu: null,
  MainMenu: null,
  PageMenu: null,
  SharePanel: null,
};

type SelectionObserverProps = {
  onStateChange: (state: CanvasState) => void;
};

function SelectionObserver({ onStateChange }: SelectionObserverProps) {
  const editor = useEditor();
  const state = useValue(
    'branchwork canvas state',
    () => {
      const selectedItems: CanvasItemSummary[] = editor
        .getSelectedShapes()
        .map((shape) => ({ id: shape.id, type: shape.type }));

      return {
        itemCount: editor.getCurrentPageShapes().length,
        selectedItems,
      };
    },
    [editor],
  );

  useEffect(() => {
    onStateChange(state);
  }, [onStateChange, state]);

  return null;
}

type TldrawCanvasProps = {
  onStateChange: (state: CanvasState) => void;
};

export function TldrawCanvas({ onStateChange }: TldrawCanvasProps) {
  return (
    <Tldraw
      components={editorComponents}
      persistenceKey="branchwork-local-main"
      onMount={(editor) => {
        editor.user.updateUserPreferences({ colorScheme: 'light' });
      }}
    >
      <SelectionObserver onStateChange={onStateChange} />
    </Tldraw>
  );
}
