# Tool decisions and lessons

Updated: 2026-10-03.

This records the problems, choices, and trade-offs behind the four tools. The code walkthrough is in [tools.md](tools.md). Open items at the end are not implemented decisions.

## 1. Read the full file, then return a bounded page

**Problem:** Reading incrementally, byte by byte or in streamed chunks, requires additional handling for byte offsets, UTF-8 characters split across chunks, and line boundaries.

**Decision:** Use the simpler approach: read the entire file as UTF-8, split it into lines, select the requested range, and remove whole lines from the returned page until it fits within 4 KiB. Return at most 100 lines and provide next_line for continuation.

**Reason and trade-off:** This keeps line numbering and pagination consistent and avoids returning a character cut in the middle of its UTF-8 encoding. The response cap includes the displayed line numbers. It bounds what reaches the model, not how much data is read into memory. Very large files still require a full read, and a single line exceeding the response cap produces an error.

## 2. Replace line ranges instead of requiring exact old-text copies

**Problem:** The old editor required the model to supply oldText matching the file exactly. In the poodle-to-husky task, the model inserted an extra blank line into oldText, causing repeated "oldText was not found" errors even though it had identified the correct file.

**Decision:** Address edits with path, start_line, end_line, and newText. Line numbers are 1-based and inclusive. Replace the selected whole lines while preserving the surrounding content.

**Reason and trade-off:** The model generates the replacement without reproducing the old passage character for character. One call can replace several contiguous lines; this does not require a separate call for every line. When appropriate, the tool supplies a missing trailing newline using the original range's newline style. The model must still choose the correct range, and line numbers become unreliable when the file changes.

## 3. Enforce read-before-edit in the harness

**Problem:** Prompt instructions alone did not ensure the model read the file before editing. Line-based edits also need protection against stale file contents and unread target lines.

**Decision:** read_file records the returned line ranges, their model turns, and a SHA-256 fingerprint of the full file. edit_file requires coverage of every target line from an earlier turn and checks that the file fingerprint still matches. It consumes the read record when checking an edit attempt.

**Reason and trade-off:** These checks enforce a concrete prerequisite for editing. Search excerpts do not count as a read, and reading and editing in the same model turn does not satisfy the guard. The extra bookkeeping also means a failed edit may require another read.

A run_command attempt clears all read records because a project command could modify files. This also happens for read-only commands and rejected requests. In the smoke test, restoration was initially rejected after tsc; the agent reread the file, retried the edit, and verified successful restoration.

## 4. Keep search literal and make suggestions explicit

**Problem:** Literal text search can miss spelling errors and word variants. An empty search does not necessarily mean no relevant article exists.

**Decision:** Use case-insensitive literal ripgrep searches with nearby context. A complete empty search for an eligible ASCII identifier can trigger a bounded pass for words within one insertion, deletion, replacement, or adjacent-character swap. Return those as suggestions.

**Reason and trade-off:** Literal matches remain predictable, and suggestions give the model another term and location to inspect. This is not semantic search or stemming: variants such as husky and huskies may still require separate queries. The model must assess suggestions and respect limited results before drawing conclusions.

## 5. Run controlled local commands and defer isolation to a container

**Problem:** The agent needs builds, tests, linters, and inspection commands, but unrestricted command execution can change files, install packages, access the network, or modify the environment.

**Decision:** Use an allowlist of commands, subcommands, and development-script names. Pass executable and arguments directly to spawn with shell disabled. Validate the working directory and explicit path candidates, including resolved symlinks. Bound execution to 60 seconds and capture at most 8 KiB each of stdout and stderr.

**Reason and trade-off:** This rejects obvious unsafe requests and avoids shell interpretation at the runner boundary. It also limits waiting and captured output. Allowed programs and npm scripts remain trusted code: they can write files or perform other actions with host process permissions. A workspace cwd is not filesystem confinement.

Keep local process handling in runProcess so a future container implementation can replace it. Native macOS sandboxing, a full security sandbox, and an approval UI are outside the current implementation.

## 6. Log tool arguments and verify outcomes

**Problem:** Result-only logs showed that an edit failed but hid the oldText responsible for the mismatch. A model's final response or Conclusion: success also cannot establish that a requested action happened.

**Decision:** Log the turn, tool name, raw argument JSON, and returned result. Read files after edits to verify the actual contents. Evaluate command completion using its structured status and exit code.

**Reason and trade-off:** Raw JSON exposes whitespace differences through escaped newlines. A successful TypeScript check can legitimately return empty stdout and stderr with exit code 0. Logs make diagnosis easier, but large arguments and results make terminal output longer.

The four-tool smoke test demonstrated search, reading, a temporary heading edit, a real TypeScript check, recovery from a read-before-edit rejection, and verified restoration. It did not test command timeout or output-cap behavior.

## Open items to revisit

- **New-file creation:** edit_file currently requires an existing file. run_command can create build outputs indirectly, but no dedicated tool accepts a new path and generated content.
- **Test instructions:** Keep smoke tests aligned with the current line-range editor and require a fresh read after run_command. The earlier smoke-test prompt still referred to oldText.
- **Turn-limit message:** The loop currently allows 20 model calls, but its exhaustion error still says six. The message and configured limit need to agree.

## 2026-10-05: Visual explanations must make the flow easier to follow

The first save/resume page was too dense, and generating a file did not ensure
the user could read it beside the chat. The retry uses one concrete conversation
and one changing diagram, with code details optional. Verify the visible page
and its step controls before presenting it.

The user requested GPT-6.1 Sol LIGHT for the visual subagent. This retry used
`gpt-6.1-sol` with `low` reasoning, the available setting. The corresponding
AGENTS.md instruction was explicitly approved and applied on 2026-10-05.

## 2026-10-05 — Project memory and interview review

**Decision:** Continue recording factual project decisions and lessons here under
the existing automatic-update authorization. Route interview candidates to the
dedicated review chat; save interview wording in notes/STORIES.md only after
direct user approval of the exact document change.

**Rationale:** Project memory should remain current while interview narratives
are reviewed separately. Hypothetical interview incidents must not become
assertions about observed project history.

**Status:** The user approved the workflow, AGENTS.md was updated, and
notes/STORIES.md was created with the two accepted stories and remaining topics.
The stale-line incident is labeled hypothetical; its protection is implemented.

## 2026-10-05 — Local provider cleanup scope

**Context and decision:** The user requested removal of OpenRouter/third-party
and Ollama integration, and explicitly confirmed keeping both llama-server and
the C++ sidecar. Preserve the local-provider comparison baseline.

**Rationale:** The former ts/src/providers/thirdparty.ts also served llama-server.
Preserve that adapter in ts/src/providers/llama.ts; the OpenAI SDK remains
necessary for its compatible API.

**Status:** The user approved the exact diff, which was applied without changes.
OpenRouter/OpenCode selection, configurable keys/headers, Ollama's provider,
dependency, compiler mapping, and lock entries were removed. Typecheck and
in-memory main bundling passed. Provider checks confirmed cached llama connections,
fresh sidecars, rejection of removed providers, and matching dependency files.
These checks did not run live inference. The first in-memory checker passed an
undefined filename to Node's loader and aborted; supplying an explicit filename
corrected the checker, and the rerun passed without changing harness code.

## 2026-10-05 — Redundant command-symbol rejection

**Observation:** run_command rejected a literal semicolon search in c/src/main.cpp
even though runProcess starts commands with shell disabled. This was deliberately
reproduced during review, rather than observed in a live model task.

**Decision:** The user approved removing the shell-symbol filter, flattening the
llama-provider cache to one map, and deleting the unused Agent.systemPrompt,
contextWindow, ToolConfiguration, and ReadFileArgs declarations. The guide's stale
contextWindow sentence was removed too. The exact approved diff was applied:
42 net lines removed, with no new helper, dependency, or abstraction.

**Rationale and validation:** A no-shell process already treats symbols as literal
arguments; the extra filter blocked valid searches. Typecheck, in-memory main
bundling, and whitespace checks passed after implementation. Actual-source checks
confirmed the semicolon search succeeds, llama connections remain cached by
address, sidecars remain fresh per conversation, and removed providers, Git
workspace overrides, and paths outside the workspace remain rejected. No live
inference was run and no saved regression suite was recreated.

**Interview review:** The user authorized reopening the existing review chat,
and the candidate was sent there. The implementation/validation status was sent
as a follow-up; this records a deliberate reproduction, not a live-model incident.

## 2026-10-05 — Clarify provider, process, and engine routing

**Assistant correction:** `llama` and `sidecar` are alternative provider routes.
In current code, `MODEL_PROVIDER` defaults to `llama`, which uses HTTP through
OpenAIServer to a llama-server process. `sidecar` starts harness-sidecar, whose
C++ code calls llama.cpp. The assistant's earlier explanation did not clearly
distinguish the selected route from the inference engine.

**Lesson:** Explain the full route and name the default. Every request in
sidecar mode goes through the sidecar; the current default does not select it.

**Resolved on 2026-10-05:** The user chose to remove llama-server configuration
and route all model generation through the sidecar. The proposal directly creates
SidecarProvider in main and passes it to Agent; the HTTP adapter, registry,
launcher, SDK dependency, and unused request model identifier would be removed.
The in-memory proposal passed typecheck and entrypoint bundling. Live inference
was not run at proposal time; implementation still required approval of the exact diff.
An architecture candidate was sent to the authorized interview review chat,
with the implementation and validation limits stated explicitly.

**Implementation status (2026-10-05):** The user approved the exact removal and
cleanup. All 17 file changes were applied exactly as proposed after confirming
the affected files had not changed. Actual-source TypeScript typecheck,
in-memory entrypoint bundling, dependency consistency, and whitespace checks
passed. Source search confirmed the removed provider selection, HTTP address,
registry, and OpenAIServer no longer appear in runtime TypeScript. No live
inference was run for this cleanup. The direct ownership reduced configuration
and removed a registry without adding an abstraction; no extra complexity was
identified in retrospect.

**Follow-up correction (2026-10-05):** The `MODEL_PROVIDER=llama` description
above records the pre-cleanup state only. Current `ts/main.ts` directly creates
`SidecarProvider`; all application model generations use the sidecar process,
which calls the llama.cpp library. There is no current HTTP/llama-server route.
Treat reports that say otherwise as stale and verify against the checked-out
source. The earlier two-provider validation is historical evidence, not the
current runtime architecture.

## 2026-10-05 — Design skills for implementation walkthroughs

**Context and decision:** Before continuing Part 3 save/resume design, the user
requested frontend skills because the implementation graphs need clearer visual
design. Installed frontend-design from anthropics/skills, web-design-guidelines
from vercel-labs/agent-skills, and visual-explainer from nicobailon/visual-explainer
in /Users/rohilverma/.codex/skills.

**Rationale:** Use frontend-design for typography and layout, visual-explainer
for diagrams and interactive flows, and web-design-guidelines for usability
review. Continue following the project's one-step walkthrough, Back/Next,
optional code, concrete source references, and verified inline delivery rules.
Project requirements and the existing visualization delivery contract take
precedence over a skill's default styling or standalone-page format.

**Validation and status:** Installed reviewed revisions 683bc88e56f3e09ba94f7055977f3d3aa499f202
(frontend-design), 063bee94c3f4df8453406c830b0a7df0f2860278 (web-design-guidelines),
and 5846f5aef34a23c8fea389d2f23ce56224cbf840 (visual-explainer). Installed SKILL.md
contents match the inspected upstream versions; the diagram references and page
template are present. Installation success does not establish improved visual
quality; evaluate that in the next rendered walkthrough. Part 3 implementation
remains unapproved.

## 2026-10-05 — Part 3 save/resume explanation

**Direction and current state:** The user asked to move to Part 3 persistence.
Current code retains ConversationMemory in TypeScript and context/evaluated
tokens in C++ only while running; the protocol still has just ping and generate.
The pinned llama.cpp provides native state_save_file/state_load_file functions.
Inspection confirmed the native file stores the supplied token IDs alongside
context state, so a separate duplicate token list is unnecessary.

**Proposed design, not approved implementation:** At an idle task boundary,
write and sync a uniquely named native state binary, then atomically publish a
versioned conversation JSON manifest referring to that binary and its checksum.
Preserve messages and tool-call/result IDs. Validate model/runtime/context and
saved-pair compatibility before loading; attach message history only after native
load succeeds. Clear native state and evaluated tokens after a partial load failure.
The next generation still uses the existing full-prompt prefix comparison and
fresh sampler. Tool history is restored without replaying tool actions; workspace
rollback and mid-generation continuation are outside this proposal. Exact code,
manifest fields, and runner commands still need an approved diff.

**Presentation and verification:** The walkthrough was delegated to gpt-6.1-sol
with low reasoning and reviewed against the frontend and web-design skills.
Actual side-panel inspection exposed a preview viewport wider than the visible
pane; a compact maximum diagram width corrected the cropped C++ owner. Captions
precede the drawing, essential labels use foreground text, and proposed files
are labeled explicitly. Back/Next, Show code, keyboard navigation, updated step
descriptions, and narrow diagram bounds were checked in the browser. No native
persistence implementation or save/restore correctness test was run.

## 2026-10-05 — Gate interview candidates on advanced work

