# Project interview stories

A working document for project interview questions and approved answers.
New candidates are discussed in the dedicated review chat before being saved.
Keep observed behavior, hypothetical examples, and measured results clearly labeled.

## Purpose

Question: What does this project do, and what problem does it solve?

To prepare.

## Difficulty

Question: What was the most technically difficult part of your contribution,
and how did you work through it?

### Pairing conversation checkpoints with file history during rewind

**Status:** Approved and implemented on 2026-10-11. The checks below are recorded results from that change; the live model run was one smoke test.

**Question:** How did you make a coding agent's rewind restore both its conversation and its files, and what trade-offs did you make?

I kept conversation messages in TypeScript and added a local bare Git object store for eligible workspace files. In new v2 coding conversations, the runner saves a file tree alongside each returned user turn's messages, assistant tool calls, and tool results. Rewind restores a selected tree in the same workspace and moves the active conversation head; later checkpoints stay available. A fork gets its own workspace.

The hard part was keeping file restoration and conversation history consistent if rewind stopped partway through. The runner stages and checks the target, captures the current files, and publishes a recovery journal before replacing managed files. After restoration, it appends and syncs a rewind event. On resume, the journal and history show whether that event was committed. If rewind was interrupted, recovery first captures the live files—including any manual edits—then restores the pre-rewind files and removes the incomplete history tail. Replacing multiple files is not itself atomic; the journal makes an interrupted rewind recoverable.

Recorded validation includes TypeScript type and unused checks, a bundle build, scratch checks for restoration and history compatibility, and injected failures during journal publication, marker sync, and cleanup. In one live Qwen smoke test, the agent edited an existing function, verified it, ran `npm test`, rewound to baseline, and forked the retained checkpoint. This demonstrates that flow in one run, not broad coding quality or power-loss durability; no benchmark was run.

The snapshotter scans eligible files, supports regular files up to 16 MiB, rejects links and special files, and excludes dependency and build directories. External command effects are not rewound, forks use independent workspace space, and there is no snapshot deletion policy or storage quota.

**Sources:** [workspaceHistory.ts](/Users/rohilverma/Desktop/harness/ts/src/workspaceHistory.ts), [conversationStore.ts](/Users/rohilverma/Desktop/harness/ts/src/conversationStore.ts), [main.ts](/Users/rohilverma/Desktop/harness/ts/main.ts), [WORKSPACE_HISTORY.md](/Users/rohilverma/Desktop/harness/notes/WORKSPACE_HISTORY.md), [decisions.md](/Users/rohilverma/Desktop/harness/notes/decisions.md).

## Design decisions

Question: Which important design choices did you make, what alternatives did
you consider, and what tradeoffs did you accept?

### Preserve saved tool contracts when adding tools

**Status:** Implemented on 2026-10-12. Astra caught the prompt mismatch during review before deployment; it was not a production incident.

**Question:** What compatibility issue did you encounter when expanding the agent's tool set, and how did you handle it?

I added `create_file`, which creates a new file and any missing parent folders without overwriting an existing path, and `delete_file`, which removes one regular file. Deletion requires a complete read on an earlier model call in the same task, and the file's SHA-256 must still match. Reusing read evidence avoided adding a separate deletion-authorization mechanism.

The compatibility issue was preserving the tool contract for saved conversations. New conversations use six tools; existing conversations keep their saved tool descriptors, and forks inherit the selected conversation's configuration. Saved system messages remain in effect. During review, Astra caught a draft bug for an older four-tool conversation at its empty baseline: with no saved system message, it would get a new prompt that described tools it could not call. The fix keeps the legacy prompt for conversations without both new tools and uses the expanded prompt only when both are available.

Focused checks covered old and new tool contracts, including baseline resume, fork and rewind behavior. In one live Qwen smoke test, the agent created a file in a missing folder, corrected its syntax after `npm test` failed, deleted the file, then restored and forked saved states. A stale edit was also rejected until the agent reread the file. These are observations from one smoke test, not a broad quality evaluation; no benchmark or power-loss test was run.

Deletion is limited to regular UTF-8 files that `read_file` can expose completely; directories and symbolic links cannot be deleted. A failed creation can leave new parent folders. Dependency installation remains manual, and command permissions were not widened.

**Sources:** [main.ts (`selectTools`, `openConversation`, `owner`)](/Users/rohilverma/Desktop/harness/ts/main.ts:49), [prompts.ts](/Users/rohilverma/Desktop/harness/ts/src/prompts.ts:1), [createFile.ts](/Users/rohilverma/Desktop/harness/ts/src/tools/createFile.ts:6), [deleteFile.ts](/Users/rohilverma/Desktop/harness/ts/src/tools/deleteFile.ts:8), [readFile.ts](/Users/rohilverma/Desktop/harness/ts/src/tools/readFile.ts:7), [decisions.md](/Users/rohilverma/Desktop/harness/notes/decisions.md:1256).

