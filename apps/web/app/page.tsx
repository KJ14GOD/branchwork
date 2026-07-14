const stages = [
  { label: 'Context', detail: '3 artifacts selected', state: 'complete' },
  { label: 'Research agent', detail: 'Working on branch A', state: 'active' },
  { label: 'Reviewer agent', detail: 'Waiting for evidence', state: 'waiting' },
];

export default function Home() {
  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="mark">B</span>
          <span>Branchwork</span>
        </div>
        <div className="status">
          <span /> Local foundation running
        </div>
      </header>

      <section className="workspace">
        <aside>
          <p className="eyebrow">Workspace</p>
          <h1>
            Explore work,
            <br />
            not chat tabs.
          </h1>
          <p className="lede">
            Select shared context, run agents on branches, compare their work,
            and merge the best result.
          </p>

          <div className="agent-list">
            {stages.map((stage) => (
              <div className="agent" key={stage.label}>
                <span className={`dot ${stage.state}`} />
                <div>
                  <strong>{stage.label}</strong>
                  <small>{stage.detail}</small>
                </div>
              </div>
            ))}
          </div>
        </aside>

        <div className="canvas" aria-label="Branchwork canvas preview">
          <div className="grid" />
          <article className="card source one">
            <span className="tag">SOURCE</span>
            <h2>Customer interview</h2>
            <p>
              Teams lose the reasoning behind decisions when work is spread
              across AI conversations.
            </p>
          </article>
          <article className="card source two">
            <span className="tag">CONTEXT</span>
            <h2>Product thesis</h2>
            <p>
              Shared context should be inspectable, versioned, and permissioned.
            </p>
          </article>
          <div className="connector first" />
          <article className="card result">
            <div className="result-head">
              <span className="agent-avatar">A</span>
              <span>Research agent · branch A</span>
            </div>
            <h2>Positioning memo</h2>
            <p>
              Branchwork turns parallel agent attempts into a reviewable work
              graph instead of disconnected answers.
            </p>
            <div className="evidence">2 sources · 14s · $0.08</div>
          </article>
          <div className="branch-line" />
          <button className="fork">＋ Fork branch</button>
          <div className="hint">
            Select context and press <kbd>/</kbd>
          </div>
        </div>
      </section>
    </main>
  );
}
