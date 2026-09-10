"""novus-train: plan, dry-run, and run a recipe (D-255)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .data import pairs, read_manifest, trajectories
from .recipes import dpo_rows, grpo_rows, load_config


def plan(config_path: Path) -> dict:
    config = load_config(config_path)
    manifest = read_manifest(config.dataset)
    if config.recipe == "grpo":
        rows = grpo_rows(trajectories(config.dataset))
    else:
        rows = dpo_rows(pairs(config.dataset))
    return {
        "recipe": config.recipe,
        "baseModel": config.base_model,
        "dataset": manifest.dataset_id,
        "rows": len(rows),
        "steps": config.max_steps,
        "batchSize": config.batch_size,
        "loraRank": config.lora_rank,
        "output": str(config.output),
        "resumeFrom": str(config.resume_from) if config.resume_from else None,
    }


def train(config_path: Path) -> None:
    # Imported here so a dry run needs no GPU stack installed.
    from .run import run_recipe

    run_recipe(load_config(config_path))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="novus-train")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "train"):
        p = sub.add_parser(name)
        p.add_argument("config", type=Path)
    args = parser.parse_args(argv)
    if args.command == "plan":
        print(json.dumps(plan(args.config), indent=2))
        return 0
    train(args.config)
    return 0


if __name__ == "__main__":
    sys.exit(main())
