"""The two recipes (D-255).

GRPO over verifiable rewards: the export's `reward` per trajectory is the
signal — checks passed, decisions chosen, merges — and the prompt is the
direction with the transcript before it. DPO over preference pairs: two
lanes forked from one checkpoint, chosen against not chosen, same prompt.
Both run as LoRA adapters over an open model; the base never changes.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import json


@dataclass(frozen=True)
class RecipeConfig:
    recipe: str  # "grpo" | "dpo"
    base_model: str
    dataset: Path
    output: Path
    lora_rank: int = 16
    learning_rate: float = 1e-5
    max_steps: int = 1000
    batch_size: int = 4
    max_prompt_tokens: int = 8192
    max_completion_tokens: int = 4096
    seed: int = 7
    checkpoint_every: int = 100
    resume_from: Path | None = None
    extra: dict[str, Any] | None = None


def load_config(path: Path) -> RecipeConfig:
    raw = json.loads(path.read_text())
    if raw.get("recipe") not in ("grpo", "dpo"):
        raise ValueError("recipe must be grpo or dpo")
    return RecipeConfig(
        recipe=raw["recipe"],
        base_model=raw["base_model"],
        dataset=Path(raw["dataset"]),
        output=Path(raw["output"]),
        lora_rank=int(raw.get("lora_rank", 16)),
        learning_rate=float(raw.get("learning_rate", 1e-5)),
        max_steps=int(raw.get("max_steps", 1000)),
        batch_size=int(raw.get("batch_size", 4)),
        max_prompt_tokens=int(raw.get("max_prompt_tokens", 8192)),
        max_completion_tokens=int(raw.get("max_completion_tokens", 4096)),
        seed=int(raw.get("seed", 7)),
        checkpoint_every=int(raw.get("checkpoint_every", 100)),
        resume_from=Path(raw["resume_from"]) if raw.get("resume_from") else None,
        extra=raw.get("extra"),
    )


def prompt_of(trajectory: dict) -> str:
    """The model's input: the mission's goal, the transcript so far, the direction."""
    parts = [f"Mission: {trajectory['goal']}"]
    if trajectory.get("transcriptBefore"):
        parts.append(trajectory["transcriptBefore"])
    parts.append(f"Direction: {trajectory['direction']}")
    return "\n\n".join(parts)


def grpo_rows(trajectories) -> list[dict]:
    rows = []
    for t in trajectories:
        if t.get("reward") is None or not t.get("completion"):
            continue  # never invent a reward where no signal exists
        rows.append({"prompt": prompt_of(t), "completion": t["completion"], "reward": float(t["reward"])})
    return rows


def dpo_rows(pairs) -> list[dict]:
    rows = []
    for p in pairs:
        if not p.get("chosen") or not p.get("rejected"):
            continue
        rows.append({"prompt": prompt_of(p), "chosen": p["chosen"], "rejected": p["rejected"]})
    return rows


def reward_fn_from_dataset(rows: list[dict]):
    """GRPO's reward function: the exported reward for the matching prompt/completion.

    TRL calls it with the prompts and completions it sampled; a sampled
    completion that is not in the record scores by the recorded reward of
    its prompt's best-known completion only when it matches verbatim, and
    zero otherwise — offline GRPO cannot run the checks on new samples. A
    live reward (run the mission's checks on the sample) is the next stage.
    """
    by_prompt: dict[str, dict[str, float]] = {}
    for row in rows:
        by_prompt.setdefault(row["prompt"], {})[row["completion"]] = row["reward"]

    def reward(prompts, completions, **_):
        return [by_prompt.get(p, {}).get(c, 0.0) for p, c in zip(prompts, completions)]

    return reward
