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
- Owner-reviewed CSV import stages bank transactions with an inferred category, flags possible duplicates, and records entries only after a per-row owner decision
- Reconciliation suggests near matches (same amount, close date, similar description) for owner confirmation, the Re-check matches button re-runs the exact-match check per batch, and the unmatched view lists staged rows and ledger entries with no match in one place
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

- Node.js 24+ (pinned in `engines`, `.nvmrc`, and CI)
- Docker Desktop for the included PostgreSQL container
- Git (recommended)

## Run locally

PowerShell:

```powershell
npm install
Copy-Item .env.example .env.local
npm run db:up
npm run db:migrate
npm run db:seed
npm run dev
```

bash (macOS/Linux):

```bash
npm install
cp .env.example .env.local
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

By default the worker polls the app over HTTP. A direct-database mode exists for hosts that cannot reach the app, but it is opt-in only: set `COMPANYOS_WORKER_MODE=db` (with `DATABASE_URL` present) — `DATABASE_URL` alone never selects it. DB mode bypasses the HTTP worker route's ancillary jobs (outbound email, sales follow-up dispatch, handoff expiry), so prefer HTTP mode unless the deployment specifically needs DB mode.

## Local environment setup

Generate a 32-byte encryption key:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Put it in `.env.local` as `COMPANYOS_ENCRYPTION_KEY`.

For Google OAuth, see `docs/google-oauth.md`.

For GitHub, Proxmox, Nextcloud, n8n and Firebase event ingestion, see `docs/integrations.md`.

## Everyday use

- The Company Brain command bar sits at the top of every page — press **⌘K** (Ctrl+K on Windows/Linux) to jump to it from anywhere.
- The sidebar highlights the page you are on, and the Sky Mountain brand returns to the Overview.
- When an admin token is required, enter it once: it is shared by every panel for the rest of the tab session (kept in `sessionStorage` only) instead of being re-typed per screen.
- Live panels (Overview, Support, Workflows, AI Workforce) pause their auto-refresh while the tab is hidden and refresh as soon as you return, so the numbers are never stale on sight.
- The AI Workforce page leads with the task console; agent policies live at the bottom. The task board refreshes itself and says when it is showing the first 8 of more open tasks.
- The ledger, support cases, sales pipeline, and agent run history each have a search box that filters as you type.
- Codex CLI is the autonomous operator for every role: when an agent proposes a task and the owner approves it — or the owner creates a task for an agent — the execution run is queued automatically and the agent worker carries it out. There is no manual dispatch step; the AI Workforce page is a live view of the queue and history. Roles configured for a manual handoff provider (ChatGPT Free, Claude Free, manual Codex) still wait for the owner to paste the response, since those subscriptions are owner-mediated.
- The Agency page runs the business like the Lead Desk: pick a business (or all three), see every department's live work and what is waiting for your approval, and keep one brand kit per business. Paste the business website and choose "Read from website" to propose a kit automatically (logo, colors, fonts, phone, Instagram); nothing is saved until you review and save. The saved kit — including the Instagram username the planner publishes through — joins the project context your agents receive.
- The Content Planner is the Lead Desk's week grid: posts, reels, stories and articles per business, drafted by your agents (Marketing proposes content through the same approval flow as everything else; on an existing database the `request_content_item` grant is applied automatically by the Phase 3 migration) or added by you. Select an item to edit it and open its design studio: image variations generated from its image prompt land there for your approval, and nothing becomes the item's visual without your yes. "Approve this week" clears the whole week's review queue in one pass; scheduled items that pass their date surface as due to publish.
- Leads move at Lead Desk speed: a new lead immediately gets a high-priority first-response task for the Sales agent, queued for autonomous execution. On every lead card, one-tap outcome buttons (Contacted / Visit / Quote / Won / Lost) record how it ended — outcomes advance the stage forward only, stamp the first-response time, and a Won starts the same customer onboarding as the pipeline. The Results page rolls it up per business: leads received, contacted, median first response, quotes, wins, pipeline and won value, and content published.
- Under the hood, each page loads only the data it renders (per-domain loaders in `lib/data.ts`), and API routes share one error helper (`lib/api-errors.ts`) so every error has the same `{ error }` shape.

## APIs

- `GET /api/overview` — complete dashboard payload
- `GET /api/health` — application/database health
- `POST /api/auth/login` / `POST /api/auth/logout` — owner session sign-in and sign-out
- `POST /api/command` — CommandBar natural-language routing (approval-gated proposals)
- `GET /api/tasks` / `POST /api/tasks` / `PATCH /api/tasks` — task list, creation, and status updates
- `GET /api/events` — latest events
- `POST /api/events/ingest` — authenticated operational event ingestion
- `GET /api/approvals` / `PATCH /api/approvals` — pending approvals and owner decisions
- `PATCH /api/attention` — dismiss or resolve intelligence attention items
- `PATCH /api/agents` — agent policy updates
- `GET /api/agent-runs` / `POST /api/agent-runs` — run history and task routing
- `POST /api/agent-runs` with `retry_run_id` — retry an eligible failed Codex CLI run once
- `PATCH /api/agent-runs` — save a response from a manual provider handoff
- `POST /api/agent-runs/worker` — claim and execute one queued Codex task (admin protected)
- `GET /api/workflows` — protected Gmail workflow and agent-run status for the Business Intelligence screen
- `GET /api/integrations` / `PATCH /api/integrations` — integration registry and settings
- `POST /api/integrations/sync` — authenticated/manual collector execution
- `GET /api/integrations/google/start` — begin Google OAuth
- `GET /api/integrations/google/callback` — complete Google OAuth
- `GET /api/integrations/wordpress` / `POST /api/integrations/wordpress` — WordPress connection status and publish proposals
- `GET /api/project-memory` / `PUT /api/project-memory` — owner-managed shared project memory
- `GET /api/brand-kits` / `PUT /api/brand-kits` — per-business brand kits (owner-reviewed saves)
- `POST /api/brand-kits/extract` — propose a brand kit by reading a business website (never saves automatically)
- `GET /api/content` / `POST /api/content` / `PATCH /api/content` — content planner items (PATCH also takes `bulk: "approve_week"`)
- `POST /api/content/images` — design studio intake: submit image variations for owner review (never chooses one)
- `GET /api/sales/leads`, `POST /api/sales/leads`, and `PATCH /api/sales/leads` — owner-authenticated sales pipeline
- `GET /api/sales/outcomes` / `POST /api/sales/outcomes` — one-tap lead outcome reports (contacted / visit / quote / won / lost)
- `PATCH /api/sales/reminders` — complete or retire sales follow-up reminder tasks
- `GET /api/onboarding` and `PATCH /api/onboarding` — owner-authenticated onboarding checklist and task status
- `GET /api/support`, `POST /api/support`, and `PATCH /api/support` — owner-authenticated Support Desk cases
- `GET /api/finance/transactions`, `POST /api/finance/transactions`, and `PATCH /api/finance/transactions` — owner-authenticated finance ledger
- `GET /api/finance/imports`, `POST /api/finance/imports`, `PUT /api/finance/imports`, and `PATCH /api/finance/imports` — staged CSV import review, re-check, and per-row decisions
- `PATCH /api/communications/preferences` — communication channel preferences (consent and opt-outs)

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

## Continuous integration

GitHub Actions runs the `CI` workflow (`.github/workflows/ci.yml`) on every pull request and on every push to `main`. The single verify job installs dependencies with `npm ci` on Node.js 24 against a `postgres:16` service container, then runs the same commands used locally:

```bash
npm run lint
npm run typecheck
npm run db:migrate
npm test
npm run test:routes
```

`npm run typecheck` runs `tsc --noEmit`. The workflow sets `DATABASE_URL` to the service container and migrates it before testing, so the database unit tests run for real in CI and the route-integration suite (`test:routes`, which builds the app and exercises the API routes against a throwaway database) is exercised on every change. Locally, the database tests skip automatically when `DATABASE_URL` is not set.


## v0.4 Intelligence layer

CompanyOS now normalizes synchronized Gmail and Calendar data into contacts, meetings and deterministic attention items. The first-pass rules are intentionally provider-neutral and do not require an AI API.

Run `npm run db:migrate` after upgrading. Do not run the seed script on an existing installation.

New screen: `/intelligence`. New API: `PATCH /api/attention`.


## Production deployment

Production currently runs hosted:

- **App** — the Next.js app is deployed on Vercel from this repository; pull requests receive Vercel preview deployments and checks.
- **Database** — production PostgreSQL is hosted on Supabase; schema changes reach it with `npm run db:migrate`, as with any other environment.
- **Agent worker** — the Codex CLI worker runs on an LXC on the owner's Proxmox VE home-lab server and polls the app over HTTP (see the worker notes under "Run locally"). Codex CLI is installed and signed in on that host.

The repository also ships a private self-hosted baseline — Docker Compose on Proxmox behind a Cloudflare Tunnel — in [production/DEPLOYMENT.md](production/DEPLOYMENT.md), covering setup, required secrets, migrations, backup guidance, and remaining security boundaries. That document is the self-hosted deployment path, not the current live topology.

### AI Router and database safety

CompanyOS now has a provider-independent AI task contract and provider registry. Tasks can describe required capabilities, data sensitivity, cost/duration constraints, preferred providers, and fallbacks. The registry distinguishes API, CLI, local, and manual-handoff execution instead of treating every provider as the same kind of worker.

The database scripts load the same Next.js environment as the application. Run `npm run db:doctor` to verify that the active `DATABASE_URL` contains the required CompanyOS tables. If `financial_transactions` (or another required table) is missing, run `npm run db:migrate` against that same environment.

SSL certificates are verified by default; use `sslmode=no-verify` in `DATABASE_URL` only for endpoints with self-signed certificates.

