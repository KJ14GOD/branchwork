'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { CanvasState } from './canvas-types';
import { WorkspaceCanvas } from './WorkspaceCanvas';

const initialCanvasState: CanvasState = {
  itemCount: 0,
  selectedItems: [],
};

function BranchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="4" cy="12" r="1.6" />
      <circle cx="12" cy="6" r="1.6" />
      <path d="M4 5.6v4.8M5.6 10.5c3.4 0 4.8-1.2 4.8-3" />
    </svg>
  );
}

function CanvasIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M2.5 3.5h11v9h-11z" />
      <path d="M5.5 6h5M5.5 8h3.5" />
    </svg>
  );
}

function LibraryIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M3 2.5h7.5a1.5 1.5 0 0 1 1.5 1.5v9.5H4.5A1.5 1.5 0 0 1 3 12z" />
      <path d="M4.5 10.5H12M6 5h3.5M6 7h2.5" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M3.5 5.5H1.8V3.8" />
      <path d="M2 5.1A6 6 0 1 1 2.8 12" />
      <path d="M8 4.5V8l2.3 1.5" />
    </svg>
  );
}

function humanizeShapeType(type: string) {
  if (type === 'geo') return 'Shape';
  return `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

export function WorkspaceShell() {
  const [canvasState, setCanvasState] =
    useState<CanvasState>(initialCanvasState);
  const assignmentInputRef = useRef<HTMLInputElement>(null);
  const selectedCount = canvasState.selectedItems.length;

  const handleCanvasStateChange = useCallback((state: CanvasState) => {
    setCanvasState(state);
  }, []);

  useEffect(() => {
    const handleSlash = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.isContentEditable === true ||
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA';

      if (event.key !== '/' || isTyping) return;

      event.preventDefault();
      assignmentInputRef.current?.focus();
    };

    window.addEventListener('keydown', handleSlash);
    return () => window.removeEventListener('keydown', handleSlash);
  }, []);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark">B</span>
          <span className="brand-name">Branchwork</span>
        </div>

        <div className="project-breadcrumb" aria-label="Current project">
          <span>Personal</span>
          <span className="breadcrumb-separator">/</span>
          <strong>Untitled project</strong>
        </div>

        <div className="header-actions">
          <div className="branch-chip" title="Current branch">
            <BranchIcon />
            <span>main</span>
          </div>
          <button
            className="quiet-button"
            disabled
            title="Available after branching"
          >
            Compare
          </button>
          <button
            className="icon-button"
            disabled
            title="History is added with saved versions"
            aria-label="Open history"
          >
            <HistoryIcon />
          </button>
          <span className="save-state">
            <span /> Saved locally
          </span>
          <span className="user-avatar" aria-label="Current user">
            KJ
          </span>
        </div>
      </header>

      <div className="workspace-layout">
        <aside className="project-sidebar" aria-label="Project navigation">
          <div className="sidebar-heading">
            <span>Project</span>
            <button className="sidebar-more" aria-label="Project menu">
              ···
            </button>
          </div>

          <nav className="sidebar-nav">
            <div className="nav-item active">
              <CanvasIcon />
              <span>Canvas</span>
              <small>{canvasState.itemCount}</small>
            </div>
            <div className="nav-item muted" aria-disabled="true">
              <BranchIcon />
              <span>Branches</span>
              <small>Next</small>
            </div>
            <div className="nav-item muted" aria-disabled="true">
              <HistoryIcon />
              <span>Runs</span>
              <small>Next</small>
            </div>
          </nav>

          <div className="sidebar-section">
            <span className="section-label">Library</span>
            <div className="library-row">
              <LibraryIcon />
              <span>Sources</span>
              <small>—</small>
            </div>
            <div className="library-row">
              <LibraryIcon />
              <span>Documents</span>
              <small>—</small>
            </div>
            <div className="library-row">
              <LibraryIcon />
              <span>Agent output</span>
              <small>—</small>
            </div>
          </div>

          <div className="sidebar-note">
            Use the canvas toolbar to add text, notes, shapes, media, and links.
          </div>
        </aside>

        <section className="canvas-region" aria-label="Project canvas">
          <WorkspaceCanvas onStateChange={handleCanvasStateChange} />
          {canvasState.itemCount === 0 && (
            <div className="empty-canvas-hint">
              <span className="empty-hint-icon">↗</span>
              <strong>Start with something concrete</strong>
              <p>Add a note, paste a link, or drop a file onto the canvas.</p>
            </div>
          )}
        </section>

        <aside className="inspector" aria-label="Selection inspector">
          <div className="inspector-header">
            <span>Inspector</span>
            {selectedCount > 0 && <small>{selectedCount} selected</small>}
          </div>

          {selectedCount === 0 ? (
            <div className="inspector-empty">
              <div className="inspector-empty-icon">⌁</div>
              <strong>Nothing selected</strong>
              <p>
                Select canvas objects to inspect them or use them as agent
                context.
              </p>
            </div>
          ) : (
            <div className="selection-panel">
              <span className="section-label">Selected context</span>
              <div className="selection-list">
                {canvasState.selectedItems.slice(0, 6).map((item) => (
                  <div className="selection-row" key={item.id}>
                    <span className="selection-type-icon">
                      {item.type.slice(0, 1).toUpperCase()}
                    </span>
                    <div>
                      <strong>{humanizeShapeType(item.type)}</strong>
                      <small>{item.id}</small>
                    </div>
                  </div>
                ))}
              </div>
              {selectedCount > 6 && (
                <p className="selection-overflow">
                  +{selectedCount - 6} more objects
                </p>
              )}
              <div className="context-explanation">
                Only selected objects will be included when you assign work.
              </div>
            </div>
          )}
        </aside>
      </div>

      <footer className="assignment-bar">
        <div className="assignment-spacer" />
        <div
          className={`assignment-composer ${selectedCount > 0 ? 'ready' : ''}`}
        >
          <span className="slash-key">/</span>
          <input
            ref={assignmentInputRef}
            aria-label="Agent assignment"
            disabled={selectedCount === 0}
            placeholder={
              selectedCount === 0
                ? 'Select canvas objects to assign work'
                : `Assign work using ${selectedCount} selected ${selectedCount === 1 ? 'object' : 'objects'}…`
            }
          />
          <span className="assignment-status">
            Execution is the next milestone
          </span>
        </div>
        <div className="assignment-inspector-spacer" />
      </footer>
    </main>
  );
}
