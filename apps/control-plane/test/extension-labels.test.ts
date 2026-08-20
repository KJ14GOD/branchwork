import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { FakeRepositoryProvider } from "../src/repo-provider.ts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * Extension labels (D-195).
 *
 * The rules under test: a label belongs to the organization and its name is
 * unique there case-insensitively, so typing one that exists selects it rather
 * than making a twin; assignments are set semantics keyed by the extension's
 * own name *and* its collection, so a repository skill and a machine skill
 * sharing a name never wear each other's labels; a repository's assignments do
 * not leak into another repository's mission; removing a label removes it
 * everywhere it was worn; and every verb is `skills.set`, which a Contributor
 * does not hold.
 *
 * Nothing here is event-recorded on purpose: the event log is the record of
 * what happened to the work, not of how somebody filed it.
 */

let harness: Harness;
let kartik: SignedIn;

const sha = (value: string) => createHash("sha1").update(value).digest("hex");

interface Lane {
  missionId: string;
  workstreamId: string;
}

beforeAll(async () => {
  harness = await createHarness("novus_test_labels", new FakeRepositoryProvider());
  kartik = await harness.signIn("kartik");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

async function mission(): Promise<Lane> {
  const localId = randomUUID();
  const headSha = sha(localId);
  await harness.app.inject({
    method: "POST",
    url: "/repositories/local",
    headers: bearer(kartik),
    payload: { localId, name: "novus/local", defaultBranch: "main", headSha }
  });
  const created = await harness.app.inject({
    method: "POST",
    url: "/missions",
    headers: bearer(kartik),
    payload: {
      goal: "File the extensions",
      successCriteria: "A team's own words stick to them",
      provider: "local",
      providerRepoId: localId,
      baseRef: "main",
      baseSha: headSha,
      creationKey: randomUUID()
    }
  });
  expect(created.statusCode).toBe(201);
  return {
    missionId: created.json().mission.missionId as string,
    workstreamId: created.json().workstream.workstreamId as string
  };
}

async function joinAs(missionId: string, who: string, role: string): Promise<SignedIn> {
  const joiner = await harness.signIn(who);
  const created = await harness.app.inject({
    method: "POST",
    url: `/missions/${missionId}/invitations`,
    headers: bearer(kartik),
    payload: { role }
  });
  await harness.app.inject({
    method: "POST",
    url: "/invitations/redeem",
    headers: bearer(joiner),
    payload: { token: created.json().token }
  });
  return joiner;
}

const createLabel = (lane: Lane, name: string, color: string, as: SignedIn = kartik) =>
  harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/extension-labels`,
    headers: bearer(as),
    payload: { name, color }
  });

const assign = (
  lane: Lane,
  source: string,
  name: string,
  labelIds: string[],
  as: SignedIn = kartik
) =>
  harness.app.inject({
    method: "PUT",
    url: `/missions/${lane.missionId}/extension-labels/assignments`,
    headers: bearer(as),
    payload: { source, name, labelIds }
  });

const detailOf = async (lane: Lane, as: SignedIn = kartik) => {
  const response = await harness.app.inject({
    method: "GET",
    url: `/missions/${lane.missionId}`,
    headers: bearer(as)
  });
  expect(response.statusCode).toBe(200);
  return response.json();
};

describe("the organization's own vocabulary", () => {
  it("creates a label once, and typing the same word again selects it rather than making a twin", async () => {
    const lane = await mission();
    const first = await createLabel(lane, "Review", "cyan");
    expect(first.statusCode).toBe(200);
    const labelId = first.json().label.labelId as string;
    expect(labelId).toMatch(/^lbl_/);

    // Case-insensitively the same word: the same label comes back.
    const again = await createLabel(lane, "review", "red");
    expect(again.statusCode).toBe(200);
    expect(again.json().label.labelId).toBe(labelId);
    // And its colour was not quietly rewritten by the second attempt.
    expect(again.json().label.color).toBe("cyan");

    const detail = await detailOf(lane);
    expect(detail.extensionLabels).toEqual([{ labelId, name: "Review", color: "cyan" }]);
  });

  it("renames and recolours, refusing a name another label already has", async () => {
    const lane = await mission();
    const keep = (await createLabel(lane, "keep", "green")).json().label;
    const other = (await createLabel(lane, "other", "blue")).json().label;

    const renamed = await harness.app.inject({
      method: "PATCH",
      url: `/missions/${lane.missionId}/extension-labels/${keep.labelId}`,
      headers: bearer(kartik),
      payload: { name: "kept", color: "magenta" }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().label).toEqual({
      labelId: keep.labelId,
      name: "kept",
      color: "magenta"
    });

    const clash = await harness.app.inject({
      method: "PATCH",
      url: `/missions/${lane.missionId}/extension-labels/${other.labelId}`,
      headers: bearer(kartik),
      payload: { name: "KEPT" }
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.message).toContain("already has that name");
  });

  it("is `skills.set`: a Contributor may not write the team's vocabulary", async () => {
    const lane = await mission();
    const contributor = await joinAs(lane.missionId, "con-labels", "contributor");
    expect((await createLabel(lane, "nope", "red", contributor)).statusCode).toBe(403);
    const operator = await joinAs(lane.missionId, "op-labels", "operator");
    expect((await createLabel(lane, "fine", "red", operator)).statusCode).toBe(200);
  });
});

describe("what an extension wears", () => {
  it("keeps a repo skill's labels apart from a machine skill of the same name", async () => {
    const lane = await mission();
    const repoLabel = (await createLabel(lane, "repo-side", "green")).json().label;
    const machineLabel = (await createLabel(lane, "machine-side", "yellow")).json().label;

    expect((await assign(lane, "repo", "twinned", [repoLabel.labelId])).statusCode).toBe(200);
    expect((await assign(lane, "machine", "twinned", [machineLabel.labelId])).statusCode).toBe(200);

    const detail = await detailOf(lane);
    // Exactly two rows carry this name, and each wears only its own side's
    // label: the collection is part of the key, never decoration.
    const twinned = detail.extensionLabelAssignments.filter(
      (entry: { name: string }) => entry.name === "twinned"
    );
    expect(twinned).toEqual(
      expect.arrayContaining([
        { labelId: repoLabel.labelId, source: "repo", name: "twinned" },
        { labelId: machineLabel.labelId, source: "machine", name: "twinned" }
      ])
    );
    expect(twinned).toHaveLength(2);
  });

  it("is set semantics, and refuses a label that is not this organization's", async () => {
    const lane = await mission();
    const one = (await createLabel(lane, "one", "red")).json().label;
    const two = (await createLabel(lane, "two", "blue")).json().label;

    const wornOn = async (name: string) =>
      (await detailOf(lane)).extensionLabelAssignments.filter(
        (entry: { name: string }) => entry.name === name
      );

    await assign(lane, "repo", "set-semantics", [one.labelId, two.labelId]);
    expect(await wornOn("set-semantics")).toHaveLength(2);
    // The whole set is what is written: dropping one leaves exactly the other.
    await assign(lane, "repo", "set-semantics", [two.labelId]);
    expect(await wornOn("set-semantics")).toEqual([
      { labelId: two.labelId, source: "repo", name: "set-semantics" }
    ]);

    const unknown = await assign(lane, "repo", "set-semantics", ["lbl_neverexisted00000"]);
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json().error.message).toContain("does not exist here");
  });

  it("does not carry one repository's filing into another's mission", async () => {
    const here = await mission();
    const elsewhere = await mission();
    const label = (await createLabel(here, "here-only", "cyan")).json().label;
    await assign(here, "repo", "scoped-here", [label.labelId]);
    // A machine skill is not repository-scoped, so it is visible from both.
    await assign(here, "machine", "everywhere", [label.labelId]);

    const other = await detailOf(elsewhere);
    // The vocabulary is the organization's and travels; the repo filing does not.
    expect(other.extensionLabels.some((entry: { name: string }) => entry.name === "here-only")).toBe(true);
    expect(other.extensionLabelAssignments).toContainEqual({
      labelId: label.labelId,
      source: "machine",
      name: "everywhere"
    });
    expect(
      other.extensionLabelAssignments.some((entry: { name: string }) => entry.name === "scoped-here")
    ).toBe(false);
  });

  it("removing a label removes it from everything that wore it", async () => {
    const lane = await mission();
    const doomed = (await createLabel(lane, "doomed", "red")).json().label;
    await assign(lane, "repo", "doomed-wearer", [doomed.labelId]);
    const wearing = (detail: { extensionLabelAssignments: { labelId: string }[] }) =>
      detail.extensionLabelAssignments.filter((entry) => entry.labelId === doomed.labelId);
    expect(wearing(await detailOf(lane))).toHaveLength(1);

    const removed = await harness.app.inject({
      method: "DELETE",
      url: `/missions/${lane.missionId}/extension-labels/${doomed.labelId}`,
      headers: bearer(kartik)
    });
    expect(removed.statusCode).toBe(200);
    const detail = await detailOf(lane);
    expect(detail.extensionLabels.some((entry: { name: string }) => entry.name === "doomed")).toBe(false);
    // Gone from the vocabulary is gone from every row that wore it.
    expect(wearing(detail)).toEqual([]);
  });
});
