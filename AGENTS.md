# CompanyOS agent instructions

## Scope

CompanyOS is the private command center for exactly three projects:

- Sky Mountain Cloud
- Plenty of Plants
- Sky Mountain Graphics

Do not add other projects to seed data, dashboards, or agent defaults unless the owner explicitly requests it.

## Architecture

- PostgreSQL is the system of record for structured state.
- Next.js is the command-center UI and server API boundary.
- Integration adapters belong under `lib/integrations/`.
- External services write normalized records to `external_records` and operational signals to `events` / `system_checks`.
- Secrets must remain server-side and encrypted when stored in PostgreSQL.
- Never hard-code credentials or access tokens.
- Keep provider-specific code behind adapters so OpenAI/Claude/local models remain replaceable.

## Security

- Prefer read-only integration scopes.
- Production write operations require explicit owner approval.
- Do not disable TLS verification globally.
- Do not expose PostgreSQL directly to the Internet.
- Do not log OAuth tokens, API tokens, passwords, or encryption keys.
- Validate and bound webhook payloads; use idempotency keys for external events.

## v0.4 goals

1. Local Google OAuth for Gmail + Calendar.
2. Server-side collectors for GitHub, Proxmox, and Nextcloud.
3. Signed event ingestion for n8n/Firebase bridges.
4. Normalized external records and sync history.
5. Keep the Command Center useful even when integrations are disconnected.

## v0.5 guardrails

- PostgreSQL remains the system of record for agent hierarchy, policy metadata, tasks, and agent runs.
- Free ChatGPT and Claude use owner-mediated manual handoff; do not claim consumer subscriptions are API credentials. Codex CLI can execute locally with its own sign-in under the isolated runner profile.
- Model runs may receive only the assigned agent's bounded `memory_scope` snapshot. Supported scopes are `project`, `tasks`, and `systems`; do not include Gmail, Calendar, or other external communications in this context by default.
- Do not expose direct database credentials or unrestricted system tools to models. `request_task_creation`, `request_task_status_change`, and `request_task_delegation` only submit bounded proposals; the server checks the agent permission and the owner must approve before a task is created, changed, or delegated.
- Deterministic code should handle predictable routing, health checks, calculations, and workflow state changes.
- Agent memory scope is enforced by the task-context loader. Keep allowed actions, prohibited actions, escalations, and KPIs descriptive until a server-side tool registry actively enforces them.
