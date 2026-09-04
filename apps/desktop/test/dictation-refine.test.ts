import { describe, expect, it } from "vitest";
import {
  contentTokens,
  guardRefinement,
  isLikelyHallucination,
  looksLikePromptEcho,
  refineSystemPrompt,
  refineUserPrompt
} from "../electron/dictation-refine";

/**
 * The refinement guard (D-240): a model's edit may stand only when it kept
 * the person's words, added none of its own, and edited rather than
 * answered. Every refusal names its reason.
 */

const RAW =
  "so um I want you to refactor the composer dot t s x file to um use the new dictation bridge and and run pnpm build in apps slash desktop";

describe("the ask", () => {
  it("names the vocabulary, the context, and the transcript", () => {
    const prompt = refineUserPrompt({
      raw: RAW,
      vocabulary: ["composer.tsx", "pnpm"],
      context: { goal: "Add a microphone", recent: ["fix the tests"], before: "Also: ", after: "" }
    });
    expect(prompt).toContain("VOCABULARY: composer.tsx, pnpm");
    expect(prompt).toContain("Mission goal: Add a microphone");
    expect(prompt).toContain("Earlier direction: fix the tests");
    expect(prompt).toContain("Text already typed before the dictation: Also: ");
    expect(prompt).not.toContain("after the dictation");
    expect(prompt.endsWith(`RAW TRANSCRIPT: ${RAW}`)).toBe(true);
    expect(refineSystemPrompt()).toContain("Do not:");
  });
});

describe("the guard", () => {
  it("accepts a faithful, minimally edited transcript", () => {
    const refined = "I want you to refactor the composer.tsx file to use the new dictation bridge and run pnpm build in apps/desktop.";
    expect(guardRefinement(RAW, refined, ["composer.tsx", "pnpm"])).toEqual({ accepted: true });
  });

  it("accepts spoken code written as code", () => {
    const raw = "call camel case get user with dash dash verbose and open dot slash src slash app dot ts";
    const refined = "Call getUser with --verbose and open ./src/app.ts";
    expect(guardRefinement(raw, refined)).toEqual({ accepted: true });
  });

  it("refuses an answer instead of an edit", () => {
    const verdict = guardRefinement(RAW, "Sure! Here is the refactored composer.tsx:\n\n```tsx\nexport function Composer() {}\n```");
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.reason).toMatch(/answered/);
  });

  it("refuses an empty answer", () => {
    const verdict = guardRefinement(RAW, "   ");
    expect(verdict.accepted).toBe(false);
  });

  it("refuses when the person's words were lost", () => {
    const verdict = guardRefinement(RAW, "Refactor the composer.tsx file.");
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.reason).toMatch(/dropped|lost/);
  });

  it("refuses words nobody said", () => {
    const verdict = guardRefinement(
      "please rename the helper function",
      "Please rename the helper function, add comprehensive unit tests, update the changelog, and open a pull request."
    );
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.reason).toMatch(/added/);
  });

  it("refuses a code block nobody dictated", () => {
    const verdict = guardRefinement(
      "write the schema for the dictation event with kind and text",
      "Write the schema for the dictation event with kind and text:\n```ts\nz.object({ kind: z.string(), text: z.string() })\n```"
    );
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.reason).toMatch(/code block/);
  });

  it("lets a vocabulary term correct a misheard one", () => {
    const raw = "open the connectors dot t s x and the vite config";
    const refined = "Open connectors.tsx and vite.config.ts";
    expect(guardRefinement(raw, refined, ["connectors.tsx", "vite.config.ts"])).toEqual({ accepted: true });
  });

  it("tokenises for content, dropping stop words and fillers", () => {
    expect(contentTokens("um so the getUser helper, and foo_bar!")).toEqual(["getuser", "helper", "foo_bar"]);
  });
});

describe("what a model says to silence", () => {
  it("recognises its own prompt coming back", () => {
    const prompt = "A software engineer is directing a coding agent. Names that may be spoken: composer.tsx, pnpm.";
    expect(looksLikePromptEcho("A software engineer is directing a coding agent.", prompt)).toBe(true);
    expect(looksLikePromptEcho(prompt, prompt)).toBe(true);
    expect(looksLikePromptEcho("refactor the composer", prompt)).toBe(false);
  });

  it("recognises the stock phrases for nothing", () => {
    expect(isLikelyHallucination("Thank you.", 2000)).toBe(true);
    expect(isLikelyHallucination("Thanks for watching!", 2000)).toBe(true);
    expect(isLikelyHallucination("refactor the composer", 100)).toBe(true);
    expect(isLikelyHallucination("Thank you for the composer refactor, it works", 2000)).toBe(false);
    expect(isLikelyHallucination("", 0)).toBe(false);
  });
});
