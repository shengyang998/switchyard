# Switchyard

A local Router/Worker supervisor for long-running coding tasks. Send natural-language input, route it to a new or existing task, and continue the same worker in its own Git worktree after restarting the supervisor.

Router, agent runtime, and session transport are separate choices. v0.1 ships a Codex structured-exec router and a generic JSON command router; Herdr is the first session transport. Herdr can launch Codex, Claude, or another supported interactive agent. Codex is a default profile, not a requirement.

This is an early single-host CLI MVP. It does not merge, publish, push, or install a daemon. Worker completion is an explicit report with evidence; a terminal becoming idle never completes a task.

## Try it offline

Requirements: Node **22.19+**, npm, and Git. Native `node:sqlite` is used; the CLI hides its experimental warning. No runtime npm dependencies.

```sh
npm ci
npm test
npm run demo
node dist/cli.js --help
```

The deterministic demo runs two tasks, queues a follow-up while the first is active, receives reports, then restarts and reuses the same worker/session/worktree. It uses a command router and a **non-Codex (Claude) worker profile** through fake Herdr subprocesses, plus real temporary Git worktrees. It requires no account, network, running Herdr server, or API key, and removes its temporary files. Tests also cover Herdr outages, restarts and agent exits (rebind, respawn, refusals), close/drop/gc refusals and resumption, the disk guard, v0.1 state migration, ambiguous create/start/send, interrupted outbox writes, identity changes, duplicate/stale reports, malformed routing, concurrent supervisors, spaces in paths, and subprocess limits.

### Live Herdr smoke test (opt-in)

```sh
HERDR_BIN=/path/to/herdr npm run smoke:herdr
```

This drives a **real Herdr server** in its own named session with a scratch HOME, repository and state: two tasks and a `sy "#1 …"` follow-up, a Herdr restart while `serve --format text --notify` runs with a turn in flight, `resolve` and an agent exit followed by `recover 1 --respawn`, both applied by the running supervisor, then `close` and `gc --merged`. It also checks the supervisor's text log and that Herdr accepted every notification. The worker is a deterministic stand-in (`scripts/live-herdr/agent.mjs`) that Herdr detects as `codex` and that reports its session the way Herdr's Codex integration does, so no model, account or network is used. Only for this isolated session does it run Switchyard outside a pane with `HERDR_ENV=1`, through a wrapper pinned to the test session. It is not part of `npm test`. `SMOKE_KEEP=1` keeps the scratch directory; `SMOKE_HOLD=1` leaves a failed run's session up for inspection. Last passed against Herdr 0.9.5.

## Everyday use