**Correction:** The interview-routing rule was broad enough to produce a
candidate from the unimplemented save/resume proposal. That proposal was marked
hypothetical and had no approved implementation.

**Decision:** Draft candidates only after a project decision has been adopted
and acted on, or a code change has user approval. Keep implementation and
validation claims pending until those outcomes exist. AGENTS.md wording awaits
approval of the exact proposed change.

## 2026-10-05 — Clarify snapshot publication and future history

**Clarification of the pending Part 3 proposal:** ConversationMemory appends
messages in RAM; the proposed disk save serializes the complete message list,
rather than introducing an append-only event log. Publishing means atomically
replacing the conversation manifest after its new native binary is durable.
Until replacement, the old manifest still selects the previous saved pair;
"current" here means the saved resume point, not the latest live conversation.
A failed native load clears the live inference cache and evaluated-token list
and reports failure; it does not erase the saved files or unload model weights.

**Open scope:** A session is one continuing conversation, a snapshot captures
one point, and a checkpoint is a snapshot retained as a return point. Message
prefixes can underpin future rewind and independent forks, but retention policy,
branch metadata, session layout, and workspace restoration remain undecided.
The latest-resume proposal does not itself implement a checkpoint timeline.
No runtime code was changed and no persistence validation was run.

## 2026-10-06 — Completed-task checkpoints and append-log direction

**User decision:** Retain a checkpoint after a user task has completed its
model/tool loop successfully. A single llama.cpp generation finishing is not
the checkpoint boundary. In current code, Agent.run can return success, length,
or error; the proposed save gate uses success with all requested tool results
settled. This records the harness's completion outcome, not independent proof
that a coding task achieved its intended result.

**Revised recommendation, implementation pending:** The user favors append-only
conversation history. Recommend one history.jsonl per conversation containing
initial version/configuration metadata, Message records, and checkpoint commit
records selecting a message prefix and uniquely named native state binary.
Append new messages at completed-task save boundaries; write and sync the binary
before appending and syncing its checkpoint record. Ignore an uncommitted crash
tail and remove that tail before the next append. Record/schema details, transcript
integrity checks, disk retention limits, and exact implementation remain open.
This supersedes the earlier latest-only full-JSON manifest recommendation.

**Assistant correction:** Requiring native load success before restoring valid
messages ties conversation recovery too tightly to a replaceable inference cache.
Recommend retaining the same verified conversation checkpoint if native loading
fails, clearing partly loaded cache/token bookkeeping, and letting the next normal
generation prefill from the saved messages. Do not delete the checkpoint or
silently step back because its binary is corrupt or incompatible. Earlier-history
fallback concerns invalid conversation data, not merely cache failure. Recomputing
the prompt does not rerun saved tool actions or regenerate saved assistant replies.

**Status:** Design discussion and visual explanation only; no runtime code or
native persistence tests. Fork/rewind can later select a transcript prefix and
restore or rebuild inference state; branch layout and workspace restoration are
still separate designs.

**Walkthrough check:** The revised checkpoint-log explanation was created by
gpt-6.1-sol with low reasoning. Its first view, Back/Next, optional code, keyboard
navigation, final-step disabling, and all diagram labels at 320px were checked
in the app browser. No browser console errors were reported. These are checks
of the explanation, not evidence that native save/load or log recovery works.

## 2026-10-06 — Astra review of checkpoint proposal

**Read-only review:** At the user's request, gpt-6-astra independently inspected
the proposal and relevant TypeScript/C++ sources. It found the log-authoritative,
optional-native-cache direction coherent. No persistence code or tests were run.

**Pending design details:** Bind a stable conversation/checkpoint identity and
exact message prefix to a transcript/configuration digest, independently of the
binary checksum. Cache compatibility needs the actual GGUF content fingerprint,
pinned runtime/state version, and effective context settings; native architecture
checks alone do not identify model weights. Define single-writer operation,
validated commit/tail handling and new-directory durability. Permit a transcript-only
checkpoint if cache saving fails, and report transcript commit failure explicitly.
These are review recommendations, not approval of a schema or implementation.

**Completion correction and continuity:** Earlier explanations called success
"model-declared." SidecarProvider actually derives success from an EOG response
without parsed tool calls, and Agent accepts that finished response; there is no
semantic task-success verifier. A later successful save must preserve all messages
since the previous committed prefix, including intervening length/error attempts
and tool failures. A crash before that save can lose those messages while tool
changes remain. A printed answer and a durably saved checkpoint are distinct outcomes.

**Native state findings:** Save the actual evaluated-token vector, which need not
equal the full rendered transcript. Keep the existing prefix comparison after load.
Source inspection supports clearing memory plus evaluated tokens after partial load
for the pinned Qwen/KV path; intentionally truncated-load recovery still needs testing.
Full native files duplicate cached prefixes; binary size/save latency have not been
measured, and keeping every transcript checkpoint need not mean keeping every binary.

**Fork/rewind scope:** Stable checkpoint IDs and immutable committed prefixes are
needed now. Branch layout, parent-history copying/references, arbitrary-message rewind,
cache pruning automation and workspace restoration can wait. Appending divergent
continuation after an older checkpoint must not masquerade as a continuation of the
newest linear history. No implementation approval was inferred from this review.

## 2026-10-06 — User acceptance and remaining checkpoint questions

**Accepted design requirements:** Check actual model-content identity, llama.cpp
version/state compatibility and effective context settings before native reuse;
restore messages and rebuild on mismatch. Keep conversation checkpoints usable
when cache saving or loading fails. Distinguish a finished Agent response from a
durably saved checkpoint, without claiming semantic task verification. These
design agreements do not authorize runtime edits or finalize the record schema.

**Open discussion:** The user requested explanations of committed messages and
transcript checksums, preservation of failed attempts, and eventual binary retention.
Committed messages mean the ordered history selected by a completed checkpoint
record. Checksums concern stored-history integrity, separately from compatibility
with newly chosen model settings. The continuity rationale for failed attempts is
to restore the same history used live: current Agent retains them, and later prompts
can depend on them. Deliberately forgetting attempts would need an explicit policy
for both live and saved history; no such policy is settled. Old native binaries can
be removed while preserving checkpoint message prefixes, at the cost of recomputing
those caches. No checksum scope, history-dropping rule or binary-pruning policy has
been accepted or implemented.

## 2026-10-06 — Saved-message terminology and checkpoint storage estimate

**User decision:** Preserve failed-attempt messages as part of the live history
saved at the next successful checkpoint. Binary deletion/cleanup is outside the
current scope; the earlier retention example was not a requested pruning policy.

**Explanation correction:** Use "saved messages" in user discussion instead of
"committed messages." These are the existing Message records selected by a saved
checkpoint, not an additional message type. Checksum verification means calculating
a fingerprint from saved bytes and comparing it with the recorded fingerprint;
it does not run inference. Transcript-checksum scope remains a pending proposal.
No checkpoint/log implementation has been made in this discussion.

**Calculated estimate, not measured file size:** The documented Qwen3-4B-Instruct-2507
model's official configuration has 36 layers, 8 KV heads and head dimension 128
(https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/blob/main/config.json).
Current Inference uses default F16 K/V storage and n_ctx=16384. The pinned KV state
writer saves occupied cells rather than the full allocated empty capacity. Its
dominant payload estimate is 2 * 36 * 8 * 128 * 2 = 147456 bytes (144 KiB) per
cached token: 1000 tokens ≈140.625 MiB, 4000 ≈562.5 MiB, 8000 ≈1.099 GiB,
and 16384 ≈2.25 GiB, plus token IDs/metadata. Model weights are not copied into
each binary; Q4_K_M weight quantization does not change the default F16 cache.
The transcript log appends new text/records once and adds small checkpoint records;
its size depends on actual message/tool-output bytes. Full native snapshots repeat
prior cache data, so sizes add across checkpoints.

**Evidence limit:** No configured LLAMA_MODEL_PATH or saved native checkpoint was
available for measurement. Estimates combine official model metadata and current
source; verify against the actual GGUF and written file after approved implementation.

## 2026-10-06 — Research into cache size and configuration

**Verified source support:** The pinned llama.cpp revision supports independent
K/V cache datatypes through context parameters. Our constructor currently keeps
F16 defaults. Quantized V requires Flash Attention; source contains Metal support,
but this model/device combination has not been exercised. Native state saves the
cache's tensor representation and rejects incompatible datatypes on load.

**Calculated trade-off:** For the documented Qwen configuration and 4000 occupied
tokens, estimated KV payloads are F16/F16 562.5 MiB, Q8_0/Q8_0 298.828 MiB, and
Q4_0/Q4_0 158.203 MiB. These include quantization-block scales but exclude small
state metadata; they are not measured files. Quantization reduces live cache
storage and saved payloads while changing numerical precision. Historical upstream
experiments favor trying Q8 before Q4; they do not establish this model's quality.
Reducing context capacity does not shrink a snapshot with the same occupied cells.

**Pending recommendation:** Evaluate Q8 K/V against F16 with the actual model,
including tool behavior, inference timing and save/restore behavior once available.
Lossless Zstandard compression could reduce disk usage without changing cache
numbers; its ratio and save/load cost need measurement. Existing native saving
writes full occupied snapshots; custom deltas would require base-snapshot tracking
and reconstruction. No runtime change, compression dependency, delta format or
binary-cleanup policy has been approved or implemented.

Sources: pinned llama-context.cpp and llama-kv-cache.cpp; ggml-common.h block
layouts at https://github.com/ggml-org/llama.cpp/tree/7fe450e19305b828c199d602c23a8337aaa1f03b;
historical quality experiments https://github.com/ggml-org/llama.cpp/pull/7412;
lossless codec https://github.com/facebook/zstd.

## 2026-10-06 — Proportional checksum explanation and learning prerequisite

**Explanation correction:** The earlier false-to-true tool-result example was
illustrative, not evidence of a likely local failure. No corruption probability
has been measured for this setup. A transcript fingerprint detects changes after
recording; it cannot detect incorrect messages that were already wrong when hashed.
Keep checksum scope open and distinguish this small integrity check from interrupted
write handling, correct checkpoint/cache pairing and model compatibility.

**Current discussion:** The user requested foundational resources before choosing
cache quantization. Q8 remains a proposed experiment, not a settled setting.
Use the official Hugging Face quantization concept guide, cache explanation and
KV-cache quantization article for concepts; their Transformers examples are not
instructions to replace or modify the C++ sidecar.

## 2026-10-06 — Cache choice is a prerequisite for finalizing Part 3

**User direction:** Settle the cache precision/storage choice before finalizing
the Part 3 implementation. The user supports the other design directions discussed;
this is design feedback, not approval of an exact runtime diff or every open schema
detail. Q8 remains a candidate, not an accepted default. Establish the numerical
precision trade-off and relevant model/device evidence before choosing the setting.
Binary deletion/cleanup remains outside scope. No implementation was authorized
or performed by this agreement.

## 2026-10-07 — Token-only checkpoints versus computed cache snapshots

**Learning distinction:** Tokenization maps rendered text to token IDs;
llama_decode evaluates those IDs and populates the context-dependent KV cache.
Saving IDs alone preserves an input sequence, not the costly evaluated state.
On restart, those IDs need evaluation before they can count as a reusable cached
prefix. In the pinned API, llama_token is int32_t: 4000 raw IDs occupy 16000 bytes
(15.625 KiB), separately from messages/metadata and the much larger KV payload.

**Checkpoint meaning:** A completed-task checkpoint includes system/tool definitions,
user messages, saved assistant replies and tool-call/results through that task.
Rebuilding evaluates saved history; it does not regenerate replies or rerun tools.
Current renderQwen formats the whole history and Inference tokenizes that text;
independently tokenized message fragments must not be assumed interchangeable with
the exact full rendered sequence. Message history already permits reconstruction,
so separately persisted token IDs are optional and tied to tokenizer compatibility.

**Open storage idea:** The user explored rebuilding incrementally from saved prompt
pieces. Token IDs would be small but still require model evaluation. Saving computed
KV deltas could avoid repeated on-disk prefixes, but later chunks depend on the exact
earlier context/positions and require a valid base chain. Our proposed native
llama_state_save_file path writes full occupied state plus supplied token IDs;
an incremental KV format is additional work, not an implemented or chosen feature.
No runtime edits or change to the agreed Part 3 scope were authorized.

## 2026-10-07 — Choose cache recomputation for Part 3 persistence

**User decision:** Proceed with saving conversation inputs and rebuilding the
calculated inference cache on resume, rather than making full native cache
snapshots the Part 3 persistence strategy. Saved replies and tool results are
restored as inputs; they are not regenerated or executed again. This supersedes
the original native-snapshot direction for the initial implementation plan.

**Rationale and evidence limits:** The user accepts the restore-time computation
trade-off. With complete history and matching model/settings, recomputation is
not expected to systematically reduce quality; numerical differences can change
future generated output. Restart latency and persistence round-trip quality have
not been measured. Existing Phase 2 prefix checks are historical evidence, not
tests of an implemented restore path.

**Still open:** Persisting numeric token IDs in addition to messages remains
unsettled. The messages-only recommendation would reuse existing prompt rendering,
tokenization and prefill; persisted IDs would skip tokenization but still require
model evaluation and compatible tokenizer/format handling. Live cache precision
is a separate choice; Q8 has not been accepted. The user requested an implementation
outline with an Astra critique, not runtime edits or approval of a file diff.

