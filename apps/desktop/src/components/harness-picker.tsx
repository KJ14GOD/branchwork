import type { HarnessKind } from "@novus/contracts";
import type { ProviderStatus } from "@novus/contracts/protocol";

/**
 * Which agent runs this mission.
 *
 * The choice Novus exists to offer. Until now a mission ran on whatever the
 * worker was configured with, so "bring the agents your team already uses" was
 * true of the architecture and invisible in the product.
 *
 * Only harnesses this machine can actually reach are offered. One that is
 * installed but not signed in is shown and disabled with the reason, rather
 * than hidden — hiding it turns "you need to run `codex login`" into "Novus
 * does not support Codex", which is a different and wrong message.
 */

export type HarnessChoice = {
  kind: HarnessKind;
  name: string;
  detail: string;
  available: boolean;
};

/** The provider list, as the two or three things a person may pick between. */
export const harnessChoices = (
  providers: readonly ProviderStatus[],
): HarnessChoice[] => {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));

  const of = (
    id: string,
    kind: HarnessKind,
    name: string,
  ): HarnessChoice | null => {
    const provider = byId.get(id);

    if (!provider?.installed) {
      // Not installed is not a choice, and listing it would be offering
      // something pressing it cannot deliver.
      return null;
    }

    return {
      kind,
      name,
      detail: provider.detail,
      available: provider.connected,
    };
  };

  return [
    of("claude-code", "claude-code", "Claude Code"),
    of("codex", "codex", "Codex"),
    of("novus-builtin", "novus-builtin", "Novus agent"),
  ].filter((choice): choice is HarnessChoice => choice !== null);
};

export const HarnessPicker = ({
  choices,
  selected,
  onSelect,
}: {
  choices: readonly HarnessChoice[];
  selected: HarnessKind | null;
  onSelect: (kind: HarnessKind) => void;
}) => {
  if (choices.length < 2) {
    // One option is not a choice, and a picker with a single entry teaches
    // people to ignore pickers.
    return null;
  }

  return (
    <div className="harness" role="group" aria-label="Which agent runs this">
      {choices.map((choice) => (
        <button
          className={
            selected === choice.kind
              ? "harness__option harness__option--selected"
              : "harness__option"
          }
          key={choice.kind}
          type="button"
          disabled={!choice.available}
          aria-pressed={selected === choice.kind}
          // The reason, on the control itself. A disabled button with no
          // explanation is the app refusing without saying why.
          title={
            choice.available
              ? `${choice.name} · ${choice.detail}`
              : `${choice.name} is installed but not signed in — ${choice.detail}`
          }
          onClick={() => onSelect(choice.kind)}
        >
          <span className="harness__name">{choice.name}</span>
          <span className="harness__detail">{choice.detail}</span>
        </button>
      ))}
    </div>
  );
};