## Testing

Question: How did you verify correctness, reproduce failures, and distinguish
harness bugs from model behavior?

To prepare.

## Performance

Question: What work does prefix reuse avoid, and what performance have you
actually measured?

To prepare. Do not turn reduced token evaluation into an unmeasured speedup claim.

## Scale

Question: What would change with larger repositories, longer conversations,
or multiple concurrent users?

To prepare. Distinguish current capabilities from possible future designs.

## Limitations

Question: What are the current limits, remaining validation gaps, and features
you intentionally deferred?

To prepare.

## Mistakes and debugging

### 1. Harness: editing with stale line numbers

Status: Accepted narrative; hypothetical failure scenario. The file-version
guard is implemented, but this wrong-line incident is not established by the
project records. The fingerprint check and write are not atomic.

My harness has a `read_file` tool that returns numbered lines and an `edit_file` tool that accepts `start_line`, `end_line`, and `newText`.

The failure scenario involved an edit targeting outdated line numbers. The model read a file and selected line 10, but another edit inserted a blank line above it. The intended content moved to line 11 while the pending request still targeted line 10. As a result, the edit was applied to the wrong line, potentially overwriting unrelated content, leaving the intended text unchanged, or producing a malformed file.

To debug it, I compared the requested range with the file contents before and after the intervening change. The replacement text was correct; the location was stale. Validating that the requested lines existed would not catch that problem.

The protection lives in the tools themselves. When `read_file` reads the file, it computes a SHA-256 fingerprint and stores it in `context.readRanges`, alongside the returned line ranges and model turn.

Before editing, `edit_file` reads the current contents and computes the fingerprint again:

```ts
if (coverage.version !== createHash("sha256").update(text).digest("hex")) {
  throw new Error(
    "The file changed since it was read. Read the target content again."
  );
}
```

This check happens before `writeFile`. A mismatch becomes an `{ ok: false, error: ... }` tool result, leaving the file untouched.

The Agent puts that result into conversation memory with the original `toolCallId`. The model can then reread the file and submit an updated range. The edit attempt consumes the previous read record, so it cannot simply retry using the old evidence.

To verify the behavior, I would read a fixture, insert a blank line above the target, and attempt the original edit. It should be rejected. A fresh read followed by an updated edit should succeed.

Code: [readFile.ts](/Users/rohilverma/Desktop/harness/ts/src/tools/readFile.ts:70),
[editFile.ts](/Users/rohilverma/Desktop/harness/ts/src/tools/editFile.ts:86),
and [Agent](/Users/rohilverma/Desktop/harness/ts/agent.ts:95).

### 2. LLM: requesting edits without inspecting the target

Status: Accepted narrative. Read-before-edit behavior and recovery are recorded
in the project notes. Referenced checks are historical; the saved suites were removed.

My harness uses a local LLM to choose tools and supply their arguments. One problem was that the model did not consistently follow the instruction to read a file before editing it.

That instruction appeared in the prompt, but the model could still request an edit without first inspecting the target content. A valid-looking request could therefore contain unsupported line numbers or a replacement based on assumptions about the file.

To investigate, I examined the sequence of tool calls. The important question was whether a successful `read_file` call had returned the target lines before the model requested `edit_file`. Search excerpts alone were not sufficient.

The mistake was relying on a prompt instruction to enforce a prerequisite that the harness could check directly.

The resolution was to record successful reads in `context.readRanges`. Each record contains the file fingerprint, the returned line ranges, and the model turn. Before allowing an edit, the harness checks that earlier reads cover every target line:

```ts
const ranges = coverage.ranges
  .filter((range) => range.turn < context.turn)
  .sort((a, b) => a.start - b.start);
```

The earlier-turn requirement matters: reading and editing in the same batch of requested tools does not give the model an opportunity to inspect the read result.

If coverage is missing or incomplete, the edit returns an error without writing. The Agent sends that result back to the model, allowing it to read the necessary lines and request the edit again.

The recorded checks covered missing or same-turn read evidence. A live smoke test also demonstrated recovery: an edit was rejected after a command invalidated the earlier read record, and the model reread the file, retried, and verified the restoration.

The lesson was that instructions guide model behavior, while important editing prerequisites need explicit enforcement in code.

Evidence: [notes/decisions.md](/Users/rohilverma/Desktop/harness/notes/decisions.md:23).
Code: [editFile.ts](/Users/rohilverma/Desktop/harness/ts/src/tools/editFile.ts)
and [Agent](/Users/rohilverma/Desktop/harness/ts/agent.ts).

## Architecture

Prepare this after the other topics.

Question: How do TypeScript, the C++ sidecar, llama.cpp, conversation memory,
and tools connect, and why does each layer own its responsibilities?

To prepare.