## 2026-10-07 — Astra corrections to the recomputation implementation outline

**Planning correction:** The initial recovery outline would truncate everything
after the latest valid checkpoint. Astra identified that a damaged complete
checkpoint can be indistinguishable from an interrupted append, so that rule
could silently discard an earlier saved checkpoint. The revised proposal recovers
incomplete terminal writes and valid unpublished message tails, but reports
ambiguous malformed complete records or invalid checkpoint digests. A complete
newline-terminated marker recovered after restart does not prove a prior sync or
user-visible acknowledgment occurred. Exact recovery rules remain subject to the
implementation proposal and approval.

**Source-backed lessons:** Preserve raw length-limited output and malformed tool
arguments retained by the existing Agent; persistence validation must not impose
stricter historical turn/pairing rules. ConversationMemory.messages() copies the
array but shares Message objects, so saved-prefix evidence must be immutable bytes
or a digest/count rather than retained mutable Message references. Reopening must
not generate an unsolicited response: the first new task invokes existing rendering
and prefill. No runtime changes or persistence checks were performed by this review.

## 2026-10-08 — Astra review of separate conversation and token logs

**Verified feasibility issue:** An append-only token log cannot assume that adding
a turn only appends IDs. A read-only in-memory probe of current renderQwen showed
that an ordinary final assistant reply receives an empty think block at a completed
checkpoint; adding the next user message removes that block from the same reply.
Tool-result grouping, argument formatting and generation headers also affect the
full rendered input. This probe checked text rendering, not tokenizer or inference
output. Raw-message tokens, request-prompt IDs, actually evaluated IDs and IDs of
re-rendered checkpoint history are distinct sequences.

**Assistant correction:** Persisted IDs skip tokenization when evaluating that
exact saved sequence, but do not automatically skip tokenization for the next new
task. Current generation tokenizes the entire newly rendered prompt for comparison.
The earlier explanation overstated this optimization. Correct suffix replacement
or stable tokenization partitions would require additional demonstrated logic;
tokenization and restore timings remain unmeasured.

**Review outcome, still a proposal:** Two logs are feasible with exact sequence
definitions and checkpoint pairing. Complete token vectors per checkpoint are
simpler than dependent delta chains; messages should remain recoverable if derived
token data fails. Recompute preserves input information but batching/backend and
sampling can change future output; no restart-quality measurements exist. The user
has not selected a token-log format or approved runtime changes. No live inference,
builds or saved regression suites were run or created for this review.

## 2026-10-08 — Accept messages-only persistence; explore background preparation

**User decision:** Accept the initial Part 3 proposal to save conversation messages
and configuration in one checkpointed history log, recreate IDs through the
existing renderer/tokenizer, and rebuild live inference state. A separate token
log and native computed-state snapshots are not part of this initial proposal.
Design acceptance does not approve runtime file changes.

**New open direction:** The user asked whether tokenization and prefill could run
in the background while a future rewind/fork is being prepared. This is feasible
after the selected history and model/context are ready, without generating replies
or executing tools. The current sidecar exposes only ping/generate and one pending
request; preparation without generation needs its own approved implementation.
An early new task must wait for preparation or follow a separately designed
interruption policy. Newly rendered input can alter the warmed suffix, so exact
prefix comparison remains necessary. No background preparation, rewind/fork,
concurrency behavior or change to initial resume timing has been implemented or
approved by this discussion.

## 2026-10-08 — Lock in background cache preparation after restoration

**User decision:** Begin tokenization and prefill after a conversation checkpoint
has been selected, its saved history loaded, and the target model/context is ready.
Let that preparation overlap the remaining setup and the user's reading time,
rather than always waiting for the next prompt. Preparation must not sample an
assistant reply, append messages, or replay tools. The saved history/configuration
remains authoritative; computed cache stays in memory.

**Trade-offs:** This moves computation earlier without reducing its total cost.
It can reduce the wait perceived on the next task, but consumes compute/memory
sooner and may do unused work if the conversation is abandoned or the selected
history changes. An early prompt still waits for unfinished preparation. The next
fully rendered prompt must compare actual token IDs and replace any changed suffix;
warming is not a promise that the entire historical sequence remains reusable.
Numerical and sampling differences can still change future output. No timing or
restart-quality improvement has been measured.

**Implementation constraints and scope:** Add a preparation operation that evaluates
input without generation; current ping/generate cannot safely substitute for it.
Keep inference serialized within each context. A future fork needs its own context
so preparation cannot alter the parent's state. Automatic cancellation, concurrent
session scheduling and rewind/fork history controls remain separate designs.
The user requested a file-level implementation outline, Astra review, and use of
the two support chats; exact-diff approval still precedes runtime edits. Whether
the first increment includes background ordinary resume or actual rewind/fork
controls is being clarified; no file layout or runtime diff is approved yet.

## 2026-10-08 — Correct message validation in the persistence draft

**Assistant mistake and correction:** The scratch persistence draft checked saved
roles with `String(value.role)`, admitting JSON arrays such as `["user"]`. Astra
and independent validation identified that existing rendering compares literal
string roles and could omit that malformed message. The draft now requires the
original role to be a string before membership checking; scratch rejection checks
cover non-string roles. Validate stored types directly rather than coercing them.

**Review limit:** Independent scratch checks also demonstrated that overlapping
checkpoint calls can corrupt the draft log. The proposed interface explicitly
requires sequential checkpoint/close calls, matching the awaited CLI; it adds no
queue. These are reviewed draft corrections, not applied runtime changes or
approval of the persistence schema. Background preparation remains a separate
second increment, and actual rewind/fork controls remain outside the first scope.

## 2026-10-08 — Use Mermaid in chat for requested diagrams

**User preference:** When the user asks for a diagram, present a Mermaid system
diagram directly in chat, connecting the application flow to its code and clearly
distinguishing existing behavior from proposed changes. After the user approves,
save that diagram and explanation in the agreed project document. This preference
takes precedence over the earlier HTML walkthrough requirement for such requests.

**Outcome:** The user approved appending the application diagram to
`notes/HARNESS_GUIDE.md`; it is saved there with persistence/preparation still
marked proposed. The request to build the code does not waive the repository's
separate requirement to show and approve an exact runtime patch.

## 2026-10-09 — Implement messages-only checkpoint persistence (Stage 1)

**Outcome:** After the user requested a repeat Astra review and then coding,
applied the previously shown Stage 1 patch: new `ts/src/conversationStore.ts`
and runner wiring in `ts/main.ts`. Both files match the reviewed scratch draft
byte-for-byte; no additional runtime changes were included. New conversations
receive UUIDs; `--resume <UUID>` restores the latest validated checkpoint from
`sessions/<UUID>/history.jsonl`, using saved generation settings and requiring
matching canonical workspace/model paths and ordered tool descriptors.

**Durability and ownership:** Successful tasks append retained messages and a
checkpoint, then sync before reporting saved. Earlier unsuccessful attempts are
included at the next success. Immutable serialized-prefix evidence prevents
rewriting saved messages; digests validate saved header/message bytes on resume.
An exclusive writer file prevents competing cooperating processes, while the
runner separately keeps operations sequential. Ambiguous complete corruption
errors rather than silently falling back; incomplete/unpublished tails recover.
Save failure stops the runner; cleanup releases the store after provider shutdown.

**Validation:** Repository no-emit TypeScript checking, 19 scratch storage checks,
and 7 scratch runner checks passed against the applied files. These cover exact
history/raw-argument/tool-ID retention, integrity and tail recovery, ownership,
save-failure handling, and cleanup using scripted execution. Astra's repeat
read-only review found no new required correction. No live model inference,
restart-quality measurements, power-loss checks, or repository test suites were
run or added. Background preparation is a separate draft, not implemented by
Stage 1; rewind/fork controls remain outside this scope.

## 2026-10-09 — Locate the cached model and verify live save/resume

**Assistant correction:** I asked the user to locate the GGUF and suggested Finder
search before checking existing load logs. `sidecar.log` already recorded the
working Qwen model path under the hidden Hugging Face cache. The named `.gguf`
is a symlink to an extensionless blob; filename searches that do not follow
symlinks are insufficient evidence that the model is absent. Direct inspection
confirmed the existing file and GGUF header. Check prior configuration/logs and
resolve cached links before asking the user to repeat model-location work.

**Observed validation:** In `/private/tmp/harness-manual-test-qZDgc1`, the current
runner loaded Qwen3-4B-Instruct-2507 Q4_K_M, read `sample.txt`, answered `cobalt`,
saved checkpoint `9963eb6e-13df-47c9-936f-bd950b9339d7:5`, and exited normally.
A fresh process resumed it, answered `cobalt` without new tool calls, saved
checkpoint `9963eb6e-13df-47c9-936f-bd950b9339d7:7`, and exited normally. Inspected
saved records retained the original messages and tool call/result; the fixture
was unchanged and the writer lock was removed. This is a live smoke check,
not a broad quality, latency, power-loss, or exact-output parity measurement.

**Environment and delivery:** The sandbox could read/load the model but failed
to initialize the Metal command queue; normal host access completed the checks.
The tsx CLI's local IPC socket was also denied in the sandbox; its existing Node
import loader ran without that socket. A scratch launcher and testing guide now
contain the verified paths. No repository runtime edits were needed; background
preparation remains an unapproved draft and rewind/fork remain unimplemented.

## 2026-10-09 — Correct the manual-testing workspace handoff

**Assistant mistake:** I kept the user's interactive launcher in `/private/tmp`
after preparing an isolated test fixture there. Scratch validation respected the
repository rule, but making that temporary, hard-to-find folder the default for
continued user conversations was a poor handoff. The current store writes to
`sessions` under its launch workspace, so these conversations are there because
of the launcher's working directory, not a persistence requirement.

**Correction and lesson:** Show the exact saved-file location and reveal it in
Finder. Use a clearly named, visible, persistent workspace for ongoing manual-use
handoffs; reserve temporary scratch folders for disposable checks. No files were
moved and the running conversation was not altered. Relocation must account for
the saved canonical workspace identity rather than assume a directory move alone
will preserve the current resume contract.

**Verified follow-up:** The user reported that Finder did not display the file
after the reveal command returned successfully. Command acceptance is not proof
of visible delivery. Created an integrity-checked readable snapshot at
`/Users/rohilverma/Desktop/Harness Conversation History.txt`, opened it in
TextEdit, and verified the document title, content, and three checkpoint IDs
through the app's accessibility state. The snapshot does not update live; the
active saved log was not moved or changed. Desktop export is outside the repository.

**Live-file correction:** The user rejected the static export because it did not
update with the active conversation. Created `/Users/rohilverma/Desktop/Harness
Live History.jsonl` as a hard link to the current session's actual log and verified
both paths have the same device/inode. Appends and recovery truncation affect the
same file; this is not another export or a synchronization job. Finder's UI showed
the named live file. This provides visible, persistent access to this conversation
without interrupting its writer or changing runtime code. It does not change the
launcher's default workspace for future conversations or migrate the saved
workspace identity. An open editor's refresh behavior is separate from disk updates.

**Default-location correction:** Subsequently created the permanent, visible
`/Users/rohilverma/Desktop/Harness Workspace` with a `Start Harness.command`
launcher. New conversations now use that workspace and its `sessions` directory.
The old scratch launch command forwards to it. Existing test conversation IDs
still select their original workspace on resume, preserving the current canonical
workspace check; their workspace identity was not migrated. Both launcher scripts
passed shell syntax checking. No repository runtime files changed, and this
launcher relocation was not subjected to another live model run.

## 2026-10-09 — Propose terminal checkpoint and branch controls

**Open UX proposal:** Use slash commands handled by the runner, separate from
model prompts: list/preview saved checkpoints, rewind, fork, list conversations,
and switch. Display checkpoint ordinals separately from cumulative message counts.
The proposed rewind creates an automatically named continuation from a saved
prefix and switches to it; fork creates a named conversation from that prefix
and switches to it. Both preserve the original later saved history and can share
one branch-creation implementation behind the store interface. This is a proposed
semantics choice awaiting user feedback, not a settled feature or file diff.

**Constraints:** Commands act between tasks. Restore saved replies/results without
replaying tools; conversation rewind does not undo workspace file/command effects.
One conversation is active per terminal; selecting a target creates its context
and starts the separately proposed background preparation. Early generation waits.
Latest-checkpoint resume/persistence already exist; these slash commands, older
checkpoint selection, branch creation, labels, and preparation remain unimplemented.
Mermaid was prepared by the existing GPT-6.1 Sol low visual agent; no runtime edits
or terminal-control validation occurred.

## 2026-10-09 — Accept the terminal checkpoint and branch UX

**User decision:** Accept the shown slash-command design. Checkpoint selection uses
ordinals separate from message counts; rewind creates an automatically named
continuation and switches to it, while fork creates a named conversation and
switches to it. Original later saved history remains available. Preview/list/switch
controls support navigation; restoring history does not replay tools or undo
workspace effects. The accepted Mermaid and accompanying explanation are appended
to `notes/HARNESS_GUIDE.md` under the user's diagram-saving convention.

