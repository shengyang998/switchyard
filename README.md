# Switchyard

A local Router/Worker supervisor for long-running coding tasks. Send natural-language input, route it to a new or existing task, and continue the same worker in its own Git worktree after restarting the supervisor.

Router, agent runtime, and session transport are separate choices. v0.1 ships a Codex structured-exec router and a generic JSON command router; Herdr is the first session transport. Herdr can launch Codex, Claude, or another supported interactive agent. Codex is a default profile, not a requirement.

This is an early single-host CLI MVP. It does not merge, publish, push, or install a daemon. Worker completion is an explicit report with evidence; a terminal becoming idle never completes a task.

## Try it offline

Requirements: Node **22.19+**, npm, and Git. Native `node:sqlite` may print an experimental warning on some supported Node versions. No runtime npm dependencies.

```sh
npm ci
npm test
npm run demo
node dist/cli.js --help
```

The deterministic demo runs two tasks, queues a follow-up while the first is active, receives reports, then restarts and reuses the same worker/session/worktree. It uses a command router and a **non-Codex (Claude) worker profile** through fake Herdr subprocesses, plus real temporary Git worktrees. It requires no account, network, running Herdr server, or API key, and removes its temporary files. Tests also cover close/drop/gc refusals and resumption, the disk guard, v0.1 state migration, ambiguous create/start/send, interrupted outbox writes, identity changes, duplicate/stale reports, malformed routing, concurrent supervisors, spaces in paths, and subprocess limits.

## Use with Herdr

Install/authenticate your chosen agent CLI yourself. The checked adapter targets **Herdr 0.8 protocol 19** and Codex CLI **0.165**. `close`/`drop` additionally use `pane get` and `pane close`, checked against Herdr 0.9.5 (protocol 22), where the other fields the adapter reads are unchanged. Run the supervisor **inside a Herdr-managed pane** (`HERDR_ENV=1`) so commands target that session. Switchyard will create a background workspace for each task; it does not control an unrelated focused pane. It refuses Herdr control outside that environment. Do not set this variable artificially to bypass the check.

Build first. The target repository must have a commit. Choose a private, external state directory, or add `.switchyard/` to the target repository's `.gitignore` before using the default. State contains task text, tokens, database files, and worktrees; never commit it.

```sh
npm run build
# Run these from this checkout; replace paths with your own absolute paths.
node dist/cli.js --state /path/to/private-state init --repo /path/to/project --concurrency 2
node dist/cli.js --state /path/to/private-state submit "Add a JSON export command" --id export-request-1
node dist/cli.js --state /path/to/private-state run
node dist/cli.js --state /path/to/private-state status
node dist/cli.js --state /path/to/private-state submit "Also include timestamps" --task TASK_ID --id export-request-2
node dist/cli.js --state /path/to/private-state serve --interval 2000 --passes 100
```

`submit` durably records input and returns immediately; `run` routes pending inputs and performs one scheduling pass. Repeat `run`, or use foreground `serve`. `--passes` is bounded (serve defaults to 100000 passes); Ctrl-C requests a graceful stop after the current bounded subprocess finishes. The default subprocess timeout is 120000ms (`init --timeout MS`). `status` and `history` only read local state. Explicit `--task` bypasses the Router. Repeating an input ID with identical text and target is idempotent; conflicting reuse fails.

The `--model` option sets the Router model only; worker models follow their own profile/argv. Default Router: `codex exec --json --ephemeral --ignore-user-config --sandbox read-only`, with a strict output schema and model `gpt-6.1-sol` (override `init --model MODEL`). It reuses installed CLI authentication, not a separately configured API client. Router instructions prohibit tools, but this is a prompt constraint plus a read-only sandbox, not a separate security boundary. Project instructions/rules may still apply. No global CLI configuration is changed.

