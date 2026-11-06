# Agent Instructions

These instructions apply to all work in this repository.

## Reporting changes

You may modify, create, delete, rename, or overwrite repository files without
asking first. After carrying out a change, state clearly what you implemented:

- **Scope:** what the change does and why.
- **Touched:** the files, functions, and areas of the codebase it affects.
- **Implementation:** a high-level description of how it works.

## Staying in scope

Do only what the task explicitly asks for. If a change would go beyond the
current task, slow down: show me the exact change you have in mind and wait
for my approval before making it.

Do not add abstractions, helpers, state, configuration, dependencies, or error
handling unless the current task needs them.

## Subagents

Whenever you start a subagent, show me the exact prompt you send it.

Keep subagents independent. Give each one a fresh, self-contained brief with
only the instructions its task needs and nothing else: no conversation
history, no unrelated project background, and no instructions meant for other
tasks.