**Approval limit and next work:** This accepts the UX, not an exact runtime diff.
The previously reviewed background-preparation patch remains unapplied. The two
authorized support chats are preparing a combined scratch proposal and independent
checks; the existing Astra reviewer is auditing the design. All runtime edits
still require showing the final exact diff and obtaining explicit approval.
Proposed implementation details such as child-local checkpoint numbering,
provenance/labels and an explicit guard for discarding unsaved failed attempts
remain part of that pending proposal, not already implemented behavior.

## 2026-10-09 — Review the combined terminal-control and preparation proposal

**Review correction:** Original preparation can fail while a branch is being
published. The draft preserves a durable child and prints its UUID even when the
transition cannot proceed; an existing switch target is not described as newly
created. This makes saved history discoverable after a failed transition.

**Evidence and status:** Astra reviewed the frozen six-file runtime proposal and
found no blocking issue. Independent focused draft checks passed, including the
publication/acquisition races and cleanup. Root verified draft TypeScript checking,
patch applicability, captured repository baselines, and unchanged provider/native
proposals from Stage 2. Diff SHA256 is
`8b3994f0b22114b410bed45fc5478b784ea64a25343a2491b93c32a653473a22`.
Runtime changes remain unapplied and require exact-diff approval. These checks
do not establish live inference parity, latency or physical power-loss durability.

**Presentation limit:** The dedicated GPT-6.1 Sol low agent produced the HTML
walkthrough, but browser policy rejected the local file URL. Browser rendering
and controls were not verified; the code-flow Mermaid is delivered in chat.

## 2026-10-09 — Apply and validate terminal branching and background preparation

**Approved action:** The user approved the exact combined six-file patch. Applied
runtime files match the frozen proposal byte-for-byte, with no source deviations
or new runtime modules. The native sidecar was rebuilt at the existing launcher's
path; preexisting unrelated changes were preserved.

**Observed validation:** Actual-project TypeScript checking and the cached native
build passed. Independent validation passed 13 focused checks against applied
source, including branch provenance, read-only inspection, exact unsaved-prefix
detection, preparation gating and failure-race cleanup. A fresh real-model terminal
workspace passed tool-read/checkpoint/preview, named fork, automatic rewind,
original-history preservation, named/root switching, early child input and
new-process child resume. Saved tools were not rerun; the fixture remained unchanged
and normal exits removed all writer locks.

**Native evidence:** Seven real-sidecar checks passed: prompt-only preparation and
repeat counts; prepared versus fresh greedy output/count comparisons for exact,
appended, shorter and divergent prompts; cache/bookkeeping reset after a preparation
capacity error; and rejection of sampling parameters on prepare. These short
fixtures establish limited parity evidence, not a broad quality or latency result.
Power-loss durability and forced native decode/removal failures remain untested.

**Result and scope:** Controls and eager preparation are implemented. One active
model context is retained per terminal; changing conversations still loads the
target model before background prefill starts. Original history and child history
are independent, and conversation changes do not undo workspace effects. Shared
parsing, local owner cleanup and private prefill reuse remain justified by these
requirements; no part currently calls for a pool, queue or session framework.
Existing running terminals must restart to load the new TypeScript controls.

## 2026-10-09 — Publish the terminal command reference

**Documentation action:** Under the user's documentation authorization, created
`c/SIDECAR_COMMANDS.md` with current launch/resume commands, checkpoint navigation,
fork/rewind/switch examples, unsaved-attempt handling, history locations and focused
diagnostics. Added the previously shown validation entry to `c/PHASE_2_PLAN.md`.

**Verification:** All six shell examples passed syntax checking, slash commands
matched the current runner, and the documented model-free ping returned ready.
The earlier manual conversation log and Desktop launcher exist. Runtime source
files remain byte-identical to the approved patch. The file-opening request was
queued by the app; visible editor delivery was not confirmed.

## 2026-10-10 — Request readable Markdown inside each session

**User correction:** Explaining Finder's collapsed folders did not address the
usability of raw JSONL logs. The user requested a Markdown file within session
directories created for new conversations, so history is directly readable.

**Pending implementation proposal:** Add one private Markdown writer to
`ts/src/conversationStore.ts`, creating `conversation.md` on new-session open,
refreshing it from immutable saved records after checkpoints, and regenerating
it on resume. Fork/rewind children use the same checkpoint path. Literal message
content and tool IDs/arguments are preserved; Markdown edits do not change model
history. A temporary file/rename preserves the previous view if replacement fails;
the warning does not invalidate a successfully saved JSONL checkpoint. Existing
running terminals would need restarting; older sessions gain the file on resume.

**Draft evidence and status:** Project noEmit overlay and six focused scratch
groups passed: initial file, UTF8/content/tool/fence rendering, checkpoint refresh,
fork/source preservation, committed-only resume regeneration and export-failure
recovery. Patch applicability passed and runtime source remains unchanged.
This proposal still requires exact-diff approval. Dedicated GPT-6.1 Sol low
produced the visual; browser rendering remains unverified because local-file
preview was previously blocked. No user session directory was changed.

## 2026-10-10 — Distinguish conversation controls from coding-workspace restoration

**User direction:** The next phase should support a coding-agent rewind that
reverses progress, beyond restoring conversation history. The user will first
exercise the implemented features and does not consider the present fork the
complete desired coding workflow.

**Verified current boundary:** `/rewind` and `/fork` both select a saved message
prefix through `ConversationStore.open`'s branch mode. They publish independent
conversation logs, switch the active owner and rebuild context. All conversations
still use the same startup workspace and tool roots: neither command restores
files nor creates an isolated coding workspace, and the terminal runs one active
agent at a time. Earlier conversation-control validation does not establish
workspace rollback or isolated-fork behavior.

**Open next-phase work:** Pair conversation checkpoints with recoverable workspace
state and define coding-fork isolation. Restoration scope for created/deleted
files, user edits and command effects, along with its implementation mechanism,
remains undecided and unapproved. The per-session Markdown proposal remains
pending exact-diff approval; this clarification changes no runtime source.

## 2026-10-10 — Apply per-session readable Markdown

**Approved implementation:** The user approved the previously shown one-file
patch. `ts/src/conversationStore.ts` now creates `conversation.md` immediately
for new sessions, refreshes it after saved checkpoints (including fork/rewind
children), and regenerates it on resume. It exports committed message records,
including tool calls/results, without changing the JSONL history contract.
Applied source matches the frozen proposal byte-for-byte; no scope deviations
or other runtime changes were made.

**Observed validation:** Actual-project TypeScript noEmit passed. Six focused
scratch groups against the applied source passed: initial file creation,
UTF8/content/tool/fence rendering, checkpoint refresh, fork/source preservation,
committed-only resume regeneration, and failed-export preservation/recovery.
No native rebuild or live model run was needed or performed; user session
directories were not used for validation.

**Operational boundary and trade-off:** Existing running terminals must restart
to load this change; older sessions gain the file when resumed. The Markdown
view updates at saved checkpoints, not during a running or failed attempt.
Rewriting this plain-text view adds work proportional to transcript size, but
one private writer and three lifecycle hooks avoid a separate export command
or synchronization subsystem. No unnecessary complexity was identified.

## 2026-10-10 — Propose file creation/deletion and complete coding-session scope

**User direction:** Add new/delete capabilities for the harness and reserve broad
manual system evaluation until the remaining features are connected. Interpret
these as model tools `create_file` and `delete_file`; focused implementation
integrity checks still accompany each approved increment.

**Pending exact proposal:** A five-file draft adds exclusive UTF8 file creation
with an existing parent, and single-file deletion after a complete fresh prior
read. Directories and symlink entries cannot be deleted. Empty-file reads gain
authorization without changing their visible result. New conversations select
six tools; existing sessions and their children retain their exact saved tool
descriptors and prompts. This avoids silently changing their rendering contract
or rejecting all older sessions when tools are added. Preparation uses the
selected owner's tools. No runtime source was changed.

**Review correction and evidence:** Astra found no blocker in the final draft.
Canonicalizing a verified regular deletion target fixes authorization when a
filename's capitalization changes on this Mac's case-insensitive filesystem.
Draft project noEmit, seven focused scratch groups and patch applicability
passed. Coverage includes create containment/exclusivity, earlier full/fresh
reads, empty/BOM/CRLF/invalid-UTF8 cases, mixed legacy/new resume/fork/switch and
cleanup. No live model test was run. Frozen diff SHA256:
`613b970fa4957e15e8800c4e5e8ba1d3d58c91cc45827de8dabe7a9dc1fd824c`.
The patch remains unapproved and unapplied; delete is limited by read_file's
UTF8 and per-line size support. The dedicated visual agent produced a walkthrough
and checked its local step logic; browser rendering remains unverified.

**Workspace scope remains open:** Astra confirmed genuine rewind needs a durable
initial baseline and immutable file snapshots published before paired history
markers. Forks must materialize selected snapshots and use tools rooted in their
own workspace. Old history cannot acquire authentic past file snapshots. Dirty
files left by failures, manual edits or crashes must be preserved and explicitly
reconciled with saved history. Workspace placement, capture scope (including Git,
dependencies and links), snapshot mechanism and dirty-state continuation policy
are still proposals, not settled implementation decisions.

## 2026-10-10 — Review a hybrid workspace object store with Astra

**User request and pending recommendation:** The user asked Astra to help balance
delta storage with full snapshots. Root and Astra recommend complete immutable
checkpoint manifests whose file entries reference exact reconstructed-content
hashes. Each content object would hold compressed full bytes or one byte-splice
delta against a full object; delta-to-delta chains are excluded initially. Compare
actual encoded sizes, including metadata, and fall back to a full object when a
delta does not save enough. Threshold and compression settings remain provisional;
this recommendation is not implementation approval.

**Clarified invariants:** A complete snapshot need not duplicate all file bytes.
Unchanged or reverted content reuses its valid immutable object, including across
forks. Existing object representation wins; do not rewrite a shared object to
change its base. For the next edit, a full object anchors itself and a delta uses
its recorded full base. Validate splice bounds, result length and reconstructed
hash; retain referenced bases, and publish objects before manifests and history
markers. A missing base fails explicitly rather than borrowing live file contents.

**Illustrative evidence and trade-off:** An in-memory sketch passed exact
reconstruction, content/revert reuse, immutable bases, one-hop references and
missing-base/corruption rejection. With gzip envelopes and a provisional 25%
saving threshold, a 198,780-byte synthetic source file's local edit used a
136-byte delta versus 15,949 bytes for full storage; two distant edits used
16,045 delta bytes versus 15,959 full bytes and selected full. Tiny configuration
edits and complete rewrites also selected full. These are synthetic encoded-size
examples, not harness workload performance or latency benchmarks.

**Remaining costs and status:** One-hop appends repeat the accumulated changes
since their full anchor; full fallback bounds reconstruction work but does not
maximize compression. Reading/hashing files, selecting encodings, complete
manifest growth and editable workspace copies still cost resources. Retention,
capture scope and crash/concurrent-writer behavior need the workspace proposal.
No runtime code or user sessions changed; file-tool approval remains pending.

## 2026-10-10 — Separate terminal diagnostics and review focused cleanup

**User direction and pending proposal:** The user deferred the workspace snapshot
decision while reading and requested an Astra code review plus separate model
diagnostics, retaining tool commands/results in chat. Astra found little justified
dead code. The exact eight-file proposal removes unused `serverStatus`, an
unreachable readiness branch and obsolete comments, and corrects the six/20-call
error wording without changing stopping policy. It routes model diagnostics to a
visible per-run workspace log and adds a read-only Desktop Terminal viewer. Tool
output and inference settings remain unchanged. No runtime/launcher changes are
approved or applied; the separate file-tool proposal also remains pending.

**Review lesson and evidence:** Diagnostic sinks must not interrupt inference.
Astra caught unguarded callback exceptions in the draft; a single guarded helper
now replaces a failing sink with stderr fallback. Draft project noEmit/unused
checks and scratch checks passed for real child JSONL routing, visible tool output,
fork/switch/preparation markers, fatal diagnostics, initial/late log-write failures,
throwing sinks, unchanged 20-call behavior and the read-only log follower. Scripts
passed shell syntax checks and are proposed as executable. Actual macOS window
opening and native model inference were not tested. Astra found no remaining
blocker. Frozen diff SHA256:
`02f46b82e894180a728325e69213b5d6fe432a16bc387ddc04e71efbcb115125`.
The GPT-6.1 Sol low visual agent checked walkthrough controls; browser rendering
remains unavailable. No user sessions were modified.

## 2026-10-10 — Apply approved terminal diagnostics and cleanup

**Implemented:** The user explicitly approved the eight-file terminal diagnostics
and cleanup patch. All six repository files and both Desktop scripts match the
frozen proposal exactly; scripts have mode 0755. New launches keep tool output,
answers and operational failures in chat, write model diagnostics to a visible
per-run log, and open a read-only follower window. Closing the follower leaves
the harness running. Existing processes need restarting to load these changes.
The workspace snapshot design and separate file-tool patch remain unimplemented.

