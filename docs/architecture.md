# Architecture

The core owns SQLite tasks, input events, routing decisions, delivery attempts, reports, and audit records. Router, agent runtime profile, and session transport are separate layers:

```text
submit -> durable input -> Router -> reply | new task | follow-up
                                           |
                         task branch/worktree + one persistent worker
                                           |
                   WorkerTransport (Herdr first) -> agent kind + argv
                                           |
                         correlated ack/progress/final reports -> SQLite
```

`src/adapters.ts` defines the `WorkerTransport` contract: `create` returns an opaque reference, `start` launches the independently selected agent, `inspect` returns opaque instance/session identities and transport readiness, `send` transmits an input envelope. The core stores these identities and never interprets Herdr pane syntax. A future adapter must preserve intent/result boundaries and all uncertainty semantics. Merely replacing terminal commands is insufficient if identity or acknowledgement capabilities differ.

The Herdr adapter reads `.result.root_pane.pane_id` from workspace creation, uses that pane as the target rather than a live alias, and records `.result.agent.terminal_id` plus canonical `agent_session:{agent,kind,value}`. Both `id` and `path` session kinds are opaque strings. Every inspect checks agent kind and foreground/current cwd against the task worktree. Every dispatch checks instance/session identity and requires interactive readiness plus idle/done. Those states gate input only; they never establish task completion. Missing or changed identity fails closed.

Launch stages are persisted before side effects: `new -> worktree -> creating -> created -> starting -> started`. Git worktree creation can reconcile by exact registered path/branch; Herdr create/start without a known successful result becomes `unknown` on restart. A known created pane can continue start once; an interrupted start cannot repeat. All external processes receive argv arrays without shell interpolation. Structured Router output is validated before a transaction creates a task or assigns an event.

Outbox state precedes prompt submission: delivery `sending` and task `inflight` are committed together. Success becomes `sent`, a correlated report becomes `confirmed`, and unobserved outcomes become `uncertain`. Process failure alone does not prove absence of delivery. Every attempt preserves the stable event ID; explicit operator-approved retry appends a new attempt. Worker receipt/final reports can race the send result safely: send callbacks only update still-`sending` records. Reports transact their token/current-input checks and event/task updates. A final report is the only automatic turn release.

The supervisor lock is acquired transactionally with owner UUID, PID, hostname and timestamp. Only a demonstrably nonexistent same-host PID can be removed. A live/permission-inaccessible PID blocks takeover; there is no lease expiry that lets a paused previous owner resume dispatch after losing ownership. Crash recovery runs after lock acquisition. Report/submit commands may write concurrently; SQLite immediate transactions serialize their changes. This is local-only coordination, not a distributed lease.

## Adapter assumptions and limits

Checked against installed Codex 0.165 help and Herdr 0.8 protocol 19 bundled schema. No live Herdr agents or paid model calls were used to validate this repository. Offline subprocess fixtures validate command construction, JSON envelopes, alternate profiles, state transitions and recovery. Real-agent reliability also depends on configured integration hooks, provider login, trust prompts, permissions, model behavior and the worker following reports. A report's evidence is recorded, not independently verified.

The built-in Codex Router uses supported structured non-interactive output and installed authentication. See [official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode). It is intentionally stateless; business state stays in SQLite. The Router does not need the Worker's provider. A command Router can be any process, including a rule-based or remote-model wrapper, so long as classification is side-effect free.

Terminal pane/session inspection cannot prove an arbitrary process's identity cryptographically. Saved instance, session, agent kind, cwd and opaque stable pane reference together are the available Herdr checks. The MVP never reconstructs a dead agent from its session ID. Explicit adoption can bind an initially unobserved launch only after operator verification. Replacing an already saved worker identity requires future generation rotation, not blind token reuse.

Worktree lifecycle, final user acceptance, branch merging, cancellation of active agents, token rotation, schema migration, report redaction, automatic task expiry, and daemon installation are outside v0.1. Stop supervision gracefully; no `server stop`, pane close, agent kill, focus change, or unrelated terminal control is performed. State/config must stay at their initialized paths; copy/move migration is not implemented. This early schema is not migration-stable.

## Other transports: feasibility research

**tmux is feasible** as a session/message transport. Its official [control mode](https://github.com/tmux/tmux/wiki/Control-Mode) exposes command responses and pane output streams. It would need a `WorkerTransport` implementation with stable session/pane references, runtime detection/readiness, and the same explicit report protocol: terminal output or idle detection still cannot acknowledge business completion. This alternative is researched, not implemented or live-tested here.

**Headless is feasible**, but means replacing the terminal with process supervision and a provider protocol adapter. Codex [app-server](https://learn.chatgpt.com/docs/app-server) supports thread/turn lifecycle APIs; Claude's [headless interface](https://code.claude.com/docs/en/headless) supports structured streams and resumption. These are different protocols that require provider-specific handling, durable identities and crash semantics. They do not require Herdr/tmux, but they still require a transport and lifecycle implementation. v0.1 ships Herdr only, keeping this boundary explicit for later work.
