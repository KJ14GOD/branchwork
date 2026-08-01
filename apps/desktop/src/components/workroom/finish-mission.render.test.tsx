import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { CompletionState } from "./completion-state.tsx";
import { FinishMission } from "./finish-mission.tsx";

/**
 * Ending a mission, and the one thing this form must never let somebody do.
 *
 * A person finishing their own work is exactly who is most tempted to call it
 * verified, so the form does not offer them the choice: the route computes the
 * verdict from the log and freezes it. What the form owes them instead is to
 * say what is about to be recorded, before they write the sentence rather than
 * after.
 */

const finish = (
  verification: "verified" | "failing" | "unverified",
  filesChanged = 2,
): string =>
  renderToStaticMarkup(
    <FinishMission
      verification={verification}
      filesChanged={filesChanged}
      onFinish={async () => true}
      onClose={() => {}}
    />,
  );

test("the form states the evidence before it asks for a summary", () => {
  const html = finish("unverified");
  const evidence = html.indexOf("Nothing has verified these changes");
  const question = html.indexOf("What happened?");

  assert.ok(evidence >= 0, "the evidence must be stated");
  assert.ok(question >= 0, "the summary must be asked for");
  assert.ok(
    evidence < question,
    "the evidence belongs above the field, while somebody is still deciding what to type",
  );
});

test("nothing in the form lets a person state their own verification", () => {
  // The route freezes what the log says. A control here would be an invitation
  // to disagree with it, on the one screen where the temptation is highest.
  const html = finish("unverified");

  assert.doesNotMatch(html, /name="verification"/);
  assert.doesNotMatch(html, /Mark as verified/i);
});

test("only a genuine pass is drawn as one", () => {
  assert.match(finish("verified"), /finish__evidence--pass/);
  assert.doesNotMatch(finish("unverified"), /finish__evidence--pass/);
  // Failing is not the same as nothing — the two must not share a treatment.
  assert.match(finish("failing"), /finish__evidence--fail/);
  assert.doesNotMatch(finish("failing"), /finish__evidence--unknown/);
});

test("abandoning is offered as an equal, not as a failure", () => {
  const html = finish("verified");

  assert.match(html, /Resolved/);
  assert.match(html, /Abandoned/);
  // Same primitive, so neither reads as the awkward one. A form that made
  // abandoning harder would push people into calling dead work resolved.
  assert.equal(html.match(/class="segment[^"]*"/g)?.length, 2);
});

test("the mission cannot be finished until the summary clears the floor", () => {
  // The same 12-character floor the route enforces, checked here so the
  // button is simply not available yet rather than available and refused.
  assert.match(finish("verified"), /disabled/);
});

const completion = {
  outcome: "resolved" as const,
  summary: "The checkout test passes again after the tax rounding fix.",
  verification: "unverified" as const,
  filesChanged: 2,
  completedBy: "p-kartik",
  completedAt: new Date(Date.UTC(2026, 7, 1, 12, 0)).toISOString(),
};

test("a finished mission shows the evidence it was finished on, not today's", () => {
  const html = renderToStaticMarkup(
    <CompletionState completion={completion} who="Kartik" onReopen={() => {}} />,
  );

  // Frozen: resolved, and unverified, at once. Both are true and the screen
  // says both — an outcome is what the team decided, not what the tests did.
  assert.match(html, /This mission is resolved/);
  assert.doesNotMatch(html, /finished__proof--pass/);
  assert.match(html, /Reopen mission/);
});

test("reopening is always available, and never the screen's primary action", () => {
  const html = renderToStaticMarkup(
    <CompletionState completion={completion} who="Kartik" onReopen={() => {}} />,
  );

  // The composer's Send owns the one inversion this app has. A second filled
  // control on the same screen spends the mechanism that makes it readable.
  assert.doesNotMatch(html, /button--primary/);
});
