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
