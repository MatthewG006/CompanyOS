# Sky Mountain CompanyOS — Command Center v0.6

A provider-neutral operating system for a single command center covering exactly:

- Sky Mountain Cloud
- Plenty of Plants
- Sky Mountain Graphics

## What v0.4 adds

- Local Google OAuth for Gmail + Google Calendar
- Encrypted PostgreSQL secret storage for OAuth tokens
- Gmail message normalization
- Calendar event normalization
- GitHub repository and optional issue/PR collection
- Proxmox node health collection
- Nextcloud health collection
- Signed event ingestion for n8n/Firebase bridges
- Idempotent webhook events
- Sync-run history and integration errors
- Integration control panel with manual sync
- External record cache and dashboard counts

## What v0.5 adds

- PostgreSQL-backed agent run lifecycle and result history
- OpenAI, Anthropic, and Ollama model adapters configured server-side
- Copy/paste task handoff for ChatGPT Free, Claude Free, and Codex
- Isolated Codex CLI task execution with scoped Company Brain memory
- Approval-backed task creation, status updates, and direct-report delegation
- Durable PostgreSQL queue for delegated Codex task runs
- Owner-managed shared project memory and agent execution health

## What v0.6 adds

- Owner-only sales pipeline across the three configured projects
- Project-linked opportunities with normalized contacts, stage, estimated value, follow-up date, and owner notes
- Audited opportunity creation and updates in the Company Brain event stream
- Customer onboarding checklists and internal Support tasks created when an opportunity is marked Won
- Deterministic, idempotent Sales follow-up tasks created when scheduled dates become due
- Owner can complete reminder tasks in the Sales pipeline; rescheduled/closed opportunities retire active reminders
- Owner-managed Support Desk cases with project/contact links, status history, and internal Support tasks
- Support cases queue a Support-agent triage run; the owner can explicitly enable case-only memory and approval-gated case status proposals
- Support Desk summarizes open workload and case age, refreshing agent-run progress automatically
- Support case descriptions remain owner-only and are excluded from agent prompts
- Owner-only financial ledger for income and expenses, with project/category/date attribution and auditable voiding
- Owner-reviewed CSV import stages bank transactions, flags possible duplicates, and records entries only after a per-row owner decision
- Recorded ledger totals feed month-to-date revenue and expense metrics; financial entries remain outside agent prompts
- Finance agent may propose a sales-income entry from confirmed Gmail billing evidence; owner approval is required before ledger insertion
- Sales agent can propose a lead from unread Gmail sales inquiries; owner approval creates the pipeline record and internal next-day follow-up
- Sales contact details stay excluded from model context by default
- Sales agent may draft an email only for an active project lead when owner enables its sales-memory and outreach permissions
- Due Sales follow-ups can queue a lead-specific Sales-agent run for an owner-reviewed email draft
- Owner approval queues the exact email in PostgreSQL; the worker sends after commit with bounded retries, stable Gmail Message-ID deduplication, opt-out checks, and delivery status in Communications
- Sales pipeline can record evidence-backed email/WhatsApp consent; WhatsApp delivery remains disabled until a Business Platform connector is configured

## Architecture

ChatGPT and Claude are workers, not the system of record. CompanyOS owns structured state in PostgreSQL. Integrations write normalized records to `external_records` and operational signals to `events` / `system_checks`.

The local CompanyOS app does not reuse a ChatGPT Gmail/Calendar connection. Google OAuth is configured independently so the command center can access its own data source.

## Requirements

- Node.js 20.9+
- Docker Desktop for the included PostgreSQL container
- Git (recommended)

## Run locally

```powershell
npm install
Copy-Item .env.example .env.local
npm run db:up
npm run db:migrate
npm run db:seed
npm run dev
```

Open `http://localhost:3000`.

To process agent work continuously, open a second terminal in the project and start the worker:

```powershell
npm run agents:worker
```

The worker claims queued `codex-cli` runs, including approved delegations and new Gmail follow-ups. The AI Workforce page also lets you run one queued task on demand. Neither path falls back to paid API providers. Install and sign in to Codex CLI on the CompanyOS host first; see `docs/ai-router.md` for the flow and security boundary.

## Local environment setup

