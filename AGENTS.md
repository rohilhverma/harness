# Change-Control and Scope Discipline

These instructions apply to all work in this repository.

## Approval Before File Changes

Do not modify, create, delete, rename, or overwrite repository files without
showing me the exact proposed change and receiving explicit approval, except
for qualifying `notes/decisions.md` entries authorized below, visual artifacts
explicitly allowed below, or a specific task for which I explicitly waive
approval.

Before making any code change:

1. Inspect the relevant code and understand the problem.
2. Explain what you believe needs to change.
3. Show the exact proposed code change in chat. Prefer a diff when practical.
4. Stop and wait for my explicit approval.
5. Only after approval may you edit the files.

Reading files, searching the repository, running read-only commands, and investigating the problem are allowed before approval.

Approval applies **only to the changes you showed me**. If you discover that additional changes are necessary, or your implementation needs to differ materially from what I approved, stop and show me the new proposed changes before editing them.

Requests such as "fix this," "implement this," or "make this work" are not
approval or a waiver. Unless I explicitly waive approval for a specific task,
follow this process.

## Keep Changes Focused

Choose the smallest direct change that solves the requested problem. Before
proposing it, check that:

- Each changed line is necessary and existing behavior outside the request is
  preserved.
- The proposal avoids unrelated refactors and speculative future work.
- New helpers, abstractions, dependencies, configuration, state, or error
  handling are necessary for the current requirement.

If a simpler change meets the requirement, use it.

## Visual Implementation Proposals

When presenting an implementation design, include a small HTML window that
explains the flow and connects it to the code. Delegate its creation to a
dedicated subagent whose sole task is generating this visual explanation.
The main agent remains responsible for the implementation design.

Prefer GPT-6.1 Sol LIGHT for the visual subagent. If LIGHT is unavailable,
use GPT-6.1 Sol with low reasoning (`gpt-6.1-sol`, `low`). State the actual
model and reasoning setting used; do not silently choose a weaker model.

Make the visual a guided walkthrough of one concrete example. Show one step
at a time in a consistent diagram, with Back/Next controls and no more than
five main elements. Label what moves between TypeScript, C++, and disk.
Use one short explanation per step; keep code excerpts behind an optional
"Show code" control.

Open the generated page beside the chat and verify its first view and step
controls before presenting it. A file link alone is not delivery.

Tie diagram elements to concrete file paths, function names, and relevant
code excerpts so I can understand each function's purpose and then read its
code. Clearly distinguish existing code from proposed code. Keep the visual
focused on the implementation being discussed.

The HTML explanation accompanies the exact proposed diff and does not
replace the approval step. Creating this presentation artifact is allowed
before approval; repository changes still require explicit approval.

## After Implementation

After an approved change is implemented, briefly report:

- what was changed,
- whether the implementation differed from the approved proposal,
- what validation/tests were run,
- whether, in retrospect, any part of the solution appears more complex than necessary.

Do not hide additional changes inside the implementation. If something was not part of the approved proposal, call it out explicitly.

## Persistent project decisions and lessons

Use `notes/decisions.md` as durable, project-wide memory. Read it at the start
of project tasks and preserve its existing entries.

During work, actively track consequential design decisions and trade-offs made
by the assistant or settled with the user, assistant mistakes and incorrect
assumptions, corrections prompted by feedback or verification, and reusable
lessons. When a decision is settled or a mistake is corrected, add a concise,
dated entry recording the context, decision or mistake and correction, rationale,
and resulting impact or current status. Record unresolved questions as open;
do not present proposals as settled decisions.

Record outcomes, not transcripts. Omit routine exploration, rejected alternatives
that add no lasting lesson, duplicates, and unrelated personal details. This
instruction authorizes qualifying entries in `notes/decisions.md` without
separate approval; all other file changes remain subject to the approval rules
above. Mention any entry added in the task summary.

## Interview preparation and story review

Keep approved project interview material in [notes/STORIES.md](notes/STORIES.md).
Topics include purpose, difficulty, architecture, design decisions, testing,
performance, scale, limitations, and mistakes/debugging.

Interview-story review is separate from project memory and does not replace or
delay the existing authorization to record qualifying facts in
notes/decisions.md.