**Validation and limits:** Actual project noEmit/unused checks passed. The focused
scratch checks passed against installed source, covering tool output, real child
JSONL routing, fork/switch/preparation, visible fatal diagnostics, log/sink failure
fallbacks, unchanged 20-call stopping behavior and the installed follower script.
A host macOS Terminal check opened the installed follower on a scratch log and
confirmed both initial and newly appended text; its process and window were then
closed without touching existing windows. No native inference or C++ rebuild was
needed or run. No real conversation logs were modified. The solution remains a
single diagnostic callback, file sink and read-only viewer, with no logging
framework or unrelated refactor.

## 2026-10-11 — Provide an editable file for manual agent testing

**Correction and outcome:** The user needed a dedicated file the agent could
read and change, separate from the conversation transcript. Explaining
`conversation.md` did not provide that testing surface; the existing small
`sample.txt` was not handed off clearly enough. Created and verified the visible
`/Users/rohilverma/Desktop/Harness Workspace/AGENT_TEST.md` beside the launcher,
with simple status, test-word and notes content. Give the user a concrete
read/edit/reread prompt and the exact file location. This fixture requires no
runtime changes or file-creation tool; the agent's edit behavior has not been
tested on this new user fixture. The separate create/delete tool proposal remains
pending.

## 2026-10-11 — Correct test-file scope to automatic per-session creation

**Clarification and mistake:** The user explicitly wants every newly created
session to start with its own editable test file inside that session directory.
The shared root-level fixture supplied earlier did not satisfy this requirement.
Do not substitute transcript exports or one-off shared files for session startup
behavior.

**Pending exact proposal:** Add exclusive `AGENT_TEST.md` creation to the new
conversation branch of `ConversationStore.open`, covering new conversations and
fork/rewind children. Print its relative path from `main.showActive` when present.
Resume preserves existing edits; older sessions are not backfilled. No prompt,
tool, model or workspace-root changes. Draft project typecheck and scratch checks
passed distinct files, existing read/edit tool access, independent child files and
resume preservation. Runtime files remain unchanged until exact-diff approval.
Diff SHA256: `41724235cfff087da7cea04829e341cb12f23c1da2d9f7d94139861396be0d8b`.

## 2026-10-11 — Apply automatic per-session test files

**Implemented:** The user approved the exact two-file patch above. Installed
`conversationStore.ts` and `main.ts` match it byte for byte. Each new conversation
or fork/rewind child receives a fresh `sessions/<UUID>/AGENT_TEST.md`; the terminal
prints its workspace-relative path. Resume does not overwrite edits, and older
sessions are not backfilled. Existing processes need restarting to load the change.

**Validation and scope:** Actual project typechecking and applied-source scratch
checks passed distinct new-session files, existing read/edit tool access, fresh
independent child files, resume preservation and unchanged older-session behavior.
No real user sessions were modified, no live inference was run, and no saved
regression suite was added. The change uses the existing creation path and tools,
with no new abstraction or dependency. The earlier shared workspace fixture was
not the requested solution; automatic per-session creation is now implemented.

## 2026-10-11 — Research shadow Git for workspace history with Astra

**Pending recommendation:** At the user's request, Astra reviewed official
OpenCode v2, Cline, Aider and Claude Code documentation and accessible source.
Root and Astra favor a private Git object store over implementing the proposed
custom full/one-hop-delta codec. Both approaches deduplicate contents and can
compress similar versions; no workload measurement establishes Git as inherently
smaller. Git supplies mature storage machinery, while editable fork directories
still consume separate space. This is research and design direction, not approval
of a code patch.

**Lessons for the proposal:** Keep snapshot objects/index/configuration separate
from the user's Git history; initially avoid borrowed object databases. Preserve
exact bytes without inherited filters/hooks. Capture eligible command changes and
preserve initial/pre-task state and failed-attempt changes. Retain snapshots with
Git references before publishing paired conversation checkpoints; a tree hash in
JSONL alone does not prevent collection. Do not claim complete file recovery when
capture fails. Dirty/manual edits need an explicit preservation policy, and true
forks need independently writable directories with tools rooted there. Capture
scope, workspace placement/Git behavior and crash recovery remain open.

**Verified fit and source caution:** Current tools share the startup cwd and only
successful tasks publish conversation checkpoints. The user's visible
`/Users/rohilverma/Desktop/Harness Workspace` is not in a Git repository; a private
store should support an ordinary directory without requiring a user repository
or account. OpenCode v2 documents a separate Git store; Cline's public docs
describe shadow Git, while inspected SDK source uses private refs in the project
repository. Do not generalize one branch implementation to every released
surface. Claude Code documents omission of Bash changes, which would not cover
our run_command workflow. No runtime code or user workspace files were changed.

