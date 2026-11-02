# Switchyard development

Keep Router, agent runtime profile, and session transport independent. The first
transport is Herdr; core state and scheduling must use opaque transport references.
Preserve durable write-ahead intents and conservative uncertain delivery handling.
Receipt acknowledgements never release a running input turn.

Use `npm ci`, `npm test`, and `npm run demo`. Tests must be hermetic: fake provider
and terminal subprocesses, isolated state, and scratch Git repositories with hooks
disabled. Never control a live terminal session or call a paid provider in tests.
Do not commit state databases, credentials, task prompts, tokens, or personal paths.
