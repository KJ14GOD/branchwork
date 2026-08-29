import { describe, expect, it } from "vitest";
import {
  ADMIN_ONLY_PERMISSION_PROFILES,
  CLAUDE_MODELS,
  CODEX_MODELS,
  harnessOf,
  CapabilitySchema,
  CreateMissionInputSchema,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_PROFILE,
  PERMISSION_PROFILES,
  PermissionProfileSchema,
  WorkstreamSchema,
  DirectionInputSchema,
  DirectionSchema,
  EventSchema,
  ExecutionSchema,
  IpcAuthStatusSchema,
  IpcDirectInputSchema,
  MAX_APPROVAL_SUMMARY,
  MissionSchema,
  ModelIdSchema,
  ReportRunnerEventsInputSchema,
  RespondApprovalInputSchema,
  RunnerEventSchema,
  SessionSchema,
  SkillNameSchema,
  ProjectSkillSchema,
  EnabledSkillSchema,
  EnabledSkillsSchema,
  MAX_PROJECT_SKILLS,
  MAX_SKILL_BYTES,
  McpServerSchema,
  validMcpUrl,
  pathInScope,
  scopesDisjoint,
  ScopePatternSchema,
  MissionStateSchema,
  PullRequestSchema,
  RunnerCommandKindSchema,
  RequestReviewInputSchema,
  ConnectorNameSchema,
  ConnectorSchema,
  connectorToolId,
  connectorToolPrefix,
  impersonatesConnector,
  MachineMcpServerSchema
} from "../src/index.js";

