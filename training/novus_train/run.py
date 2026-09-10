"""The training run itself (D-255): TRL's GRPO or DPO over a LoRA adapter.

Kept apart from the plan so the plan runs anywhere. This module needs a
GPU box with the dependencies in pyproject installed; it writes adapter
checkpoints every `checkpoint_every` steps under `output` and resumes from
`resume_from` when given, so a run that dies is a run that continues.
"""
from __future__ import annotations

from .data import pairs, trajectories
from .recipes import RecipeConfig, dpo_rows, grpo_rows, reward_fn_from_dataset


def run_recipe(config: RecipeConfig) -> None:
    from datasets import Dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(config.base_model)
    model = AutoModelForCausalLM.from_pretrained(config.base_model)
    lora = LoraConfig(r=config.lora_rank, lora_alpha=config.lora_rank * 2, target_modules="all-linear", task_type="CAUSAL_LM")

    if config.recipe == "grpo":
        from trl import GRPOConfig, GRPOTrainer

        rows = grpo_rows(trajectories(config.dataset))
        trainer = GRPOTrainer(
            model=model,
            processing_class=tokenizer,
            reward_funcs=reward_fn_from_dataset(rows),
            train_dataset=Dataset.from_list([{"prompt": r["prompt"]} for r in rows]),
            peft_config=lora,
            args=GRPOConfig(
                output_dir=str(config.output),
                learning_rate=config.learning_rate,
                max_steps=config.max_steps,
                per_device_train_batch_size=config.batch_size,
                max_prompt_length=config.max_prompt_tokens,
                max_completion_length=config.max_completion_tokens,
                save_steps=config.checkpoint_every,
                seed=config.seed,
                report_to=[],
            ),
        )
    else:
        from trl import DPOConfig, DPOTrainer

        rows = dpo_rows(pairs(config.dataset))
        trainer = DPOTrainer(
            model=model,
            processing_class=tokenizer,
            train_dataset=Dataset.from_list(rows),
            peft_config=lora,
            args=DPOConfig(
                output_dir=str(config.output),
                learning_rate=config.learning_rate,
                max_steps=config.max_steps,
                per_device_train_batch_size=config.batch_size,
                max_prompt_length=config.max_prompt_tokens,
                max_length=config.max_prompt_tokens + config.max_completion_tokens,
                save_steps=config.checkpoint_every,
                seed=config.seed,
                report_to=[],
            ),
        )
    trainer.train(resume_from_checkpoint=str(config.resume_from) if config.resume_from else None)
    trainer.save_model(str(config.output / "final"))