You need Herdr and an installed, authenticated agent CLI (Codex by default); [Use with Herdr](#use-with-herdr) lists versions, defaults and the sandbox flags workers get. Build once and put `sy` (also installed as `switchyard`) on your PATH:

```sh
npm ci && npm run build && npm link
```

Keep this checkout where it is: workers call its `dist/cli.js` to report. Then, inside your project (it needs at least one commit):

```sh
sy init      # once per repository; state goes to ~/.local/state/switchyard/<repo>-<hash>
sy up        # in a Herdr pane: the supervisor; leave it running (Ctrl-C stops it)
```

From any other pane, anywhere in the project (subdirectories and task worktrees included):

```sh
sy "Add a JSON export command"        # → new task #1 "Add a JSON export command"
sy "#1 also include timestamps"        # straight to task #1, no Router call
sy                                     # inbox
sy show 1                              # timeline, reports with evidence, next steps
sy diff 1                              # the worker's changes against the initialized base commit
```

The inbox sorts tasks by what they need from you:

```text
Switchyard · ~/code/app · supervisor running (pid 4242)

Needs you
  #2    Add CSV import               3m  blocked: Which delimiter should be the default?  → sy "#2 <answer>"
  #4    Fix flaky login test         1h  worker exited; its session is saved  → sy recover 4 --respawn

In progress
  #3    Upgrade the HTTP client     40s  progress: tests are running

Ready for review
  #1    Add a JSON export command    5m  Export added with tests; npm test passes  → sy diff 1

2 closed task(s) not shown
```

- **Sending work.** `sy "text"` records the input and routes it immediately: if `sy up` is running, that supervisor routes it; otherwise this command does, so the Router is never called twice. It prints the outcome: a new task, a follow-up to an existing one, the Router's reply, or a routing error with the `retry-route` command. `#N text` targets task N directly. A single word is treated as a mistyped command; send it with `sy -- word`. `submit` keeps its persist-only behavior for scripts.
- **Task references.** Tasks get short numbers in creation order. Anywhere a task is expected, `#2`, `2`, the full task ID or a unique prefix of it works, as an argument or with `--task`.
- **Finding state.** `--state DIR` wins, then `SWITCHYARD_STATE` (set in every worker pane), then a `.switchyard/` directory or the state owning the task worktree you are in, then the per-repository default for the current Git repository (found from linked worktrees too). `sy init` uses `$XDG_STATE_HOME/switchyard/<repo>-<hash>` (`~/.local/state` without XDG), which is private and outside the repository, so nothing needs to be added to `.gitignore`.
- **Supervisor output.** `sy up` prints one line per change you care about (`12:04:31 #1 Add a JSON export command: ready for review · Export added  → sy diff 1`), plus Herdr outages and Router replies, and raises a Herdr notification when a task starts needing you, becomes ready for review, or fails (`--no-notify` turns that off). `serve` is the same loop for scripts: JSON, printed only when the state changes; `serve --notify` adds notifications.
- **Output format.** Commands print text on a terminal and JSON otherwise. Force either with `--json` or `--format text|json`. `status`, `history` and `report` are always JSON.
- **While `sy up` runs.** `recover`, `recover --respawn`, `resolve`, `close`, `drop` and `gc` all work without stopping it: they either apply directly or queue a request that the running supervisor executes between passes. Only explicit `recover --ref --session` adoption still needs the supervisor stopped.
- **Disk.** `sy du` shows what each task's worktree holds; `sy close N` and `sy drop N` reclaim one task; see [Reclaiming disk space](#reclaiming-disk-space).
- **Finishing.** Review with `sy diff N`, merge the task branch yourself, then `sy gc --merged`. Nothing is merged, pushed or deleted automatically.

## Use with Herdr

Install/authenticate your chosen agent CLI yourself. The checked adapter targets **Herdr 0.8 protocol 19** and Codex CLI **0.165**. `close`/`drop` and restart continuity additionally use `pane get`, `pane close` and `pane report-agent-session`, plus Herdr's `server_unavailable`/`agent_not_found` error codes; these were checked live against Herdr 0.9.5 (protocol 22) with the smoke test above, where the other fields the adapter reads are unchanged. Run the supervisor **inside a Herdr-managed pane** (`HERDR_ENV=1`) so commands target that session. Switchyard will create a background workspace for each task; it does not control an unrelated focused pane. It refuses Herdr control outside that environment. Do not set this variable artificially to bypass the check.

Build first. The target repository must have a commit. Without `--state`, `sy init` uses the private per-repository directory described in [Everyday use](#everyday-use), outside the repository. If you pick a directory yourself, keep it private and outside the repository, or add it to the repository's `.gitignore`. State contains task text, tokens, database files, and worktrees; never commit it.

The same flow with explicit paths, as scripts would run it:

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

`submit` durably records input and returns immediately (unlike `sy "text"`, it never routes); `run` routes pending inputs and performs one scheduling pass. Repeat `run`, or use foreground `serve`. `--passes` is bounded (serve defaults to 100000 passes); Ctrl-C requests a graceful stop after the current bounded subprocess finishes. The default subprocess timeout is 120000ms (`init --timeout MS`). `status` and `history` only read local state. Explicit `--task` bypasses the Router. Repeating an input ID with identical text and target is idempotent; conflicting reuse fails.

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

Recovery verifies the exact worktree path/branch and the saved pane, agent kind, cwd and native session. A supervisor restart reuses saved identities. `recover`, `recover --respawn` and `resolve` work while `serve`/`sy up` runs: re-verification and respawn are queued as durable requests that the supervisor applies between passes (the command waits for the outcome), and `resolve` records your decision for it. Only `--ref`/`--session` adoption needs the supervisor stopped. Tasks can be given as `#N`, `N`, a full ID or a unique prefix, positionally (`recover 3 --respawn`) or with `--task`.

### Herdr restarts, outages and agent exits

- **Herdr unreachable.** `serve`/`run` keep routing input, but launches, dispatch and lifecycle requests wait; nothing is frozen. Their output carries `transport: {ok: false, error}` until the server is back.
- **Herdr restarted.** Herdr restores the panes and resumes each agent on its saved session in a new terminal. Switchyard accepts the new terminal only if pane, agent kind, worktree cwd and the saved native session all match, and records `rebind` in `history`. A turn that was in flight becomes `uncertain`, because the process handling it is gone; it is never resent. A late report from the resumed worker still completes it, otherwise decide with `resolve` (below).
- **Launch arguments survive.** Herdr's own restore runs only `codex resume ID`, dropping `--sandbox`, `--add-dir STATE` and other worker args. After each launch, respawn or rebind Switchyard reports the pane's resume command to Herdr (`pane report-agent-session --source switchyard -- codex resume ID <worker args>`), so a restored worker keeps them. This is best effort: a failure is audited as `pin-failed` and the restored worker may ask for approval before its first report. If you start a different conversation in a worker pane yourself, Herdr still restores the task's session there after a restart.
- **Agent exited.** The task keeps `provision: started` with `error: "No agent in worker pane …"`; dispatch waits and an in-flight turn becomes `uncertain`. Resume the same session:

  ```sh
  node dist/cli.js --state /path/to/private-state recover --task TASK_ID --respawn
  ```

  This starts the agent with its kind's resume command plus the configured worker args (override with a `worker.resume` argv containing `{session}`). It uses the saved pane when that pane is an idle shell in the task worktree, or a new background workspace when the pane is gone. It refuses a pane holding another agent or session, or one whose cwd has moved. The launch is write-ahead like the first one: an interrupted or ambiguous respawn, or an agent that comes back on a different session, freezes the task. Respawn never starts a fresh conversation for an existing task and never rotates its token.

Anything that is not one of these cases fails closed: a different session, agent kind or cwd, a worktree/branch mismatch, or an interrupted create/start freezes provisioning as `unknown`. After checking the pane yourself, re-verify read-only against the saved pane and session (this also repairs tasks frozen by an outage under earlier versions):

```sh
node dist/cli.js --state /path/to/private-state recover --task TASK_ID
```

A launch whose identity was never observed can be adopted explicitly after you verify it:

```sh
node dist/cli.js --state /path/to/private-state recover --task TASK_ID \
  --ref '{"pane":"RETURNED_PANE_ID"}' \
  --session '{"agent":"codex","kind":"id","value":"OBSERVED_SESSION_ID"}'
```

Saved reference or session mismatches are rejected. For an ambiguous creation with no saved reference, first inspect the workspace list to identify the original workspace, then start/verify its worker as needed before adoption. Do not edit the database to reuse a token with a different worker; start a separate task instead.

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

`du` counts allocated bytes inside Switchyard worktrees and the state database. It does not see caches that agents or tools write elsewhere (Xcode DerivedData, `~/.cargo`, package-manager caches, Docker); clean those with their own tools. `serve` prints a status object only when something changed and `sy up` one line per change, so a redirected log grows with activity, not with uptime.

State is for **one trusted local user on one host**. A SQLite transaction records a PID/hostname supervisor lock; a live PID is never displaced, even after long pauses. PID reuse can conservatively require operator investigation. No shared/network filesystem, multiple host supervision, or hostile-worker isolation is supported. Tokens prevent stale/misassigned reports, not malicious access: workers can read writable state and tokens appear in their prompt/process argv. Protect the state directory and do not route untrusted projects without your own isolation.

See [architecture and adapter notes](docs/architecture.md), [contributing](CONTRIBUTING.md), and [MIT license](LICENSE).