Default Codex worker arguments: `--sandbox workspace-write --ask-for-approval on-request --add-dir STATE --no-alt-screen`. Interactive approvals, trust onboarding, or agent questions may require you to visit its pane. Switchyard never bypasses approvals. Worktrees start from the repository's HEAD captured at initialization; uncommitted main-checkout edits are not copied. Task branches are `switchyard/task_…`. Keep the built checkout at its initialized path so workers can invoke the report CLI.

## Replace the Router or agent

Router and worker are independently selectable at initialization. `config.json` in state is a human-readable snapshot; SQLite is authoritative. Reinitialize a fresh state directory to change profiles in this release.

```sh
node dist/cli.js --state /path/to/other-state init --repo /path/to/project \
  --router-command '["/path/to/my-router","--json"]' \
  --worker-kind claude --worker-args '["--permission-mode","manual"]'
```

The command Router receives one JSON object on stdin:

```json
{"tasks":[{"id":"task_…","title":"Export","status":"active"}],"input":"Also include timestamps"}
```

It must exit 0 with **only** one JSON object on stdout (diagnostics on stderr):

```json
{"action":"followup","task":"task_…","title":"","reply":""}
```

All four keys are required; extra keys fail validation. `action` is `new`, `followup`, or `reply`. `followup` requires an existing supplied task ID; the others require `task:null`. New work requires a nonempty title. A reply is persisted without launching a worker. Exit failures/invalid output leave the input `route-error` with an error and no task creation. Repeated supervisor passes do not retry paid/model calls; explicitly run `retry-route --event INPUT_ID` after fixing the problem. This is safe only for a side-effect-free Router. Output and time are bounded.

`--worker-kind` is a Herdr-supported kind; `--worker-args` is a JSON argv array forwarded after `herdr agent start … --`. Alternate kinds get **no Codex arguments**. Configure their permissions to allow the worktree and the report CLI/state writes. Every agent must follow the same report protocol. Herdr must expose a matching `agent_session` identity (`id` or `path`); without it Switchyard freezes safely. A launchable Herdr kind alone does not guarantee its integration provides this capability. The offline alternate profile proves pluggability, not live Claude compatibility certification.

## Reports and recovery

Every input envelope contains task ID, input ID, a per-worker token, and the exact JSON argv for `report`. The worker sends `ack` on receipt, optional `progress`, and one final `ready`, `blocked`, or `failed` report with a summary and evidence. Report IDs must be unique; identical repeats are idempotent. Only the current assigned input and token are accepted. Acknowledgement confirms delivery but keeps the worker busy. Final reports release the turn; a queued follow-up then reopens that task when the transport is ready. No mid-turn steering is attempted.