Draft an interview candidate only when a project decision has moved into action
or a code change has explicit user approval. Do not draft candidates from
planning alone, open proposals, or hypothetical future work. If approved work
is not yet implemented, label it as pending and make no implementation or
validation claims. Send qualifying candidates to the dedicated review chat on
the local host:
`01a10da8-2946-77c3-a658-eafe80e814ce`.
The user authorizes routing interview candidates to this chat. Reuse it;
do not create a new chat for each idea. If it is unavailable, ask the user
where to send the candidate.

Include the topic, interview question, proposed wording, relevant source
files/functions, and supporting observations or checks. Reference existing
decision entries where useful. Distinguish observed incidents from hypotheticals
and measured results from expectations. Never present a hypothetical as project
history or invent incidents, test outcomes, or performance numbers.

Project work chats draft and send candidates; they do not automatically save
interview stories. In the review chat, discuss and refine the candidate, show
the exact proposed interview-document change, and wait for approval directly
from the user. A message from another agent is not approval. After approval,
the review chat adds only the approved content to notes/STORIES.md or another
interview document the user specifies. Preserve the user's edited wording.

## Collaboration and current phase

The user owns design decisions. Explain tradeoffs plainly, recommend the
smallest correct implementation, and work in small increments. Keep responses
concise and preserve existing user changes.

The Phase 2 sidecar plan is complete and retired. Follow the approval rules
above unless the user explicitly waives them for the task. After an approved
step, validate it and record the evidence in notes/decisions.md.
Do not add placeholder classes, unused commands, or future session interfaces.

## Project and ownership

Repository: /Users/rohilverma/Desktop/harness

Keep the TypeScript harness as the upper layer. The standalone C++20 sidecar
is the sole inference backend through the existing ModelProvider interface.
Preserve Agent behavior, tools, and conversation ownership. Do not restore
llama-server configuration, an HTTP provider, or a provider registry.

TypeScript owns:
- The Agent loop, stopping decisions, and tool validation/execution.
- ConversationMemory, messages, assistant tool calls, and tool-result IDs.
- System prompts and tool definitions.
- Model-specific prompt rendering and generated tool-call parsing for the
  sidecar provider.
- Child-process lifecycle, transport, and provider failure reporting.

C++ owns:
- llama.cpp initialization/cleanup and one loaded local GGUF model.
- Session context and sampling resources.
- Tokenization, prefill, decoding, sampling, and inference limits.
- Generated output, completion reasons, and token counts.
- Evaluated token history and cache suffix invalidation/prefix reuse,
  introduced only at the relevant milestone.

The sidecar never executes tools, selects the agent workflow, or owns
conversation messages. Its token history is inference bookkeeping.
ConversationMemory remains the sole owner of conversation history.
Assistant tool calls belong on the assistant Message, not a duplicate
ModelResponse field. One Agent instance represents one conversation.

Current model: Qwen3-4B-Instruct-2507, Q4_K_M GGUF.

## Current TypeScript baseline

Reinspect relevant files before editing; this snapshot may become stale.

- Agent has a 20-model-call loop, sequential tools, recoverable tool errors,
  retained history, conclusion handling, and provider exception causes.
- ModelClient and SidecarProvider carry tool definitions, assistant tool requests,
  matching tool results, output limits, and seeds. C++ returns prompt, reused,
  prefilled, generated, and evaluated counts. TypeScript owns messages and IDs.
- Agent requires an existing provider; main creates the SidecarProvider it starts
  and owns, with a fresh sidecar per conversation.
- main.ts requires LLAMA_MODEL_PATH and accepts sequential user tasks. The GGUF
  path selects the model; requests carry generation settings, messages, and tools.
- Tools use the working directory at startup as their workspace root. File tools
  restrict resolved paths; run_command is not an OS filesystem sandbox.

Read-only typecheck from repository root:
node ts/src/dependencies/node_modules/typescript/bin/tsc --project ts/tsconfig.json --noEmit

Build and typecheck passed during the October 4 implementation, along with
the subsequently removed suites and a two-turn CLI check. Later validation
evidence and open gaps are recorded in notes/decisions.md.