Sources: [OpenCode v2 snapshots](https://dev.opencode.ai/v2/docs/snapshots/),
[Cline checkpoints](https://docs.cline.bot/core-workflows/checkpoints),
[Cline SDK source](https://raw.githubusercontent.com/cline/cline/main/sdk/packages/core/src/hooks/checkpoint-hooks.ts),
[Aider Git integration](https://aider.chat/docs/git.html),
[Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing),
[Git collection](https://git-scm.com/docs/git-gc).

## 2026-10-11 — Select independent coding workspaces; review exact shadow-Git proposal

**Settled direction, implementation pending:** The user selected a separate visible
`sessions/<id>/workspace` for each new conversation and accepted shadow Git as the
storage direction. The six-file proposal adds one raw Git object-store module,
pairs file trees with v2 conversation checkpoints, roots tools per owner, and
documents the workflow. Fork/rewind materialize independent selected files; resume
preserves existing and failed-attempt edits. Baseline #0 supports empty history.
Existing v1 conversations and their branches remain history-only because authentic
past file snapshots do not exist. No runtime patch is approved or installed yet.

**Trade-offs in the pending patch:** Raw blobs/trees avoid inherited filters,
attributes and checkout changes; retaining refs precede paired history markers.
Editable child directories still consume full copy space. Every capture scans
eligible files; reserved metadata/dependency/build paths are excluded, links and
special files are rejected, and individual files are bounded at 16 MiB. Initial
retention is indefinite. External effects and concurrent external writers are
outside snapshot guarantees. These particulars await exact-patch approval.

**Draft review and corrections:** Astra found no remaining blocker after review.
Scratch checks caught that a Git discovery ceiling set to the working directory
still discovers the parent repository; its parent directory is the tested ceiling.
Inherited GIT_* variables are removed only for new coding command owners. Astra
also caught UTF-8 decoder BOM stripping from filenames and reserved-name case
aliases on macOS. Preserve filename bytes with ignoreBOM, compare reserved names
case-insensitively, and reject noncanonical session-storage paths. These were
draft issues corrected before runtime implementation, not deployed incidents.

**Evidence and limits:** Draft noEmit/unused checks and actual runner/tools with
fake inference passed fork/switch/rewind #0, independent edits, a real failed npm
command, unsaved-message guards and dirty-file preservation. Additional scratch
checks passed byte/filename/executable/empty-directory restoration, v1 contracts,
Git retention, parent-repository isolation, concurrent bare initialization,
retaining-ref failure and oversize rejection before history publication, corrupt
restore without source changes, tail recovery and missing-workspace rejection.
No live inference, power-loss test, C++ changes, user-session writes or saved
regression suites. GPT-6.1 Sol low generated the visual; DOM controls passed,
rendered browser verification remains blocked. Exact proposal SHA256:
`62b1cf88f87e33763f3bbd0cdc68bcae7d1e58ef4d0964c97644c5d9cc1962c9`.

## 2026-10-11 — Reopen workspace placement; pause implementation

**User correction and status:** The user now favors restoring a fork into the same
workspace and explicitly asked to hold off on code changes. This supersedes the
earlier independent-directory preference for the discussion; the frozen six-file
patch is still unapproved and must not be applied. The precise shared-folder
location and restore/publication behavior remain open.

**Design implication:** Conversation branches can retain distinct saved histories
and file trees while taking turns using one editable directory. Switching would
replace managed files, requiring a recovery capture of the departing workspace,
one active writer for that workspace, and reliable restoration before treating the
target branch as active. Separate per-session writer locks alone would not protect
a shared directory. These are requirements for a revised proposal, not implemented
or approved behavior. Current runtime checkpoints still save conversation history
only after successful user tasks; shadow-Git capture is not installed.

## 2026-10-11 — Clarify that same-workspace restoration applies to rewind

**Correction and discussion status:** The latest user request concerns rewind,
not fork. The preceding entry incorrectly generalized it to forks and a shared
directory across branches. Keep independent fork workspaces as the current
direction; discuss restoring rewind into the active conversation's existing
workspace, retaining a recovery snapshot before replacement. The former exact
patch remains unapproved and would need revision. The user explicitly paused
code changes; no implementation is authorized by this clarification.

## 2026-10-11 — Set turn-end capture cadence and revise in-place rewind proposal

**Settled behavior, exact implementation still pending:** The user agreed to one
snapshot at completion of a user turn and a recovery snapshot before rewind.
Rewind keeps the active conversation UUID and workspace path; forks remain
independent. The revised six-file patch replaces the previous unapproved patch.
It retains baseline #0, removes routine pre-task/resume captures, pairs returned
success/error/length outcomes with one snapshot, and treats provider exceptions
as unfinished turns. No runtime files have been changed or exact revised diff
approved. The renewed implementation request does not waive exact-change review.

**Necessary history/recovery design:** Append a rewind event and move the active
head without deleting future checkpoints. V2 checkpoint identities use increasing
ordinals so divergent continuations cannot reuse message-count IDs. Verify/stage
selected files and exclusion conflicts first, capture current files, atomically
publish a flushed journal, restore/flush files, then publish/sync the history event.
Keep the same writer lock while restarting inference/memory. Ordinary resume
preserves files. A committed leftover journal is cleaned without re-restoration;
an interrupted rewind exceptionally captures its live state before rollback so
post-interruption manual edits remain recoverable. Unexpected state fails closed.

**Review corrections and evidence:** Astra required rejecting absent target
directories containing excluded descendants and atomic journal publication to
avoid a torn authoritative JSON file. Both draft fixes are complete; Astra found
no remaining blocker. Draft typecheck/unused checks, actual runner/Agent/tools with
fake inference, and scratch file/Git/v1 suites pass. Seven returned user turns in
the runner produced seven checkpoint snapshots, plus one baseline and two
pre-rewind captures. Focused checks also passed same UUID/path/directory inode,
retained future checkpoints and divergent numbering, fork tree reuse, excluded
data preflight, partial restore/marker recovery, temporary journal write failure,
completed-marker sync failure and cleanup failure with subsequent manual edits.
These are failure injections, not power-loss durability measurements; live GGUF
inference was not run. No real user sessions or saved test suites were changed.

**Proposal evidence:** Full patch SHA256
`8c0950dd4340689077531d11d70d960c98716982822532c3b86b23738a146c3c`.
GPT-6.1 Sol low refreshed the five-step visual and verified DOM controls. Local
browser appearance remains unverified after the earlier preview rejection.

## 2026-10-11 — Install approved shadow-Git workspaces and in-place rewind

**Implemented:** The user explicitly approved the revised six-file patch. All six
installed files match the approved proposal byte-for-byte (SHA256
`8c0950dd4340689077531d11d70d960c98716982822532c3b86b23738a146c3c`).
Turn-end file/message checkpoints, independent fork folders, retained future
checkpoints and same-workspace rewind are now installed. The TypeScript bundle
was rebuilt; no C++ source, launcher or existing user-session files changed.
Older v1 sessions keep their history-only behavior; new sessions use v2.

**Applied-source evidence:** TypeScript noEmit/unused checks and the bundle build
passed. Scratch checks using installed source passed file-byte/filename/mode and
empty-directory restoration, v1 compatibility, parent Git isolation, capture
publication failures, retention, concurrent initialization, missing-workspace
rejection, active/divergent checkpoints and interrupted-rewind recovery including
manual-edit preservation. The actual runner with fake inference passed the tool
and conversation flow, including a failed npm test saved once. No regression
suite was added to the repository.

**Live coding check:** The real Qwen model read and edited an existing multiply
function, verified it and ran npm test successfully. The runner then rewound to
baseline in the same workspace, forked the retained fixed checkpoint into an
independent workspace and switched back, leaving launch-folder files unchanged.
The restricted run initially failed during Metal initialization; the same isolated
test passed with host GPU access. This is one smoke test, not a coding-quality
evaluation or a power-loss durability test. Three repeated filename searches
preceded the successful read; model/tool-choice quality remains an evaluation
topic rather than evidence of broad coding readiness.

**Readiness clarification:** The harness can run beside an IDE and edit/test
existing files in the printed session workspace. It has no IDE extension or
editor diagnostics integration. I initially overstated creation/deletion through
commands: the allowlist provides no general create/delete command, so dedicated
tools remain a separate unimplemented step. Dependencies are excluded from seeded
workspaces and require local setup. The recovery journal is the main necessary
complexity added to keep saved files and conversation history aligned after a
failed rewind; no general storage framework was introduced.

**Interview routing:** The completed-work candidate is drafted, but the designated
review chat is archived and rejected delivery. Destination or reopening awaits
the user; no interview document was edited.

## 2026-10-11 — Reopen interview review; refresh create/delete proposal

**Completed coordination:** The user authorized reopening the existing review
chat or creating another. Reopened `01a10da8-2946-77c3-a658-eafe80e814ce` and
successfully delivered the completed shadow-Git interview candidate. No interview
document was changed.

**Pending implementation:** The user requested create/delete tools again. A
refreshed six-file proposal fits the installed independent-workspace code:
exclusive UTF-8 creation with missing parent directories, one regular-file
deletion after a complete unchanged read from an earlier model call, empty-file
read evidence, tool registration/prompt instructions and guide updates. Saved
four-tool contracts/prompts remain intact for existing v1/v2 sessions and their
forks; new conversations receive six tools. Parent creation is not a directory
transaction, and delete retains read_file's text/line-size limits. These details
are proposed, not installed or approved.

**Evidence and scope:** Draft noEmit/unused checks and scratch tests with actual
Agent/tools and fake inference pass exclusive/nested creation, path and symlink
containment, fresh/full/paged-read deletion, changed-file rejection, empty/BOM/
CRLF/invalid-UTF8 handling, case-insensitive authorization, v1/v2 resume/fork/
switch/prepare contracts, descriptor drift and lock cleanup. Creating/deleting
through Agent and rewinding/forking retained trees passed with unchanged
turn-end capture cadence. Repository runtime files are unchanged; no saved suite
or live-model test was added for this draft. Patch SHA256:
`046aac555e86c329a6f0259f06767382ef8900dcb04d5995c6890c36c2e2ec51`.

**Dependency explanation:** Seeded workspaces copy source manifests and lockfiles
but exclude installed dependency folders such as node_modules. Installation in
each workspace is currently manual; the command allowlist still excludes npm
install/ci. This proposal does not silently widen command permissions. GPT-6.1
Sol low produced the HTML walkthrough; static control checks passed, while
rendered browser verification remains blocked by the prior automatic review.

## 2026-10-12 — Install create/delete tools after Astra review

**Authorization and implementation:** The user approved the changes, requested
Astra review and explicitly waived further approval for this task. Installed the
six-file proposal with one necessary review correction: preserve the original
prompt as LEGACY_SYSTEM_PROMPT and select the expanded empty-history default only
when both new tools are available. Astra caught the prior mismatch for four-tool
v2 baseline resume, fork #0 and rewind #0; it was a draft defect, not a deployed
incident. Saved system messages still take precedence. Astra confirmed the fix
and found no remaining blocker. Applied patch SHA256:
`ae850050b6c15aaea06e5a5c7b9569212864b836687a004f6aecf7593806c1ef`.

**Validation:** Installed-source noEmit/unused checks, bundle build and focused
scratch checks passed creation/deletion guards, nested parents, empty/text edge
cases, old/new tool contracts, explicit baseline prompt agreement, fork/rewind
integration and lock cleanup. A real Qwen run created src/greeting.cjs, passed
npm test, deleted the file, restored it via rewind #1, forked the retained deleted
checkpoint #2 and switched back. Two completed user turns produced two turn
captures, plus baseline and pre-rewind captures; original source/test/package
files stayed unchanged. The model first generated ES-module syntax for .cjs,
then recovered from the test failure; the existing edit guard rejected a stale
read after the command until the model reread. This is observed smoke-test
behavior, not a broad quality evaluation or a production incident.

**Scope and trade-off:** New conversations receive six tools; existing sessions
and their forks retain saved contracts. No C++/snapshot protocol, dependency
installation permissions or user-session files changed; no saved test suite was
added. Reusing read evidence avoids another deletion-authorization mechanism.
Complete-read deletion keeps the read tool's text/line-size limits, and parent
creation may leave directories after an I/O failure. No further abstraction was
needed. GPT-6.1 Sol low refreshed the installed walkthrough and passed static
control/source checks; browser appearance remains unverified.

## 2026-10-20 — Remove spaces from Desktop workspace and launchers

The user requested renaming after unquoted folder and launcher spaces prevented
startup. Renamed the visible workspace to
`/Users/rohilverma/Desktop/HarnessWorkspace`, the launcher to
`StartHarness.command`, and the diagnostics viewer to `ModelDiagnostics.command`.
Updated embedded paths and the workspace README; the direct launch command now
contains no spaces. Both scripts pass shell syntax checks and retain executable
permissions. Existing contents were moved intact; the sessions directory had no
saved histories or writer locks, so no history migration was needed. Original
launcher/README copies are retained in a task-specific temporary backup.

Repository runtime files were not changed. The command reference
`c/SIDECAR_COMMANDS.md` still contains the previous paths; updating that repository
document remains a separate unapproved change. Use the new location above.

## 2026-10-20 — Assess local compute for future subagents

**Observed capacity:** Hardware inspection reports an Apple M4 MacBook Air with
16 GB unified memory, 10 CPU cores and 8 GPU cores. The current Qwen3-4B Q4_K_M
GGUF is 2.326 GiB on disk. The live model log
`HarnessWorkspace/logs/model-20261020-224254-63882.log` reports 2,680.19 MiB of
mapped model buffers, a 2,304 MiB KV buffer at 16,384 context positions, and
328.34 MiB of compute/output buffers: about 5.19 GiB in reported buffers. This
sum is a planning estimate, not a measured per-process physical-memory footprint;
mapped allocations and macOS accounting complicate direct addition.

**Implication, not a settled implementation:** Useful logical subagents fit the
machine when inference residency/concurrency is bounded. Independent copies of
the current full-context sidecar would be memory-heavy; three buffer budgets
alone approach the machine's total memory before other applications. Sharing one
loaded model and using shorter worker contexts are candidate improvements. At
the same cache precision/architecture, 8K and 4K caches are estimated at 1.125 and
0.5625 GiB per independent sequence respectively. The pinned llama.cpp parallel
example demonstrates one model/context serving multiple sequences with optional
shared prefix state; our harness still starts one model per sidecar and has no
subagent scheduler. No parallel-inference benchmark or additional model run was
performed; practical worker count and throughput remain unmeasured. No runtime
code changed and no subagent design was approved.

## 2026-10-20 — Explore foreground subagent call-and-return lifecycle

**Discussion only:** The user is interested in a parent delegating a bounded
task, waiting, receiving the child's findings and ending its execution. Treat
this as a logical task-call relationship within one user session; the child's
message history/context can remain separate. Claude's current documentation
describes separate subagent contexts, foreground blocking and background modes,
and resuming completed subagents. Completion therefore need not erase a child's
saved transcript or imply permanent destruction.

**Trade-off to settle:** Serial delegation bounds active inference work, but
pausing a parent does not release its allocated model/cache automatically. A
shared loaded model with retained parent/child caches and a single reusable
inference context have different memory/resume costs. The latter can rebuild
parent cache from retained messages, fitting the existing recomputation direction.
Returning only a report keeps exploration out of parent context but can omit
important evidence; child transcripts remain useful for inspection. Execution
completion does not undo child file edits. Context handoff, cache residency,
workspace policy, depth and task budgets remain open. No code change or subagent
implementation is authorized by this discussion.

Source: https://code.claude.com/docs/en/sub-agents

## 2026-10-20 — Astra feasibility review of scoped foreground workers

**User proposal, implementation not approved:** One unchanged local 4B model;
sequential parent-to-child delegation only; investigator read-only, editor scoped
to specified files/criteria, and tests executed by a harness tool. Workers are
optional on demand and return bounded completed/blocked/failed reports with
evidence rather than full traces. Numeric token histories were proposed for
pause/resume; current runtime still retains authoritative messages and renders/
tokenizes complete prompts. No token export/import protocol exists.

**Review outcome:** Astra found the architecture feasible using one shared
provider/context and an awaited child call within the parent's existing tool
execution. Existing full-prompt comparison can replace child cache on return.
Parent messages and its live continuation must remain intact; rerunning the
original task or using conversation switch/shutdown would restart work or lose
the shared backend. In-memory suspension is distinct from durable mid-task
resumption. A shared-provider transport failure remains fatal to orchestration.

**Required clarifications before implementation:** Enforce capability/scoped
canonical file checks; keep trusted commands separate from read-only workers.
Use aggregate task budgets as well as worker limits, propagating actual native
usage currently discarded by ModelResponse. Validate report fields and evidence
against recorded operations; generation success does not establish acceptance.
Define partial-edit behavior on failure, preserve outer-turn checkpoint cadence,
invalidate read evidence after delegated writes/tests, and cap total delegation
and repairs independently of depth. Sharing a single fixed 16K context avoids
duplicated cache allocations; shorter prompts alone do not shrink that allocation.
Role prompts do not establish a coding-quality improvement on the same 4B model.
These are review recommendations, not settled implementation choices.

**Evidence:** Astra inspected source and ran an isolated renderer check showing
that adding a user message can change earlier rendered reasoning, so prior prompt
tokens are not always an appendable prefix. A separate scratch probe using the
actual Agent and ConversationMemory with one scripted provider passed parent
before/delegate/after tool ordering, separate child messages/read state, one
pending generation, original result IDs and no replay of the original user task
or surrounding tools. Neither probe implements subagents or demonstrates native
switching equivalence, crash recovery, permissions/budgets or model-task quality.
No repository runtime files changed. Next evidence should compare native
parent/child/parent switching with fresh recomputation and evaluate direct versus
delegated tasks under comparable total budgets.

## 2026-10-20 — Reconsider fixed specialist roles versus task scope

**Open design choice:** The user clarified that ordinary general-purpose
subagents remain an option; the earlier investigator/editor split is not a
settled requirement. Task boundaries, supplied context, tool capabilities and
file permissions are separate from a named specialist role. A general worker
can receive a bounded assignment with permissions chosen per invocation;
investigator/editor configurations could be optional presets rather than
separate agent implementations or mandatory workflow stages.

**Trade-off:** Narrow assignments and limited writes constrain side effects and
make results easier to review, but premature file restrictions cause blocked
handoffs for changes that span multiple files. Read access and write scope can
differ. Permissions require tool enforcement, and trusted command execution can
exceed file-tool restrictions. Neither role labels nor scope establish better
model quality. No worker configuration or runtime change is approved by this
discussion.

## 2026-10-20 — Favor read and write worker capability profiles

**Current discussion direction, implementation not approved:** The user favors
simple reading and writing subagents. Treat these as tool-capability profiles
of the same worker: a reader searches/reads; a writer also reads and can mutate
files. This does not by itself require an exact per-file write allowlist or a
mandatory reader-before-writer pipeline. Keep command execution a separate
permission; project tests/scripts can write files despite being used to inspect
behavior. Handoff evidence, fresh reads before writes, partial-edit reporting,
aggregate budgets and output verification remain necessary design details.

## 2026-10-20 — Independent Astra review revises the read/write proposal

**Revised recommendation, implementation not approved:** A fresh-context Astra
review retained one generic worker with Reader/Writer capability profiles,
optional sequential delegation and a shared provider. The value is controlling
side effects and separating exploration, not stronger reasoning from role names.

**Corrections adopted:** Workspace containment and tool access are enforceable;
task relevance remains an instruction without explicit path restrictions. Give
children the requested outcome and constraints, label parent diagnoses as
assumptions, and retain contrary evidence and unresolved questions in reports.
Writer initially prepares changes while parent-run validation remains separate;
do not equate a child completion claim with passed checks or automatically
delegate every repair. Attach observed tool operations to bounded reports rather
than promising general semantic verification or a new durable transcript system.

**Minimum execution requirements:** Start with shared model-call limits, a
smaller child allowance, delegation/tool/output bounds and reserved parent
capacity; exact token accounting needs native usage propagation or conservative
reservation, not estimation from text. A child provider failure must propagate
immediately: the current parent tool catch would otherwise turn it into a
recoverable result and could execute later queued tools. Clear stale parent
read evidence even on failure. Preserve saved tool/prompt contracts by enabling
delegation for new conversations initially. Existing outer-turn checkpoints and
partial-edit behavior remain unchanged in the proposal.

**Evidence limits:** Review inspected current source; no runtime implementation,
native switching benchmark or model-quality/latency evaluation was performed.

## 2026-10-21 — Concrete Reader/Writer patch staged for exact approval

**Pending exact-patch approval:** The user is satisfied with the design and
requested a build. Repository approval rules still require showing its exact
diff before runtime edits. The proposal changes `ts/agent.ts`, `ts/main.ts`,
`ts/src/interfaces.ts`, `ts/src/prompts.ts` and adds `ts/src/subagents.ts`.
It uses one shared provider, Reader/Writer tool profiles, bounded JSON reports
and observed operation metadata; fatal provider errors propagate immediately.
Proposed limits: 20 model calls/80 tools/3 delegations per outer task, 6 model
calls/20 tools per child, 1,024 output tokens per child request, and two model
calls reserved for parent continuation. Earlier nondelegating sessions preserve
their tool contracts and tool-call behavior. No native/persistence change.

**Staged evidence:** Root and staged typechecks passed; the staged CLI bundled.
Eight scripted-provider groups passed permissions/depth, shared-provider
continuation/history isolation, actual scratch edits/stale reads, fatal failure,
malformed-report partial edits, shared/local budgets and legacy behavior. A
simulated JSONL-sidecar CLI check passed new delegation, resume, old six-tool
sessions and one outer-turn checkpoint without child history pollution. These
are model-free checks, not native inference or quality/latency results.

The exact patch is `read-write-subagents.patch` in this chat's visualization
directory (SHA-256 `046d8ba15eb0c1a842a0de147d9e5e55e7049c6bb61399cd6db9b127e093d0a9`).
Staged sources, original-file hashes and scratch checks are retained under
`/private/tmp/harness-read-write-proposal-BHpbf4`. Recheck original hashes before
applying after approval; repository runtime files remain untouched.

## 2026-10-21 — Approved subagent patch applied; live report wording fix pending

**Implemented exactly as approved:** The five runtime files match the approved
patch and staged copies byte-for-byte. Applied-source typecheck, CLI bundle,
eight scripted test groups and simulated-sidecar new/resumed/old-session checks
passed. Parent history and outer-turn checkpoint isolation were preserved. No
C++ or conversation-store source changed.

**Observed live failure and proposed correction:** The first Qwen Reader
returned valid completion JSON with placeholder evidence and zero file
operations; the parent answered `marker` instead of the actual file content.
The instruction `Return only JSON` likely contributed by conflating tool work
with final reporting. A temporary one-line prompt revision explicitly separates
tool calls from the final JSON answer and requires actual findings/exact values.
It passed a real Reader read/report and Writer read/edit/readback on the same
provider in ten serial generations. Independent test assertions checked the file
bytes. The parent resumed but omitted the requested additional parent read;
its verification claim must not be presented as independent validation.

**Status and limits:** The prompt revision is not installed and requires its
own exact-diff approval. Only the original approved patch is in the repository.
No quality/latency benchmark or guarantee follows from these two worker examples.
The restricted process could not create a Metal context; host-access testing
worked without native changes. Follow-up source, diff and observations are in
`/private/tmp/harness-subagent-report-followup-k4MouF`; the approved-source checks
remain under `/private/tmp/harness-read-write-proposal-BHpbf4`.

**Interview routing:** The dedicated review chat could be read but rejected the
candidate message because it is archived. The candidate was not delivered; the
user has been asked whether to reopen that chat or keep the candidate here.

**Routing resolved:** The user chose to reopen `Interview story review` on
October 21. The chat was unarchived and the candidate delivered, explicitly
distinguishing installed code from the still-unapproved prompt revision and
requiring direct human approval before any interview-document edit. This
routing authorization does not approve the runtime prompt change.

## 2026-10-21 — Describe persistence as saved history plus recomputation

**Documentation correction requested:** The user reiterated that the project is
not a KV-cache persistence engine. The current durable format stores messages,
configuration and Git workspace-tree references, not computed KV snapshots or
a separate numeric-token log. The running llama.cpp context still has temporary
KV state and the sidecar reuses matching prefixes in RAM; do not claim that
inference uses no KV state at all. Older cache-save/load proposals remain
historical. Several current guides incorrectly describe sessions as memory-only
or unimplemented; the proposed documentation patch corrects those statements
and updates project progress. README/guide/handoff/plan changes await exact-diff
approval; neither this request nor this entry approves the pending runtime
prompt clarification.

The six-file documentation proposal is staged at
`/private/tmp/harness-doc-state-kaPa8y/docs.patch` with original-file hashes in
`baseline.json`; its review copy is `project-state-docs.patch` in this chat's
visualization directory. No README, guide, handoff or plan file has been edited.

**Approved and applied:** The user approved the six-file documentation patch on
October 21. README, harness guide, sidecar overview/guide, Phase 2 plan and project
handoff now describe durable messages/configuration and Git file trees, with
inference reconstructed when needed. Temporary llama.cpp KV state and matching
prefix reuse remain in RAM. All six installed documents match the approved
copies exactly; Markdown fences balance and all six added local links resolve.
No runtime code changed or implementation complexity was added. The separate
runtime child-report prompt correction remains pending its own approval.

## 2026-10-21 — Project-wide review: verified open issues

**Context:** The user requested a whole-project scan for current issues and
cleanup candidates. Review only; no runtime or documentation files changed and
no fixes are approved.

**Verified by scratch probes against current source (no live model):** A
malformed `<tool_call>` envelope makes `parseQwen` throw; `Agent.run` wraps it as
`ModelProviderError` and `main.ts` rethrows it, ending the runner although the
sidecar is healthy. Exhausting the 20-call loop or tool budget also throws and
ends the runner. Neither path saves that attempt's messages. Tool output is
rendered verbatim, so chat-template control text inside a file reaches a
tokenizer that parses special tokens across the whole prompt; the tokenizer
effect is inferred from source, not run.

**Open limits:** Prompt plus output allowance must fit the fixed 16,384 context
(about 14,337 prompt tokens at maxTokens 2048); overflow is fatal and there is
no truncation or compaction. Logged prompts peaked at 5,771 tokens, so overflow
has not been observed. Typecheck and unused-symbol checks pass.

**Hygiene findings:** Work since the October 10 commit is uncommitted, including
untracked modules imported by tracked `main.ts`. The `ts/src/dependencies`
package and tsconfig files are untracked although `ts/tsconfig.json` extends
them. `build/` and `c/build/` (about 1.4 GB) and `.DS_Store` files are not
ignored. Leftovers from llama-server (`.env` keys, `.runtime`, stale `ts/dist`)
and stale handoff/command docs remain. Cleanup scope awaits the user's choice.

**Follow-up checks:** Committed HEAD's `model.cpp` defines `Inference::prepare`
and `prefill`, but HEAD's `interfaces.hpp` does not declare them; only the
uncommitted header does, so the committed sidecar source does not compile.
`c/build` (the launcher's sidecar) is configured `CMAKE_BUILD_TYPE=Debug`; its
inference-speed effect is unmeasured. The user chose repo hygiene first and
will direct sorting of the Markdown files.

## 2026-10-21 — Apply repo hygiene on main; user commits

**Implemented as approved:** The user approved the shown proposal on main and
will make commits and pushes personally; the assistant made no commits and
staged nothing. Root `.gitignore` now ignores `.DS_Store`, `.vscode/`, `build/`,
`*.log`, and root `sessions/`, `logs/` and `snapshots.git/`. In
`ts/src/dependencies/package.json` the broken `dev`/`start` scripts were
removed and `typecheck` now targets `../../tsconfig.json`. Stale `ts/dist/`,
`.runtime/` and the unbuilt root `build/` were moved to the macOS Trash through
Finder (recoverable); `npm prune` removed unused `ollama`, `openai` and
`whatwg-fetch`. `.env` and `c/build` were kept. No deviation from the proposal.

**Validation:** `npm run typecheck` and root `tsc --noEmit` passed; the build
command bundled to scratch; the `c/build` sidecar answered a model-free ping;
`package-lock.json` is byte-identical after pruning. `git status` now shows only
source, docs and three trackable `ts/src/dependencies` files. Markdown sorting
and both suggested commits remain with the user.

## 2026-10-21 — Markdown keep rule set; exact list pending approval

**User decision:** Keep README, AGENTS.md, design-decision and interview-story
records, and documents that explain the relevant commands; remove the rest for
cleanup. The proposed application keeps `README.md`, `AGENTS.md`,
`notes/decisions.md`, `notes/STORIES.md`, `c/PHASE_2_PLAN.md` (decision/progress
record required by AGENTS.md), `c/SIDECAR_COMMANDS.md`, `c/SIDECAR_GUIDE.md` and
`notes/WORKSPACE_HISTORY.md`, and moves 15 other Markdown files to the Trash.
A four-file link/accuracy patch (SHA256
`4dda9bfa903e7a62c7b1636122998ec74622d0f252b340c5268255a925d44cc3`) repairs
links the removals would break and corrects stale launcher paths and v1-only
rewind/save wording. Both await exact-list approval; nothing is removed yet.

**Applied with the user's revision:** The user kept the personal notes
`notes/agentHarness.md`, `notes/cpp.md` and `notes/inference.md`, kept
`c/PHASE_2_PLAN.md` but wants it deeply revamped (separate, not started), and
removed the rest. Twelve files went to the macOS Trash through Finder; the
four-file patch above was applied unchanged and matches its proposed copies.
Eleven Markdown files remain. A link check found no broken links apart from the
historical `tools.md` reference in this file's Oct 3 intro (kept as written) and
a C++ snippet false positive in `cpp.md`. The `.gitignore` entry for the removed
learning guide is now unused; nothing was committed.

## 2026-10-21 — Retire the Phase 2 plan

**User decision:** The Phase 2 sidecar plan is fulfilled; the barebone
implementation is largely complete. `c/PHASE_2_PLAN.md` was moved to the macOS
Trash, superseding the earlier intent to revamp it. Earlier entries that cite it
remain historical. Future validation evidence and open gaps belong in this file.
A three-file patch removing the now-dangling references from AGENTS.md, README.md
and SIDECAR_GUIDE.md (SHA256
`bb0ba6c4e50ac308a034b48a91ab3b9ac22196513d9e3cac36049bf4e8e8b871`) awaits
exact-diff approval; those references are broken until it is applied.

**Applied:** The user approved the patch as shown. All three files match the
approved copies; no non-historical `PHASE_2_PLAN` mention remains, and the link
check found only the known `tools.md` history link and the `cpp.md` snippet
false positive. AGENTS.md's TypeScript baseline section remains stale (no
conversation store, workspace snapshots or subagents); updating it is separate.

## 2026-10-21 — Subagent flow review: one shared cache slot

**Context:** The user asked for a visual explanation of complications in the
Reader/Writer flow. The crash-path fix was handed to its own session. No
visualization skill was available to add from the catalog; the installed
`artifact-diagramming` skill was used for a private walkthrough artifact
(https://claude.ai/artifact/GV3A2oEAWyGafDMKCjQJT3). Its script passed a syntax
check; the built-in browser was not signed in, so it was not render-checked.

**Measured (scratch probes and model logs, no live inference):** Children get
separate memory but share one SidecarProvider, llama context and evaluated-token
history. Rendered with the real `delegate` tool, a Reader child's prompt shares
29 characters and a Writer child's 2,416 of the parent's 8,892, so each
delegation evicts the parent's cache and the parent re-prefills almost all of
its history afterwards. Logged large prefills ran at 258–404 tokens/s and
generation at 24–27 tokens/s; one logged prompt gives about 4.3 characters per
token. Child generations are capped at 1,024 output tokens.

**Open complications (not fixed):** child provider errors and shared-budget
exhaustion end the runner (covered by the pending crash-path fix); the parent
re-prefill (estimated 14–22 s for a 6,000-token history); reports must be bare
JSON while the Writer prompt also says to explain; one Writer generation cannot
carry more than 1,024 tokens of file text; children see only the current prompt
plus parent-written context; each result can add about 8 KiB to the parent;
Reader reads do not authorize parent edits; child transcripts are not saved.

## 2026-10-21 — Crash-path fix proposed; pending approval

**Proposal (not applied):** A five-file patch (SHA256
`0bf3837dbaed718dcf8a98871cdf080c30a06b2c17975d9d5883a317bb621f8d`) makes
`SidecarProvider.generate` return conclusion `error` with the raw text when
`parseQwen` fails, adds `AgentLimitError` for the three Agent limit throws, and
has `main.ts` catch only that class, print `Task stopped:` and treat the turn as
ended (v2 saves a checkpoint; v1 still saves only success). Transport and other
provider failures stay fatal. Two doc lines mention limit stops.

**Scratch evidence (fake sidecar, no live model):** The current runner exited 1
on the first task for a malformed tool call, the 20-call loop and a child
Reader's malformed call. The staged runner ended all five test turns (error,
stopped, two failed child reports, success), saved five checkpoints, left no
writer lock, exited 0 and resumed cleanly. Staged typecheck and unused checks
passed. The parent shared-budget path and v1 sessions were not exercised.
Feeding parse errors back for an in-turn retry remains an open alternative.
The walkthrough (Claude Sonnet 5.5, low effort; GPT-6.1 Sol unavailable) was
verified on localhost at 420px in both themes:
https://claude.ai/artifact/Cxa6EDnpNC4rhQZYzDLLFW.

**Applied as approved:** The user approved the patch with that exact SHA256. All
five installed files match the staged copies byte for byte; no deviation. On the
installed source, repository typecheck and unused checks passed, and the same
fake-sidecar runner run ended all five turns, saved five checkpoints, logged both
`unparsable output` lines, left no writer lock, exited 0 and resumed. A malformed
tool call or call/tool limit now ends the turn instead of the runner. No live
model run, parent shared-budget case or v1 session was tested. Not committed.

## 2026-10-22 — Open: keep the parent's KV cache during delegation

**Question:** The user expects re-prefilling the parent after every delegation
to cost more than anticipated and asked whether a KV cache can be kept for
subagent use. This is in-memory reuse within one sidecar process, separate from
the October 7 choice not to persist computed cache for conversation history.

**Verified at pinned llama.cpp 7fe450e:** `n_seq_max`, `kv_unified`,
`llama_memory_seq_rm/cp` and per-sequence RAM state copy
(`llama_state_seq_get_data/set_data`) exist. `kv_unified` defaults to false, so
two sequences would each get `n_ctx / 2` (8,192); with it true, sequences share
all 16,384 cells. The logged KV buffer is 2,304 MiB at 16,384 cells (144 KiB
per token), so a RAM copy of a 6,000-token parent is about 844 MiB.

**Recommendation, not decided:** run the child in a second sequence of the same
unified context, keeping the parent's cells in place and freeing the child's
cells after it returns; the alternative is copying the parent's sequence state
to RAM and restoring it. Neither has been prototyped or timed.

**User decision (2026-10-22):** Use Option A, a shared unified cache with the
child in its own sequence. The exact patch, prototype timing and walkthrough are
being prepared; no runtime file is changed until the exact diff is approved.

**Proposal ready, pending approval:** A seven-file patch (SHA256
`de9b85f052d458b5c9f7a7e1899dbb5fc41ccf8e82caa4bead38fc1918598a45`) sets
`n_seq_max = 2` and `kv_unified = true`, keeps one evaluated history per sequence,
tags every batch with its sequence, adds a `release` request, and drops the other
sequence only when a request would not fit beside it. A failed request now clears
only its own sequence. TypeScript sends `sequence: 1` for child requests and
releases sequence 1 after each child; a failed release is a provider failure.

**Evidence (scratch, staged Debug build):** Staged typecheck and unused checks,
five scripted sequence/release checks and seven model-free protocol checks
passed; the build had no warnings. Live Qwen run: after a 1,569-token child ran
in sequence 1 and was released, the parent's 6,541-token prompt reused 6,436 and
prefilled 105 tokens (11.5 s including 24 output tokens). A child needing more
room evicted the parent's 6,564 cached tokens and finished normally. The run was
cut off by a session restart before the parent's post-eviction rebuild, and the
current build's comparison run was not completed. Machine GPU throughput was
much lower than on October 20 (about 43–69 prefill tokens/s versus 258–404),
so times are not comparable across days. A new executable's first launch spent
49 s compiling Metal shaders. Walkthrough by Claude Sonnet 5.5 at low effort:
https://claude.ai/artifact/3ZqGSu41Ky2Vqtvp3CM2nA; controls, 400px width and
both themes were checked on localhost before the measured numbers were filled in.

**Applied as approved (2026-10-22):** The user approved SHA256 `de9b85f0…598a45`.
All seven targets matched the staging baseline beforehand and match the staged
copies byte for byte afterwards; no deviation. `c/build` (still Debug) rebuilt
only the three sidecar sources, without warnings; the previous binary is kept in
scratch for comparison. On the installed code: repository typecheck and unused
checks passed; the five scripted sequence/release checks passed after a test-only
fix (on Node 22.18 an ESM test and the CommonJS-loaded harness get separate
`agent.ts` instances, so the test now checks the error name as main.ts does);
the seven protocol responses are byte-identical to the staged build's. Live Qwen
on the installed binary: after a 1,569-token child ran in sequence 1 and was
released, the parent's 6,541-token prompt reused 6,436 and prefilled 105 tokens
(prefill 45 ms); an oversized child evicted the parent's 6,564 tokens and the
parent's next request rebuilt all 6,541 (prefill 135.8 s at today's reduced GPU
speed). Through the real SidecarProvider and delegate tool, a Reader child ran on
sequence 1, `release` freed its 756 tokens, and the parent then reused 2,018 and
prefilled 129. That Reader made no tool calls and reported failed: the known,
still-pending child-prompt issue, not this change. Not committed.

**Before/after on the same day (saved pre-change binary, same script):** after
the child, the old parent request reused 461 and prefilled 6,080 tokens (prefill
134.1 s, request 150.8 s); the new one reused 6,436 and prefilled 105 (prefill
45 ms, request 10.5 s). The parent's 24-token greedy output was identical. One
trade-off: the old binary let the Writer child reuse the 461 tokens it shares
with the parent's prompt; in its own sequence the child now prefills them (1,569
instead of 1,108 tokens, about 8 s more today). Copying that prefix into the
child's sequence with `llama_memory_seq_cp` could recover it; not proposed.

## 2026-10-22 — Open: context compaction

**User direction:** Compaction is the last missing piece; the user is reviewing
their own notes (`notes/agentHarness.md`: drop stale file previews, pin task,
plan and error history, summarize older exchanges, cache-aware ordering) before
choosing. Nothing is decided or implemented.

**Constraints found in code:** saved checkpoints reject any change to an earlier
message (`ConversationStore.saveCheckpoint`), so compaction has to change only the
rendered prompt, never ConversationMemory or history.jsonl. The prompt limit is
14,337 tokens and overflow still ends the runner. Read evidence is already
per-task (`Agent.run` starts with empty `readRanges`), so file contents from
earlier tasks cannot authorize edits anyway. Any change to earlier prompt text
forces re-prefill from that point (a full 6,541-token rebuild measured 135.8 s
on 2026-10-22).

**Assistant proposal (not accepted):** first increment, view-only: render earlier
tasks' tool outputs as short stubs at each new task (deterministic, no new
saved state); within a long task, stub the oldest outputs once real
`prompt_tokens` crosses about 10K; make overflow end the turn instead of the
runner. Pin system prompt, user messages, assistant text and failed results.
A model-written summary (in sequence 1) is a later tier, used only if stubs
are not enough.

**User direction (2026-10-22):** Follow the OpenCode strategy: trigger at the
input limit minus space reserved for the response, have the model update the
previous summary (keep relevant details, drop old ones), keep the latest couple
of user turns, and remove older tool outputs, which the user expects to be the
main source of bloat. This supersedes the stub-first proposal above as the
direction; exact thresholds, persistence and the patch are not yet settled.
OpenCode references checked: v2 docs (keep.tokens, buffer, incremental summary
update, one overflow retry) and secondary descriptions of v1 pruning
(PRUNE_PROTECT 40K, PRUNE_MINIMUM 20K) and v2 internals (five-section summary,
4,096-token summary cap, 2,000-character tool-output truncation); the secondary
sources disagree on some defaults.

**Measured token ratio (2026-10-22):** The user noted OpenCode estimates tokens as
characters / 4. On our Qwen tokenizer, rendered prompts from the live timing run
gave 4.4 characters per token for the system prompt and tool schemas (8,960 /
2,028), 4.5 for a child prompt (7,078 / 1,569), but 3.3 for code-heavy read_file
results (14,807 / 4,448). Characters / 4 would undercount tool output by about
20%, which matters with a 16K window. Open recommendation: use the sidecar's
exact `prompt_tokens` from the last call and estimate only newly added text,
conservatively (about characters / 3), or add a tokenize-only count request.

**Scope settled by the user (2026-10-22):** Implement OpenCode-style compaction
together with (1) exact-plus-estimate token counting with a context-usage prompt
display and a log line per compaction, (2) shrinking large search/command
outputs at the source with the full text saved to a file, and (3) hiding stale
and duplicate file reads at compaction time. Reader delegation already exists;
using it for heavy exploration is a usage pattern, not new work. Pinned notes
were explained but are not in scope. A separate implementation session carries
this out in approved increments; no commits.

**Scope addition (2026-10-22):** The user asked to build pinned notes too ("thats
a great feature. lets build"). It goes to the same implementation session as
increment 4, after compaction, because it touches the same rendering, tool and
`main.ts` code. Direction: a hybrid block where the harness fills the objective,
the files touched and the last error, and the model maintains the plan, key
facts and the next step through an `update_notes` tool that replaces the whole
block. It is rendered at the end of every prompt (not the top, to keep the cache
stable) and is never compacted. It is derived from the full message history, so
no new saved records are needed. New conversations only; children get none. The
exact patch still needs approval.

## 2026-10-22 — Context increment 1 (token accounting) proposed; pending approval

**Proposal (not applied):** A five-file patch (SHA256
`0058338036d15481861644e949f10e3f75ae64f587ced23a923555fd33e81b23`) adds a required
`ModelResponse.usage` (`promptTokens`, `generatedTokens`) filled by
`SidecarProvider.generate` on every outcome; `Agent.measured` (exact prompt plus
generated tokens and the message count they cover) and `Agent.contextTokens()`
(that count plus the JSON length of newer messages / 3; before any count, the
system prompt and tool schemas the same way); `CONTEXT_TOKENS = 16384` in
sidecar.ts; a REPL prompt such as `main 3.7K/14.3K >>` (limit 16,384 − maxTokens
+ 1); and one SIDECAR_COMMANDS.md sentence. No C++ or saved-format change. The
per-compaction chat/log line moves to increment 2, because no compaction exists
to log yet. Resume shows the full estimate until the first call; feeding the
background `prepare` count to the Agent is left for increment 2, whose trigger
needs it.

**Evidence (staged copy):** Typecheck and unused checks passed. A fake-sidecar
runner run showed the prompt on a new conversation, after success, error and
length turns, and after resume. A scripted check matched every estimate to the
formula exactly. Live Qwen run (two tasks, four calls, reads of agent.ts and
qwen.ts, then a search): estimate vs exact prompt tokens were 1,284 vs 942
(fallback, before any count), 3,976 vs 3,564 (after two read results; +16% on the
new text), 3,752 vs 3,736 and 4,039 vs 3,971. No call was underestimated. The GPU
was slow again (34–73 prefill tokens/s). Walkthrough by Claude Sonnet at low
effort (GPT-6.1 Sol unavailable), checked on localhost at 400px in both themes:
https://claude.ai/artifact/Ln9eTN5AwoZ1ogRJsc4cyZ.

**Noted for increment 2:** a capacity rejection runs `Inference::generate`'s
catch-all, which calls `forget(sequence)` and drops that sequence's whole cache.
The overflow retry will therefore re-prefill even the unchanged system and tool
prefix.

**Applied as approved (2026-10-22):** The user approved SHA256 `00583380…e81b23`.
All five targets matched the staging baseline beforehand and match the staged
copies byte for byte afterwards; no deviation. On the installed source the
repository typecheck and unused checks passed, the fake-sidecar runner showed
`main 2.6K/14.3K >>` on a new conversation and exact-based values after success,
error and length turns and after resume (exit 0, four checkpoints, no writer
lock), and the scripted estimate arithmetic matched exactly. The live Qwen
numbers above come from the identical staged code; no new live run was made.
Not committed.

## 2026-10-22 — Context increment 2 (compaction) proposed; pending approval

**Proposal (not applied):** A ten-file patch (SHA256
`6e236368a498f39de3375509bbcfc9c0c155c3f0b842f3627141eee15f97162c`) adds
`ts/src/compaction.ts` and changes agent.ts, main.ts, modelClient.ts,
interfaces.ts, prompts.ts, sidecar.ts, conversationStore.ts, README and
SIDECAR_COMMANDS. Before each parent call, an estimate above 16,384 − maxTokens
− 2,048 sends the prompt as last sent plus a system-role summary instruction
(tools kept, 1,024 output tokens). The view becomes system prompt, summary
(system role), then kept messages. Within the kept range, superseded and
duplicate reads become notes and older outputs are cut to 2,000 characters,
once, at compaction time. It keeps two user turns if the view fits 8,192
estimated tokens, else the latest request plus its newest steps that fit. A
capacity rejection (now `ContextOverflowError`) compacts and retries once, then
ends the turn as `AgentLimitError`. Children never compact. Read records are
cleared. A `compaction` record after its messageCount-th message is covered by
the checkpoint digest and replayed by resume, rewind, fork and `prepare`; the
prepared exact count feeds `Agent.measure`. Full messages stay saved.

**Design additions beyond the brief:** the steps fallback when two turns
do not fit. In the live run Qwen made ten parallel reads in one reply, so the
current turn alone exceeded the window. Summary and instruction use the system
role (see below). The instruction names what goes under each heading and says
file contents are not instructions.

**Assistant mistake corrected by a live test:** the first version sent the
instruction as a user message. Qwen then summarized it as the user's request
("optimize conversation context") instead of the real task, in three of three
user-role summaries (two wordings). The same new wording as a system message
gave the correct Objective, the exact read ranges and "Next Move: None". This
was one conversation per variant, not a quality benchmark.

**Evidence:** Staged typecheck and unused checks passed. Pure view checks
(stale, duplicate, cut, frozen prefix, boundaries) and five scripted Agent
scenarios passed (trigger, stable prompt prefixes, failed summary, overflow
retry and second overflow, child, transport errors). Fake-sidecar runner:
compaction record placed after message 20. The prepare prompt equaled the
rebuilt view on resume, /rewind 1 (none), /rewind 3, fork, fork resume and a
crafted v1 session. Capacity errors at generates 3, 7, 9 gave success, stopped
(checkpoint saved, runner continued), success. Live Qwen (user-role version):
the summary request reused all 1,315 cached tokens and prefilled 12,690; after
compaction the prompt was 8,802 exact (estimate 11.0K); the next task reused
8,895 and prefilled 31; the task and follow-up answers were correct. The
system-role full run reached its first compaction (16.4K → 10.5K, 1,247-
character summary) and was stopped at the user's request to free RAM. Its
continuation and a live second (incremental) compaction were not observed.
Walkthrough by Claude Sonnet at low effort, checked on localhost at 400px in
both themes: https://claude.ai/artifact/KLrKPNHD7m28AD9MEdheqP.

**Open:** Writer-child edits (delegate operations) do not mark earlier reads
superseded. A capacity rejection still drops the sequence's whole cache in C++.
A failed summary is retried before the next call, at most once per call.