`--concurrency` limits **active input turns**, not total retained terminal panes. Ready/blocked workers remain available for later follow-ups. An uncertain delivery keeps its slot occupied. Retained panes and worktrees stay until you reclaim them explicitly; see [Reclaiming disk space](#reclaiming-disk-space).

```sh
node dist/cli.js --state /path/to/private-state recover
node dist/cli.js --state /path/to/private-state history
```

Recovery verifies exact worktree path/branch and saved transport instance/session. It never creates a replacement worker for a missing one. A process restart reuses saved identities. Interrupted create/start calls, missing integration identity, or changed occupants freeze provisioning as `unknown`. Inspect the saved task and Herdr pane yourself. If the original worker is verified, explicitly adopt its opaque reference and canonical session identity:

```sh
node dist/cli.js --state /path/to/private-state recover --task TASK_ID \
  --ref '{"pane":"RETURNED_PANE_ID"}' \
  --session '{"agent":"codex","kind":"id","value":"OBSERVED_SESSION_ID"}'
```

Saved reference, instance, or session mismatches are rejected. For an ambiguous creation with no saved reference, first inspect the workspace list to identify the original workspace, then start/verify its worker as needed before adoption. The MVP does not replace dead sessions or rotate worker generations. Repair/recover the original identity or start a separate task; do not edit the database to reuse a token with a different worker.

A prompt timeout/nonzero exit can mean text was delivered. Such inputs become `uncertain` and are **never automatically replayed**. A correlated worker report resolves the uncertainty. Otherwise inspect the original pane/session and explicitly decide:

```sh
node dist/cli.js --state /path/to/private-state resolve --event INPUT_ID --action delivered
# Only after confirming the original input was not delivered/acted upon:
node dist/cli.js --state /path/to/private-state resolve --event INPUT_ID --action retry
```

`delivered` keeps the input active awaiting its report. `retry` keeps the same input ID and appends a delivery attempt; it cannot undo effects from the original prompt. Resolution requires the worker to reconcile first. There is no automatic timeout that frees business work.

## Reclaiming disk space

Each task keeps a full checkout plus whatever its builds leave in it (`node_modules`, `target/`, `build/`, ...) until you reclaim it. Nothing is deleted automatically.

```sh
node dist/cli.js --state /path/to/private-state du                 # per-task bytes, dirty flag, free space, gc --merged estimate
node dist/cli.js --state /path/to/private-state close --task TASK_ID
node dist/cli.js --state /path/to/private-state drop --task TASK_ID [--into main]
node dist/cli.js --state /path/to/private-state gc --merged --dry-run
node dist/cli.js --state /path/to/private-state gc --merged [--into main]
```

- `close` closes the task's worker pane, removes its worktree, and **keeps the branch**. Commits stay reachable; the task leaves Router candidates and no longer accepts `submit --task`, `recover`, or scheduling.
- `drop` does the same and then deletes `switchyard/task_…` only if it is merged into `--into` (default: the main checkout's `HEAD`). Merged means an ancestor, or every commit patch-equivalent (cherry-picked/rebased). It prints the deleted commit and `git branch NAME SHA` to restore it. A squash merge is not detectable this way; use `--discard-unmerged` after checking.
- `gc --merged` drops every task with no active or queued input whose worktree is clean and whose branch is merged, including tasks you already closed. It prints why each other task was kept. Blocked tasks are kept because they wait for you. Use `--dry-run` first.

Refusals happen before any side effect. Uncommitted or untracked changes need `--discard-changes`. An active or queued input needs `--abandon`, which marks it `abandoned`, releases its concurrency slot, and makes any late report stale. Abandoning does not stop the agent's current action; it only closes its pane if verified. Branches checked out elsewhere are never deleted. Files ignored by Git (build output) are removed with the worktree without a flag.

A pane is closed only when Herdr's `pane get` still reports the saved terminal ID. A changed occupant is reported as `unverified` and left open; a missing pane is `absent`. The intent is recorded as `closing`/`dropping` before any Herdr or Git call. A failed step leaves the task in that state, out of scheduling, and rerunning the same command resumes it. If `serve` is running, these commands queue a durable request that the supervisor applies between passes, so there is never a second writer.

**Disk guard.** Before creating a worktree or sending a turn, the supervisor checks free space on the filesystems holding state, worktrees, and the repository. Below `init --min-free-mb` (default 10240; 0 disables), the input stays `queued` with a `Disk guard` error and one audit record; it continues once space is freed. Existing turns are not interrupted. To change the threshold on existing state, reinitialize in a new state directory.

`du` counts allocated bytes inside Switchyard worktrees and the state database. It does not see caches that agents or tools write elsewhere (Xcode DerivedData, `~/.cargo`, package-manager caches, Docker); clean those with their own tools. Redirecting `serve` output to a file also grows without bound: each pass prints the full status.

State is for **one trusted local user on one host**. A SQLite transaction records a PID/hostname supervisor lock; a live PID is never displaced, even after long pauses. PID reuse can conservatively require operator investigation. No shared/network filesystem, multiple host supervision, or hostile-worker isolation is supported. Tokens prevent stale/misassigned reports, not malicious access: workers can read writable state and tokens appear in their prompt/process argv. Protect the state directory and do not route untrusted projects without your own isolation.

See [architecture and adapter notes](docs/architecture.md), [contributing](CONTRIBUTING.md), and [MIT license](LICENSE).