describe("contracts", () => {
  it("rejects a mission with an empty goal", () => {
    expect(CreateMissionInputSchema.safeParse({ goal: "  ", successCriteria: "x" }).success).toBe(false);
  });

  it("rejects a mission over the goal length ceiling", () => {
    expect(
      CreateMissionInputSchema.safeParse({ goal: "g".repeat(501), successCriteria: "x" }).success
    ).toBe(false);
  });

  it("accepts a canonical mission shape", () => {
    const parsed = MissionSchema.safeParse({
      missionId: "msn_abc",
      orgId: "org_abc",
      goal: "Rotate signing keys",
      successCriteria: "All services on the new key; old key revoked",
      primaryState: "new_mission",
      createdBy: "usr_abc",
      createdByLogin: "kartik",
      createdAt: new Date().toISOString(),
      // In the ordinary list: not filed away, by nobody (D-063).
      archivedAt: null,
      archivedByLogin: null,
      // Demanding nothing of anyone, so naming no lane and no chat (D-093).
      attention: null,
      repository: {
        repoId: "rep_abc",
        provider: "github",
        providerRepoId: "9001",
        name: "novus/demo-app",
        defaultBranch: "main"
      }
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a canonical session shape, and refuses the auth session's prefix", () => {
    const session = {
      sessionId: "csn_abc",
      workstreamId: "wst_abc",
      // Untitled until its first direction: a title is words, never a field.
      title: null,
      createdBy: "usr_abc",
      createdByLogin: "kartik",
      createdAt: new Date().toISOString(),
      // Unscoped: the whole workspace, exclusively, as every chat was before
      // scopes existed (D-097).
      scope: null
    };
    expect(SessionSchema.safeParse(session).success).toBe(true);
    // `ses_` has always been the auth session's; a conversation is `csn_`, and
    // the two must never parse as each other (D-083).
    expect(SessionSchema.safeParse({ ...session, sessionId: "ses_abc" }).success).toBe(false);
  });

  it("pins every direction and execution to a session, and carries a named session through input", () => {
    const direction = {
      directionId: "dir_abc",
      workstreamId: "wst_abc",
      sessionId: "csn_abc",
      authorUserId: "usr_abc",
      authorLogin: "kartik",
      body: "Keep going",
      state: "queued",
      ordinal: 1,
      submittedAt: new Date().toISOString(),
      appliedAt: null,
      resolutionReason: null,
      consumedByExecutionId: null
    };
    expect(DirectionSchema.safeParse(direction).success).toBe(true);
    // A direction without a session would be a thread belonging to nobody —
    // rows from before sessions are migrated, never nulled (D-083).
    const unpinned: Record<string, unknown> = { ...direction };
    delete unpinned.sessionId;
    expect(DirectionSchema.safeParse(unpinned).success).toBe(false);

    const execution = {
      executionId: "exe_abc",
      workstreamId: "wst_abc",
      sessionId: "csn_abc",
      // The ordinary exclusive turn; 'read' is the alongside answer (D-095).
      access: "write",
      harness: "claude-code",
      model: "claude-fable-5",
      effort: "high",
      runnerId: null,
      startingDirectionId: null,
      state: "running",
      startedBy: "usr_abc",
      startedByLogin: "kartik",
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      harnessSessionId: null,
      resumedSession: false,
      exitOutcome: null,
      failureReason: null,
      latestCheckpointSha: null,
      usage: {}
    };
    expect(ExecutionSchema.safeParse(execution).success).toBe(true);
    expect(ExecutionSchema.safeParse({ ...execution, sessionId: undefined }).success).toBe(false);

    // Naming a session survives the parse, and asking for none asks for none:
    // `newSession` defaults off so nothing that predates sessions changes.
    const input = DirectionInputSchema.safeParse({ body: "Keep going", sessionId: "csn_abc" });
    expect(input.success && input.data.sessionId).toBe("csn_abc");
    expect(input.success && input.data.newSession).toBe(false);
  });

  it("rejects an event with an unattributed actor", () => {
    const parsed = EventSchema.safeParse({
      eventId: "evt_1",
      missionId: "msn_1",
      seq: 1,
      kind: "mission.created",
      actor: { kind: "nobody", id: "x" },
      cause: { directionId: null, leaseId: null },
      executionId: null,
      payload: {},
      schemaVersion: 1,
      occurredAt: new Date().toISOString()
    });
    expect(parsed.success).toBe(false);
  });

  it("only admits declared auth states across IPC", () => {
    expect(IpcAuthStatusSchema.safeParse({ state: "signed_out" }).success).toBe(true);
    expect(IpcAuthStatusSchema.safeParse({ state: "mystery" }).success).toBe(false);
  });
});

describe("the model allowlist", () => {
  // These six ids were each verified live against the Claude Code CLI. The
  // renderer, the IPC boundary, and the execution adapter must all read the
  // same list, or a menu entry becomes a flag the CLI rejects.
  it("keeps the labelled list and the validated enum identical and in order", () => {
    expect(ModelIdSchema.options).toEqual([
      ...CLAUDE_MODELS.map((model) => model.id),
      ...CODEX_MODELS.map((model) => model.id)
    ]);
    // The harness rides the model (D-230): every codex id derives codex,
    // every claude id derives claude-code, and an unknown string is claude —
    // the safe default, because a fallback model is a claude model.
    for (const model of CODEX_MODELS) expect(harnessOf(model.id)).toBe("codex");
    for (const model of CLAUDE_MODELS) expect(harnessOf(model.id)).toBe("claude-code");
  });

  it("refuses a model id that is not on the list", () => {
    expect(ModelIdSchema.safeParse("claude-opus-9").success).toBe(false);
    expect(ModelIdSchema.safeParse("sonnet").success).toBe(false);
  });

  it("defaults direction to an allowlisted model and effort", () => {
    const parsed = IpcDirectInputSchema.safeParse({ missionId: "msn_1", body: "do the thing" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.model).toBe(DEFAULT_MODEL);
    expect(parsed.data.effort).toBe(DEFAULT_EFFORT);
    expect(ModelIdSchema.options).toContain(DEFAULT_MODEL);
  });
});

describe("permission profiles (D-115)", () => {
  it("keeps the labelled list and the validated enum identical and in order", () => {
    expect(PermissionProfileSchema.options).toEqual(PERMISSION_PROFILES.map((profile) => profile.id));
  });

  it("has no bypass value, by name or by accident", () => {
    // Claude's bypassPermissions turns the asking off at the harness — no
    // routing, no record, no scope enforcement, no read-turn containment.
    // The vocabulary refusing it is the structural half of "no mode can
    // bypass server authorization": a value the schema cannot parse cannot
    // reach a row, a payload, or a flag.
    expect(PermissionProfileSchema.safeParse("bypass").success).toBe(false);
    expect(PermissionProfileSchema.safeParse("bypassPermissions").success).toBe(false);
    expect(PermissionProfileSchema.options.some((profile) => /bypass/i.test(profile))).toBe(false);
  });

  it("defaults to manual — the pre-profile behaviour — everywhere it lands", () => {
    expect(DEFAULT_PERMISSION_PROFILE).toBe("manual");
    const workstream = WorkstreamSchema.safeParse({
      workstreamId: "wst_1",
      missionId: "msn_1",
      name: "Current work",
      baseRef: "main",
      baseSha: "a".repeat(40),
      missionBranch: "novus/m-1",
      branchStatus: "created",
      branchError: null
    });
    expect(workstream.success).toBe(true);
    if (workstream.success) expect(workstream.data.permissionProfile).toBe("manual");
  });

  it("keeps the dangerous tier a subset of the vocabulary", () => {
    for (const profile of ADMIN_ONLY_PERMISSION_PROFILES) {
      expect(PermissionProfileSchema.options).toContain(profile);
    }
    expect(ADMIN_ONLY_PERMISSION_PROFILES).toContain("dont_ask");
  });

  it("records a policy-decided answer with its profile, and bounds it", () => {
    const parsed = RunnerEventSchema.safeParse({
      kind: "approval.policy",
      payload: {
        requestId: "req_1",
        toolName: "Write",
        decision: "allowed",
        profile: "accept_edits",
        summary: "Write NOTES.md"
      }
    });
    expect(parsed.success).toBe(true);
    expect(
      RunnerEventSchema.safeParse({
        kind: "approval.policy",
        payload: {
          requestId: "req_1",
          toolName: "Write",
          decision: "allowed",
          profile: "bypass",
          summary: "Write NOTES.md"
        }
      }).success
    ).toBe(false);
    expect(
      RunnerEventSchema.safeParse({
        kind: "approval.policy",
        payload: {
          requestId: "req_1",
          toolName: "Write",
          decision: "allowed",
          profile: "dont_ask",
          summary: "x".repeat(MAX_APPROVAL_SUMMARY + 1)
        }
      }).success
    ).toBe(false);
  });

  it("admits the profile on the running event and defaults an older runner's report", () => {
    const withProfile = RunnerEventSchema.safeParse({
      kind: "execution.running",
      payload: { harness: "claude-code", model: "m", effort: "high", permissionProfile: "plan" }
    });
    expect(withProfile.success).toBe(true);
    const older = RunnerEventSchema.safeParse({
      kind: "execution.running",
      payload: { harness: "claude-code", model: "m", effort: "high" }
    });
    expect(older.success).toBe(true);
    if (older.success && older.data.kind === "execution.running") {
      expect(older.data.payload.permissionProfile).toBe("manual");
    }
  });

  it("carries policy.set as a capability the server can grant", () => {
    expect(CapabilitySchema.safeParse("policy.set").success).toBe(true);
  });
});

describe("project skills (D-118)", () => {
  const digest = "d".repeat(64);

  it("names a skill as one directory segment — never a path, never a traversal", () => {
    expect(SkillNameSchema.safeParse("zephyr-codes").success).toBe(true);
    expect(SkillNameSchema.safeParse("release_notes.v2").success).toBe(true);
    // Every way a name could resolve somewhere else is unparseable, so a
    // traversal cannot reach the route, the row, or the composed directory.
    expect(SkillNameSchema.safeParse("../escape").success).toBe(false);
    expect(SkillNameSchema.safeParse("a/b").success).toBe(false);
    expect(SkillNameSchema.safeParse("a\\b").success).toBe(false);
    expect(SkillNameSchema.safeParse(".hidden").success).toBe(false);
    expect(SkillNameSchema.safeParse("..").success).toBe(false);
    expect(SkillNameSchema.safeParse("").success).toBe(false);
    expect(SkillNameSchema.safeParse("x".repeat(81)).success).toBe(false);
  });

  it("pins an approval to a full content digest, and bounds the manifest", () => {
    expect(EnabledSkillSchema.safeParse({ name: "a", digest }).success).toBe(true);
    expect(EnabledSkillSchema.safeParse({ name: "a", digest: "short" }).success).toBe(false);
    expect(
      ProjectSkillSchema.safeParse({ name: "a", description: null, digest, bytes: 12 }).success
    ).toBe(true);
    expect(
      ProjectSkillSchema.safeParse({ name: "a", description: null, digest, bytes: MAX_SKILL_BYTES + 1 })
        .success
    ).toBe(false);
    const crowd = Array.from({ length: MAX_PROJECT_SKILLS + 1 }, (_, i) => ({
      name: `skill-${i}`,
      digest
    }));
    expect(EnabledSkillsSchema.safeParse(crowd).success).toBe(false);
  });

  it("publishes the manifest beside the declared commands, defaulting an older runner's report", () => {
    const withSkills = RunnerEventSchema.safeParse({
      kind: "workspace.declared",
      payload: {
        commands: [],
        skills: [{ name: "zephyr-codes", description: "Codewords.", digest, bytes: 64 }]
      }
    });
    expect(withSkills.success).toBe(true);
    const older = RunnerEventSchema.safeParse({ kind: "workspace.declared", payload: { commands: [] } });
    expect(older.success).toBe(true);
    if (older.success && older.data.kind === "workspace.declared") {
      expect(older.data.payload.skills).toEqual([]);
    }
  });

  it("records what a turn carried, at the digest that ran, and what it dropped (D-193)", () => {
    const parsed = RunnerEventSchema.safeParse({
      kind: "execution.running",
      payload: {
        harness: "claude-code",
        model: "m",
        effort: "high",
        // Carried entries name the bytes that ran (D-193): with no approval
        // to check against, the digest is what the record is for.
        skills: [{ name: "zephyr-codes", digest }],
        skillsDropped: [{ name: "stale-one", reason: "could not be read" }]
      }
    });
    expect(parsed.success).toBe(true);
    // A drop is a named fact, not a free-form blob: unknown fields are refused.
    expect(
      RunnerEventSchema.safeParse({
        kind: "execution.running",
        payload: {
          harness: "claude-code",
          model: "m",
          effort: "high",
          skillsDropped: [{ name: "stale-one", reason: "r", body: "smuggled" }]
        }
      }).success
    ).toBe(false);
    const older = RunnerEventSchema.safeParse({
      kind: "execution.running",
      payload: { harness: "claude-code", model: "m", effort: "high" }
    });
    expect(older.success).toBe(true);
    if (older.success && older.data.kind === "execution.running") {
      expect(older.data.payload.skills).toEqual([]);
      expect(older.data.payload.skillsDropped).toEqual([]);
    }
  });

  it("admits only reviewable MCP servers: coupled transports, guarded urls, one tier up (D-119)", () => {
    const digest = "d".repeat(64);
    const stdio = { name: "docs", transport: "stdio", command: "node server.js", digest };
    expect(McpServerSchema.safeParse(stdio).success).toBe(true);
    // Transport and address are coupled: a stdio server names a command and
    // no url, a remote one an https url (http only on loopback) with no
    // credentials in the authority — an enablement is also an egress decision.
    expect(McpServerSchema.safeParse({ name: "docs", transport: "stdio", digest }).success).toBe(false);
    expect(
      McpServerSchema.safeParse({ name: "docs", transport: "http", url: "https://mcp.example.com", digest })
        .success
    ).toBe(true);
    expect(
      McpServerSchema.safeParse({ name: "docs", transport: "http", url: "http://mcp.example.com", digest })
        .success
    ).toBe(false);
    expect(
      McpServerSchema.safeParse({
        name: "docs",
        transport: "http",
        url: "https://user:pw@mcp.example.com",
        digest
      }).success
    ).toBe(false);
    expect(validMcpUrl("http://127.0.0.1:3000/mcp")).toBe(true);
    expect(CapabilitySchema.safeParse("mcp.set").success).toBe(true);
    // The running event records what was carried and dropped, defaulted for
    // an older runner exactly as the skills fields are.
    const older = RunnerEventSchema.safeParse({
      kind: "execution.running",
      payload: { harness: "claude-code", model: "m", effort: "high" }
    });
    expect(older.success).toBe(true);
    if (older.success && older.data.kind === "execution.running") {
      expect(older.data.payload.mcpServers).toEqual([]);
      expect(older.data.payload.mcpServersDropped).toEqual([]);
    }
  });

  it("defaults a lane to no skills enabled, and carries skills.set as a grantable capability", () => {
    const workstream = WorkstreamSchema.safeParse({
      workstreamId: "wst_1",
      missionId: "msn_1",
      name: "Current work",
      baseRef: "main",
      baseSha: "a".repeat(40),
      missionBranch: "novus/m-1",
      branchStatus: "created",
      branchError: null
    });
    expect(workstream.success).toBe(true);
    if (workstream.success) expect(workstream.data.enabledSkills).toEqual([]);
    expect(CapabilitySchema.safeParse("skills.set").success).toBe(true);
  });
});

describe("the runner event union", () => {
  // A runner may only say things Novus has a shape for. Arbitrary kinds are how
  // a compromised runner would write whatever it liked into the durable record.
  it("refuses an undeclared event kind", () => {
    expect(RunnerEventSchema.safeParse({ kind: "harness.thoughts", payload: {} }).success).toBe(false);
    expect(RunnerEventSchema.safeParse({ kind: "mission.created", payload: {} }).success).toBe(false);
  });

  it("refuses unknown fields inside a declared payload", () => {
    const parsed = RunnerEventSchema.safeParse({
      kind: "harness.text",
      payload: { text: "hello", secret: "shh" }
    });
    expect(parsed.success).toBe(false);
  });

  it("bounds harness text", () => {
    expect(
      RunnerEventSchema.safeParse({ kind: "harness.text", payload: { text: "x".repeat(8_001) } }).success
    ).toBe(false);
    expect(
      RunnerEventSchema.safeParse({ kind: "harness.text", payload: { text: "x".repeat(8_000) } }).success
    ).toBe(true);
  });

  it("bounds a checkpoint's file count and per-file diff", () => {
    const file = {
      path: "src/a.ts",
      changeState: "modified",
      additions: 1,
      deletions: 0,
      diff: "x".repeat(12_001)
    };
    const payload = {
      outcome: "committed",
      branch: "novus/m-1",
      files: [file]
    };
    expect(RunnerEventSchema.safeParse({ kind: "workspace.checkpoint", payload }).success).toBe(false);
    expect(
      RunnerEventSchema.safeParse({
        kind: "workspace.checkpoint",
        payload: { ...payload, files: Array.from({ length: 151 }, () => ({ ...file, diff: "ok" })) }
      }).success
    ).toBe(false);
  });

  it("requires a classified failure rather than free text", () => {
    expect(
      RunnerEventSchema.safeParse({
        kind: "execution.failed",
        payload: { classification: "vibes", reason: "it broke" }
      }).success
    ).toBe(false);
    expect(
      RunnerEventSchema.safeParse({
        kind: "execution.failed",
        payload: { classification: "nonzero_exit", reason: "exit 1" }
      }).success
    ).toBe(true);
  });

  it("bounds a harness approval's summary, and keeps its raw input out of the shape", () => {
    const payload = {
      requestId: "21740bb3-0000-0000-0000-000000000000",
      toolUseId: "toolu_01",
      toolName: "Write",
      displayName: "Write",
      summary: "the mission worktree/PROBE.md"
    };
    expect(RunnerEventSchema.safeParse({ kind: "approval.requested", payload }).success).toBe(true);
    // A file's contents can be megabytes. What travels is a summary.
    expect(
      RunnerEventSchema.safeParse({
        kind: "approval.requested",
        payload: { ...payload, summary: "x".repeat(MAX_APPROVAL_SUMMARY + 1) }
      }).success
    ).toBe(false);
    // `.strict()`: a runner cannot smuggle the tool input alongside it.
    expect(
      RunnerEventSchema.safeParse({
        kind: "approval.requested",
        payload: { ...payload, input: { file_path: "/Users/someone/.ssh/id_rsa", content: "-----BEGIN" } }
      }).success
    ).toBe(false);
  });

  it("names which path ended a stopped turn, and defaults to the forced one", () => {
    const graceful = RunnerEventSchema.safeParse({
      kind: "execution.stopped",
      payload: { reason: "Stopped by a participant.", via: "protocol_interrupt" }
    });
    expect(graceful.success && graceful.data.payload).toEqual({
      reason: "Stopped by a participant.",
      via: "protocol_interrupt"
    });
    // An older runner that says nothing is read as the kill it was doing.
    const legacy = RunnerEventSchema.safeParse({
      kind: "execution.stopped",
      payload: { reason: "Stopped by a participant." }
    });
    expect(legacy.success && legacy.data.payload.via).toBe("process_signal");
    expect(
      RunnerEventSchema.safeParse({
        kind: "execution.stopped",
        payload: { reason: "x", via: "vibes" }
      }).success
    ).toBe(false);
  });

  it("gives approval.respond to the lease and to no role", () => {
    // The capability exists as an enforceable verb, and PRODUCT.md's table puts
    // it in the lease column alone. The server-side half of that is asserted in
    // the control-plane suite; this only pins the vocabulary.
    expect(CapabilitySchema.safeParse("approval.respond").success).toBe(true);
    expect(RespondApprovalInputSchema.safeParse({ decision: "approve" }).success).toBe(true);
    expect(RespondApprovalInputSchema.safeParse({ decision: "deny", reason: "not that file" }).success).toBe(
      true
    );
    // There is no third answer: no "always allow", and nothing remembered.
    expect(RespondApprovalInputSchema.safeParse({ decision: "always_allow" }).success).toBe(false);
  });

  it("requires a positive origin sequence on every reported event", () => {
    const ok = ReportRunnerEventsInputSchema.safeParse({
      executionId: "exe_1",
      events: [{ originSeq: 1, event: { kind: "execution.starting", payload: {} } }]
    });
    expect(ok.success).toBe(true);
    const bad = ReportRunnerEventsInputSchema.safeParse({
      executionId: "exe_1",
      events: [{ originSeq: 0, event: { kind: "execution.starting", payload: {} } }]
    });
    expect(bad.success).toBe(false);
  });
});

describe("chat file scopes (D-097)", () => {
  it("matches paths the way the patterns read: ** crosses directories, * does not", () => {
    expect(pathInScope("server/api/routes.ts", ["server/**"])).toBe(true);
    expect(pathInScope("server/api.md", ["server/**"])).toBe(true);
    expect(pathInScope("apps/desktop/view.tsx", ["server/**"])).toBe(false);
    expect(pathInScope("src/a.ts", ["src/*.ts"])).toBe(true);
    expect(pathInScope("src/deep/a.ts", ["src/*.ts"])).toBe(false);
    expect(pathInScope("docs/README.md", ["docs/README.md"])).toBe(true);
    expect(pathInScope("./docs/README.md", ["docs/README.md"])).toBe(true);
    expect(pathInScope("docs/README.md.bak", ["docs/README.md"])).toBe(false);
  });

  it("declares scopes disjoint only when it can prove it, and overlap otherwise", () => {
    expect(scopesDisjoint(["server/**"], ["apps/desktop/**"])).toBe(true);
    expect(scopesDisjoint(["server/api/**"], ["server/**"])).toBe(false);
    expect(scopesDisjoint(["server/**"], ["server/api/*.ts"])).toBe(false);
    // A pattern with no literal prefix could reach anywhere: overlap, always.
    expect(scopesDisjoint(["*.ts"], ["docs/**"])).toBe(false);
    expect(scopesDisjoint(["**"], ["docs/**"])).toBe(false);
    // Sibling files under one directory are still divergent prefixes.
    expect(scopesDisjoint(["docs/a.md"], ["docs/b.md"])).toBe(true);
    // `server` the file and `server-tools/**`: diverging, not prefix-related.
    expect(scopesDisjoint(["server/**"], ["server-tools/**"])).toBe(true);
  });

  it("refuses patterns that leave the repository", () => {
    expect(ScopePatternSchema.safeParse("../outside/**").success).toBe(false);
    expect(ScopePatternSchema.safeParse("/absolute/**").success).toBe(false);
    expect(ScopePatternSchema.safeParse("a/../b/**").success).toBe(false);
    expect(ScopePatternSchema.safeParse("server/**").success).toBe(true);
  });
});

describe("the tracked pull request (D-099)", () => {
  it("pins the new vocabulary: the capability, the state, and the push command", () => {
    // Server-side enforcement is asserted in the control-plane suite; this
    // only pins that the words exist to enforce.
    expect(CapabilitySchema.safeParse("pr.manage").success).toBe(true);
    expect(MissionStateSchema.safeParse("pull_request_open").success).toBe(true);
    expect(RunnerCommandKindSchema.safeParse("push_branch").success).toBe(true);
  });

  it("has no merge word anywhere — not a capability, not a command, not a state", () => {
    // The absence is the guarantee (D-063's pattern): Novus can put a branch
    // on a host and can never combine one with another. The route-level half
    // is asserted in the control-plane suite by asking for a merge and being
    // told no such thing exists.
    for (const word of ["pr.merge", "merge.perform", "pull_request.merge"]) {
      expect(CapabilitySchema.safeParse(word).success, word).toBe(false);
    }
    for (const word of ["merge_pull_request", "merge_branch", "merge"]) {
      expect(RunnerCommandKindSchema.safeParse(word).success, word).toBe(false);
    }
    expect(MissionStateSchema.safeParse("merging").success).toBe(false);
  });

  it("admits only a request that names its decision, its snapshot, and its provenance", () => {
    const parsed = PullRequestSchema.safeParse({
      pullRequestId: "pr_a",
      missionId: "msn_a",
      workstreamId: "wst_a",
      decisionId: "dec_a",
      number: 4,
      url: "https://github.com/novus/demo-app/pull/4",
      state: "draft",
      mergeable: "unknown",
      title: "Ship the auth change",
      body: "## What this is\nreal body",
      baseRef: "main",
      headRef: "novus/m-abc",
      headSha: "a".repeat(40),
      requestedReviewers: ["maya"],
      reviewThreads: [],
      createdBy: "usr_a",
      createdByLogin: "kartik",
      mergedBy: null,
      mergedAt: null,
      closedAt: null,
      createdAt: new Date().toISOString(),
      lastSyncedAt: null
    });
    expect(parsed.success).toBe(true);
    // A pull request without the decision it publishes cannot exist.
    expect(
      PullRequestSchema.safeParse({
        ...(parsed.success ? parsed.data : {}),
        decisionId: undefined
      }).success
    ).toBe(false);
  });

  it("requires at least one named reviewer to ask for review", () => {
    expect(
      RequestReviewInputSchema.safeParse({ pullRequestId: "pr_a", reviewers: [] }).success
    ).toBe(false);
    expect(
      RequestReviewInputSchema.safeParse({ pullRequestId: "pr_a", reviewers: ["maya"] }).success
    ).toBe(true);
  });
});


describe("lent accounts (D-217)", () => {
  it("recognizes only the CLI's own `claude.ai {service}` spelling as a connector", () => {
    expect(ConnectorNameSchema.safeParse("claude.ai Gmail").success).toBe(true);
    expect(ConnectorNameSchema.safeParse("claude.ai Google Drive").success).toBe(true);
    // A project or machine server name is not a connector.
    expect(ConnectorNameSchema.safeParse("notion").success).toBe(false);
    expect(ConnectorNameSchema.safeParse("gmail").success).toBe(false);
  });

  it("derives the CLI's own tool prefix, so the un-lent can be disallowed and the lent recognized", () => {
    expect(connectorToolId("claude.ai Google Drive")).toBe("claude_ai_Google_Drive");
    expect(connectorToolPrefix("claude.ai Gmail")).toBe("mcp__claude_ai_Gmail__");
  });

  it("refuses a server that would wear a connector's prefix, in either spelling", () => {
    expect(impersonatesConnector("claude.ai Gmail")).toBe(true);
    expect(impersonatesConnector("claude_ai_Gmail")).toBe(true);
    expect(impersonatesConnector("Claude.AI Evil")).toBe(true);
    expect(impersonatesConnector("notion")).toBe(false);
    // A machine server may not be named to impersonate one.
    expect(
      MachineMcpServerSchema.safeParse({
        name: "claude_ai_Gmail",
        transport: "stdio",
        command: "node",
        digest: "a".repeat(64)
      }).success
    ).toBe(false);
  });

  it("carries a connector's state and whether its owner lent it, never a credential", () => {
    const parsed = ConnectorSchema.safeParse({
      name: "claude.ai Gmail",
      url: "https://gmailmcp.googleapis.com/mcp/v1",
      state: "connected",
      lent: true
    });
    expect(parsed.success).toBe(true);
    // No field carries a token — the schema is strict, so an extra one fails.
    expect(
      ConnectorSchema.safeParse({ name: "claude.ai Gmail", state: "connected", lent: false, token: "x" }).success
    ).toBe(false);
  });
});
