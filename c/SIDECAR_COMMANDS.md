# Sidecar and conversation commands

Use the launcher commands in your normal shell. Use the slash commands inside
the harness, at `main 6.5K/14.3K >>` or a named conversation's prompt. The
numbers are the estimated next model prompt and its limit, in tokens: the
16,384-token context minus the 2,048-token output allowance, plus one. The
harness handles conversation navigation; the C++ sidecar handles model computation.

## Start or resume

Start a new conversation with the configured local model:

```sh
"/Users/rohilverma/Desktop/HarnessWorkspace/StartHarness.command"
```

Resume a saved conversation at its latest checkpoint:

```sh
"/Users/rohilverma/Desktop/HarnessWorkspace/StartHarness.command" --resume CONVERSATION_UUID
```

Replace `CONVERSATION_UUID` with the full ID printed at startup or by
`/conversations`.

If that conversation is already open in another terminal, type `c` there first.
Existing running harnesses must restart to load the new slash commands.

## Navigate inside the harness

| Command | What it does |
| --- | --- |
| `/help` | Prints the command list and naming rules. |
| `/checkpoints` | Lists saved checkpoints with their numbers, message counts, IDs and last-user summaries. |
| `/show 2` | Prints saved messages through checkpoint #2, including tool calls and result IDs. |
| `/rewind 2` | Restores checkpoint #2's files and messages in the same conversation and workspace; later checkpoints stay saved. Legacy conversations get an automatically named continuation instead. |
| `/fork 2 clan-alt` | Creates a conversation named `clan-alt` from checkpoint #2, with its own copy of that checkpoint's files, and switches to it. |
| `/conversations` | Lists conversations in the current workspace, their full UUIDs and availability. |
| `/switch main` | Switches to the original conversation in the current branch family, at its latest checkpoint. |
| `/switch clan-alt` | Switches to a named conversation at its latest checkpoint. |
| `/switch CONVERSATION_UUID` | Switches by full UUID; replace the placeholder with an ID from the list. |
| `//explain this` | Sends `/explain this` as a model prompt instead of treating it as a command. |
| `c` then Enter | Exits the harness and shuts down its sidecar. |

Use the number after `#` from `/checkpoints`. For example, `#2 messages=7`
means use `2`, not `7`. The suffix of a checkpoint ID is a message count.
Checkpoint numbering is local to each conversation: source checkpoint #2
becomes checkpoint #1 in its new child. The child records its source checkpoint.

Names have 1–64 lowercase letters, digits, hyphens or underscores, starting with
a letter or digit. `main` and UUID-shaped names are reserved. Names are matched
across the current workspace; if a name is ambiguous, use the full UUID.
Short UUIDs displayed as labels cannot be used as UUID selectors.

Example walkthrough — run each line separately, after the prompt returns:

```text
/checkpoints
/show 2
/fork 2 clan-alt
/checkpoints
/switch main
/rewind 1
/conversations
/switch clan-alt
```

Choose checkpoint numbers that exist in your conversation. Fork and rewind
preserve the original's later saved history, and restored tools are not rerun.
Rewind captures the current files before restoring the selected ones; effects
outside the workspace are not undone. Legacy conversations change history only.
See [workspace history](../notes/WORKSPACE_HISTORY.md) for details.

## Saving, preparation and unsaved attempts

Each task that returns (success, error or length) or stops at a call/tool limit
saves a checkpoint with a file snapshot. A provider failure or crash leaves an
unsaved attempt; its live files remain. Legacy conversations save only successful
tasks and keep failed attempts in memory until the next success. Exiting drops
anything unsaved.

Switch, fork and rewind refuse to drop unsaved attempts unless you explicitly
add the flag to that command:

```text
/rewind 2 --discard-unsaved
/fork 2 retry --discard-unsaved
/switch main --discard-unsaved
```

This discards only unsaved live changes; it preserves existing saved history.
Switching to the already active conversation is a no-op.

On resume or a conversation change, the target model loads and the terminal
prints `Preparing context… You can type your next message.` Context rebuilding
continues in the background; a submitted task waits if preparation is unfinished.
Commands and `c` are handled between tasks, so they do not interrupt a running task.

## Where to find history and diagnose problems

New conversations launched with the Desktop launcher save under:

```text
/Users/rohilverma/Desktop/HarnessWorkspace/sessions/CONVERSATION_UUID/history.jsonl
```

`/conversations` lists only the current workspace; it is not a machine-wide list.
Resume still requires the same canonical workspace/model path and ordered tool
definitions. Keep the saved header and existing records intact.

| Message or symptom | Next step |
| --- | --- |
| No saved completed task/checkpoint | Complete a successful task before selecting a checkpoint. |
| Unsaved attempts would be dropped | Continue the conversation, or intentionally use `--discard-unsaved`. |
| Conversation has a `writer.lock` | Exit its other writer first. An unclean exit can leave a stale lock; recovery is manual. |
| A conversation is unavailable | Read the reason printed by `/conversations`; a missing or corrupt log cannot be switched to. |
| Preparation failed | The runner stops. Use the printed conversation ID and error to investigate before resuming. |

The Desktop launcher opens two Terminal windows. Keep talking in the original
window: answers, tool commands/arguments/results, checkpoints and failures appear
there. The second window follows model loading, token counts, preparation and
inference timings. It never starts a second harness. Close it or press Ctrl-C
without stopping your conversation. Restart an existing harness to use this setup.

Each run saves a new visible log, normally under:

```text
/Users/rohilverma/Desktop/HarnessWorkspace/logs/model-YYYYMMDD-HHMMSS-PID.log
```

The chat terminal prints its exact path. Conversation switches keep using that
run log, with conversation-ID markers. These model diagnostics are separate
from `sessions/CONVERSATION_UUID/history.jsonl` and `conversation.md`.

To reopen the newest Desktop model log, double-click `ModelDiagnostics.command`
in HarnessWorkspace. To follow a specific log, pass the path printed at startup:

```sh
"/Users/rohilverma/Desktop/HarnessWorkspace/ModelDiagnostics.command" "/absolute/path/to/model.log"
```

Direct runner launches also write a per-run workspace log but do not open a
viewer automatically. `HARNESS_MODEL_LOG` overrides that path. If the diagnostics
window cannot open, chat continues and prints the log path. If writing the log
fails after startup, a warning appears and diagnostics fall back to the chat
terminal. Logs are kept until you delete them.

Optional backend-only protocol check, without loading a model:

```sh
printf '%s\n' '{"v":1,"id":"check","method":"ping","params":{}}' | "/Users/rohilverma/Desktop/harness/c/build/harness-sidecar"
```

The JSON response should contain `"ok":true` and `"status":"ready"`. This checks
the executable/protocol only; it does not prove the model loaded successfully.