Generate a 32-byte encryption key:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Put it in `.env.local` as `COMPANYOS_ENCRYPTION_KEY`.

For Google OAuth, see `docs/google-oauth.md`.

For GitHub, Proxmox, Nextcloud, n8n and Firebase event ingestion, see `docs/integrations.md`.

## APIs

- `GET /api/overview` — complete dashboard payload
- `GET /api/health` — application/database health
- `GET /api/tasks` / `POST /api/tasks` — task list and creation
- `GET /api/events` — latest events
- `POST /api/events/ingest` — authenticated operational event ingestion
- `GET /api/integrations` — integration registry
- `POST /api/integrations/sync` — authenticated/manual collector execution
- `GET /api/integrations/google/start` — begin Google OAuth
- `GET /api/integrations/google/callback` — complete Google OAuth
- `GET /api/agent-runs` / `POST /api/agent-runs` — run history and task routing
- `POST /api/agent-runs` with `retry_run_id` — retry an eligible failed Codex CLI run once
- `PATCH /api/agent-runs` — save a response from a manual provider handoff
- `POST /api/agent-runs/worker` — claim and execute one queued Codex task (admin protected)
- `GET /api/workflows` — protected Gmail workflow and agent-run status for the Business Intelligence screen
- `GET /api/sales/leads`, `POST /api/sales/leads`, and `PATCH /api/sales/leads` — owner-authenticated sales pipeline
- `GET /api/onboarding` and `PATCH /api/onboarding` — owner-authenticated onboarding checklist and task status

## Security

- Keep `.env.local` private.
- Never commit API tokens, OAuth secrets or `COMPANYOS_ENCRYPTION_KEY`.
- In production set `COMPANYOS_ADMIN_TOKEN` and `COMPANYOS_INGEST_TOKEN`.
- Prefer read-only OAuth/API permissions for collection.
- Prefer HTTPS with trusted certificates for Proxmox.
- Do not expose PostgreSQL directly to the Internet.

## npm 12 install-script policy

The project uses the reviewed `unrs-resolver@1.12.2` postinstall dependency required by the Next.js platform build chain. If npm blocks the script, review the package first rather than enabling all dependency scripts globally.

## AI Router setup

Configure optional API providers in `.env.local` using the variables listed in `.env.example`. API calls may be billable. Consumer ChatGPT Free and Claude Free accounts are used through manual handoff; CompanyOS does not access their private sessions. See `docs/ai-router.md` for the run lifecycle and limits.


### Google synchronization
After connecting Google, open `/communications` and use **Sync configured**. Gmail synchronization defaults to the last 30 days and is paginated; Calendar synchronization defaults to 7 days back and 45 days forward and is paginated. These windows can be adjusted in `.env.local` with the `GOOGLE_GMAIL_*` and `GOOGLE_CALENDAR_*` variables. The sync stores Gmail metadata/snippets and Calendar event summaries/details in `external_records`, and records one idempotent Company Brain event per external item.


## v0.4.0 lint baseline

`npm run lint` uses Biome's linter-only command so CI does not fail on formatting or assist suggestions. Use `npm run format` when you want Biome to format code and apply safe fixes.


## v0.4 Intelligence layer

CompanyOS now normalizes synchronized Gmail and Calendar data into contacts, meetings and deterministic attention items. The first-pass rules are intentionally provider-neutral and do not require an AI API.

Run `npm run db:migrate` after upgrading. Do not run the seed script on an existing installation.

New screen: `/intelligence`. New API: `PATCH /api/attention`.


## Production deployment

For the private Proxmox deployment baseline, Docker Compose setup, required secrets, migrations, backup guidance, and remaining security boundaries, see [production/DEPLOYMENT.md](production/DEPLOYMENT.md).

### AI Router and database safety

CompanyOS now has a provider-independent AI task contract and provider registry. Tasks can describe required capabilities, data sensitivity, cost/duration constraints, preferred providers, and fallbacks. The registry distinguishes API, CLI, local, and manual-handoff execution instead of treating every provider as the same kind of worker.

The database scripts load the same Next.js environment as the application. Run `npm run db:doctor` to verify that the active `DATABASE_URL` contains the required CompanyOS tables. If `financial_transactions` (or another required table) is missing, run `npm run db:migrate` against that same environment.

