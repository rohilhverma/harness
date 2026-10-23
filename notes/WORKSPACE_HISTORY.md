# Coding workspaces, checkpoints and rewind

New conversations work in `sessions/<id>/workspace`, printed at startup. All
file tools and commands use that root. Use `AGENT_TEST.md` as a tool path.
New conversations seed eligible launch-folder files. An existing test file is
preserved; otherwise a default is supplied. Forks inherit the selected version.

The visible launch-folder `snapshots.git` is a separate local bare Git object
store. Git 2.36+ is required; no account or network is needed. Raw blobs/trees
preserve bytes without project commits, index, attributes, filters or checkout.
Identical contents are reused, objects are compressed and automatic packing can
add delta compression. Editable forks still consume independent copy space.
Snapshots are retained indefinitely; there is no deletion policy or storage quota.

## When data is saved

- Startup saves initial files/configuration as baseline #0, before any prompt.
- Each returned user turn saves one file snapshot paired with its messages,
  assistant tool calls and tool results. Success, error and length outcomes, and
  turns stopped at a call or tool limit, all count as completed turns in new
  coding conversations.
- Before rewind replaces files, one recovery snapshot preserves current files,
  including manual edits. The selected target snapshot already exists.
- Fork reuses and retains the selected tree without another file capture.
- Ordinary resume/switch does not take a snapshot or replace files.

A user turn includes all model/tool calls caused by one prompt. No snapshot is
published before each prompt or tool call. Provider exceptions and process crashes
leave an unfinished turn: live files remain, but its messages and intermediate
file versions are not guaranteed saved. Computed inference state is not persisted.

## Try the complete flow

1. Ask the agent to read `AGENT_TEST.md`; completed turn saves checkpoint #1.
2. Ask it to change the test word and reread it; this saves checkpoint #2.
3. Enter `/rewind 1`. The same conversation UUID and workspace path remain;
   files and active messages return to #1. Later checkpoint #2 remains saved.
4. Make a different edit. Its checkpoint receives the next unused number (#3),
   rather than overwriting #2. `/checkpoints` marks the active checkpoint.
5. Enter `/fork 2 blue`. Blue receives #2's files/messages in its own workspace.
   `/switch main` returns to main's existing workspace without restoring over it.

`/rewind 0` restores initial files and empty conversation history in the same
workspace. `/show N` reads any retained checkpoint. Forks have local numbering:
#0 is their selected initial file tree; #1 contains inherited messages, if any.
`--discard-unsaved` discards unfinished conversation messages only. Rewind still
captures current files first; fork/switch leave the departing files in place.

## Recovery and limits

`sessions/<id>/file-snapshots.md` lists reasons, times, tree IDs and retaining Git
refs. It is a readable index; history.jsonl checkpoints define message/file pairing.
Inspect a saved file from the launch folder by substituting an actual tree ID:

```sh
git --git-dir=snapshots.git show TREE_ID:AGENT_TEST.md
```

Objects and retaining refs are saved before paired history markers. Failed capture
cannot publish a completed checkpoint. Rewind verifies target objects and exclusion
conflicts before replacing files. It flushes a temporary journal and atomically publishes `rewind.pending.json`, restores
and flushes files, then appends/syncs the history rewind marker and removes the
journal. The session writer lock remains held; no tools run during restoration.

On locked resume, a validated completed rewind marker permits journal cleanup
without restoring again, preserving subsequent manual edits. An incomplete rewind
first captures exceptional `interrupted-rewind` recovery files, then restores its
pre-rewind state and removes the incomplete history tail. Unexpected journal/history
contents or unsupported live files fail explicitly before automatic replacement.
This exceptional recovery capture is not part of ordinary resume cadence. A failed
rewind stops the runner; resume the printed conversation UUID to recover.

Captured: regular file bytes, executable status and directories, including empty
directories. Each file is bounded at 16 MiB. Excluded everywhere: `.git`,
`node_modules`, `build`, `dist`, `.DS_Store`; excluded at workspace root: `sessions`,
`logs`, `snapshots.git` and its initialization directories. Reserved exclusions are
case-insensitive. Session storage must use canonical lowercase `sessions` without
links/case aliases. Links and special files outside exclusions are rejected.

Rewind preserves excluded data. A missing target directory, file/directory change
or case-rename conflict involving excluded descendants is rejected before replacement. Other permissions, ownership, extended attributes,
timestamps, dependencies, excluded outputs and external command effects are not
restored. Commands remain trusted local programs, not an OS sandbox. Capture and
restore require no concurrent external writes; multi-file replacement is not atomic.
Git command discovery cannot accidentally reach the launch repository. Project Git
metadata is excluded; a new workspace has no Git working repository unless you
initialize one there. A missing workspace fails rather than silently recreating it.

Older v1 conversations and their branches remain history-only with their shared
root, successful-task checkpoint policy and existing per-session test-file paths.
There are no authentic past file snapshots for those sessions. Start a new
conversation to test coding workspaces and in-place file rewind.
