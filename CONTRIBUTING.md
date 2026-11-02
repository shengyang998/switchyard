# Contributing

Use Node 22.19+ and `npm ci`. Run `npm test` and `npm run demo` before submitting changes. Tests must use isolated subprocess fixtures and scratch Git repositories; never run real agent, broker, production, message-sending, or remote-write commands as tests.

Keep Router, agent runtime profile, and transport independent. Preserve stable input IDs and write-ahead intents. Never infer task completion from terminal status, resend uncertain delivery automatically, or let receipt acknowledgement release a running turn. New transports must document identity/readiness guarantees and test interrupted create/start/send plus report races.

Do not include runtime SQLite files, worktrees, tokens, provider credentials, personal paths, actual prompts or session transcripts in commits. Change the maintained source, not `dist` or dependencies. There are no required global configuration changes. New dependencies need a concrete purpose; runtime currently uses only Node and Git plus user-installed provider/transport CLIs.

This repository is prepared for later open-source publication; no remote or publication is configured by setup. Code is MIT licensed.
