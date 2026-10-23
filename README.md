# Local agent harness

A local coding-agent harness with a TypeScript workflow and a C++ llama.cpp
inference sidecar. It supports saved conversations, workspace checkpoints,
rewind/fork, file tools and optional sequential Reader/Writer subagents.

## What is saved

This project uses saved history and inference recomputation, not persisted
KV-cache checkpoints.

| State | Durable storage |
| --- | --- |
| Messages, assistant tool calls, tool results and configuration | `sessions/<id>/history.jsonl` |
| Workspace file versions paired with checkpoints | Local `snapshots.git` object store |
| Evaluated token IDs and computed KV state | RAM only; not saved in checkpoints |

Resume, rewind and conversation forks restore messages and settings, render the
selected history, then tokenize/evaluate it again. Background preparation can do
this while the user reads or types. We do not write a separate token-ID log or
save/load native KV snapshots. This keeps durable storage small at the cost of
recomputing model context.

llama.cpp still uses temporary KV state during inference, and the sidecar can
reuse a matching evaluated prefix in RAM. That runtime optimization is separate
from conversation persistence and file rewind.

## Current work

New coding conversations edit their own `sessions/<id>/workspace`. Rewind restores
that same workspace; a fork gets independent files. Reader/Writer children share
the parent's loaded model serially, use separate messages and return a compact
report; they do not get saved KV states or create per-child checkpoints.

Delegation is installed for new conversations. A child-prompt clarification is
still awaiting approval after a live Reader returned placeholder evidence without
reading a file. Its temporary-copy Reader/Writer checks passed; this is not a
quality benchmark. See [decisions](notes/decisions.md) for status and evidence.

Read [the command reference](c/SIDECAR_COMMANDS.md) for launcher and in-harness commands
and [the guide](c/SIDECAR_GUIDE.md) for setup, workspace selection, and debugging.

After building the sidecar and installing TypeScript dependencies as described
in the guide, run from the repository root:

```sh
LLAMA_MODEL_PATH="/absolute/path/to/model.gguf" \
node ts/src/dependencies/node_modules/tsx/dist/cli.mjs --tsconfig ts/tsconfig.json ts/main.ts
```
