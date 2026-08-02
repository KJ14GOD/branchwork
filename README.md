Purpose: Entry point to the Novus repository. Says what Novus is, who it is for, the first workflow it must serve, and where every other truth lives.
Authoritative for: the one-sentence definition, the intended user, the wedge, the Golden V0 workflow narrative, the repository map.
Not authoritative for: product scope and domain model (PRODUCT.md), visual system (DESIGN.md), system design (ARCHITECTURE.md), status (PROGRESS.md), recorded decisions (DECISIONS.md), agent working rules (AGENTS.md).
Update when: the definition, wedge, or Golden V0 workflow changes, or a file is added to or removed from the repository root.
Last reviewed: 2026-08-01

# Novus

Novus is the multiplayer control plane where teams launch, direct, review, and ship work produced by cloud coding agents.

A software team gets one shared mission room in which people operate Claude Code, Codex, and other coding harnesses together: they see what is happening, contribute context, submit direction, request and transfer control, inspect changes, understand verification, and keep a durable record of how the result was produced.

Novus does not compete with the coding intelligence of the harnesses it operates. The harness owns its reasoning, context, models, tools, and implementation loop. Novus owns the room around it: identity, missions, participants, control, direction, evidence, review, and history. The full boundary is defined in [PRODUCT.md](PRODUCT.md#the-harness-boundary).

## Who it is for

Software teams that use coding agents for consequential work and need more than one person to be responsible for the result. Novus is built for the team that does not yet fully trust agents with high-stakes changes — it is the instrument through which that trust is earned: attributed direction, revocable control, inspectable evidence, and a receipt that survives the mission.

## The wedge

The first wedge is not generic parallel-agent management. It is **a software team operating one consequential coding mission together**: authentication changes, migrations, infrastructure work, incident remediation, security-sensitive changes, risky dependency upgrades, large refactors. Work where shared context, control, evidence, and accountability are worth a dedicated room — running in cloud workspaces that survive a closed laptop and can be joined from anywhere.

Most missions begin with one workstream and one execution. Competing approaches exist but are an advanced, deliberate workflow — they never dominate the default product. Scope and non-goals are defined in [PRODUCT.md](PRODUCT.md#scope-and-non-goals).

## The Golden V0 workflow

The first implementation is not complete until two real clients can execute this workflow end to end:

1. Kartik signs in.
2. Kartik connects a GitHub repository.
3. Kartik creates a mission with a goal and success criteria.
4. Kartik chooses Claude Code or Codex.
5. Novus creates a dedicated mission branch from an exact base commit and provisions or connects to its execution workspace.
6. The coding harness begins working.
7. Maya joins through a mission invitation.
8. Both participants see the same current state and activity.
9. Maya can contribute context or direction according to her role.
10. Maya requests control.
11. Kartik offers control to Maya.
12. Maya accepts.
13. Control transfers at a safe execution boundary.
14. The current controller can steer, pause, resume, or stop the work.
15. The harness changes the mission branch, checkpoints its work, and runs verification.
16. Both participants inspect the diff and verification evidence.
17. The team requests revisions or accepts the result.
18. Novus creates or tracks the pull request.
19. The mission completes with a durable receipt.
20. Reopening the mission reconstructs who did what, what ran, what changed, and what remains uncertain.

[PRODUCT.md](PRODUCT.md#the-complete-workflow) elaborates each phase of this workflow with roles, capabilities, and lifecycles. The numbered list above is canonical; no other document renumbers it.

Each workstream has one branch and one active execution filesystem. GitHub is the explicit exchange boundary between a cloud workspace and any developer checkout: Novus detects newer remote commits, shows the exact revision the agent sees, and requires an intentional sync at a safe boundary. It never silently copies uncommitted local files into the cloud or pretends two filesystems are one. Product behavior is defined in [PRODUCT.md](PRODUCT.md#repository-continuity); mechanics are in [ARCHITECTURE.md](ARCHITECTURE.md#repository-and-workspace-synchronization).

## Repository map

The repository currently contains the documentation foundation and its gate. No application code exists yet; see [PROGRESS.md](PROGRESS.md).

| File | Owns |
| --- | --- |
| [README.md](README.md) | Definition, user, wedge, Golden V0 workflow, this map |
| [PRODUCT.md](PRODUCT.md) | Principles, customer, domain model, workflows, multiplayer behavior, state model, scope, roadmap, metrics |
| [DESIGN.md](DESIGN.md) | Product feeling, tokens, layout, components, interaction, state presentation, prohibited patterns |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Planes, data and event representation, harness protocol, workspace lifecycle, auth, security, failure handling, testing |
| [PROGRESS.md](PROGRESS.md) | Current status only, with evidence |
| [DECISIONS.md](DECISIONS.md) | Append-only decision record |
| [AGENTS.md](AGENTS.md) | Working rules for every implementation agent; `CLAUDE.md` is a symlink to it |
| `scripts/gate.sh` | The executable repository gate ([AGENTS.md](AGENTS.md#the-repository-gate)) |

Do not add root Markdown files without a recorded decision; see [AGENTS.md](AGENTS.md#rules).
