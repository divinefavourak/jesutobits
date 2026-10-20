# ADR-0012: Checkpoints and undo for agent edits

- **Status:** Accepted
- **Date:** 2026-10-19
- **Related:** docs/AGENT_HARNESS.md section 6, docs/DATA_AND_PERSISTENCE.md

## Context

Users must be able to undo what the agent did, including when the agent breaks the build (Journey 15). The user's own Git repository must not be touched without permission. Some projects have no Git repository at all.

## Decision

**MVP: tool-level pre-images.**

1. Before the first modification of a file within an agent **turn**, the Workspace Service stores the file's prior content (or "did not exist") as a content-addressed blob and records `{turnId, path, beforeHash, afterHash}`.
2. Every file-modifying tool (`write_file`, `edit_file`, `delete_path`, `move_path`, visual edits) goes through the Workspace Service, so coverage is complete for tool edits.
3. Users can revert a whole turn, a single file within a turn, or "everything since turn N". Revert checks each file's current hash equals the recorded `afterHash`. If the user or another process changed it since, Jesutobits shows the three versions and asks (keep current / restore pre-image / open diff).
4. **Command side effects are not checkpointed** (for example `npm install` changing `package-lock.json`, or a code generator writing files). After each command, the Workspace Service diffs a file-system snapshot of tracked paths (mtime + size scan, ignoring `node_modules`, `.git`, build output dirs) and records which files changed. The revert UI lists these as "changed by a command, cannot restore automatically" and, if the project is a Git repository, offers `git checkout -- <file>` with approval.

**Later (post-MVP): shadow repository.** A Git repository stored in the app data dir, using the project as its work tree (`GIT_DIR` outside the project), committed at turn boundaries. It would capture command side effects too. Deferred because of performance on large projects and the hard dependency on Git.

## Alternatives considered

| Option | Why not now |
|---|---|
| Commit to the user's Git repo after each turn | Pollutes history and surprises users. Allowed only as an explicit opt-in "auto-commit agent turns to a branch" setting later. |
| Git stash | Interacts badly with the user's own stashes and uncommitted work. |
| Full project copy per turn | Too slow and large. |

## Consequences

- Checkpoint blobs are garbage-collected when a session is deleted or after 30 days (configurable).
- The end-of-turn summary lists files changed by tools and files changed by commands separately.

## Revisit when

Users report losing work to command side effects, or revert conflicts become common.
