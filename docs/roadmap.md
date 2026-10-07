# Sky Mountain CompanyOS — Command Center Roadmap v0.6

## Current platform

CompanyOS covers exactly:

- Sky Mountain Cloud
- Plenty of Plants
- Sky Mountain Graphics

## v0.4 — Company Brain intelligence

- PostgreSQL system of record
- Local Google OAuth for Gmail + Calendar
- Gmail/Calendar normalization
- Contacts derived from synchronized business mail
- Calendar meetings derived from synchronized events
- Deterministic attention queue for unread business mail and near-term meetings
- Owner actions to snooze/dismiss attention items
- Command Center business-attention summary
- Intelligence screen

## v0.5 — AI operations

- Provider-neutral task prompt router for OpenAI, Anthropic, and local Ollama APIs
- Manual prompt and result handoff for ChatGPT Free, Claude Free, and Codex
- PostgreSQL-backed agent run history, results, status, and failures
- Task execution remains bounded to context and model output; no tools or external actions
- Server-only provider credentials and optional production admin-token gate
- Follow-up work: AI-assisted email classification, customer/lead records, owner briefing, recurring workflows, and policy-gated actions

## Control-plane sequence after the first v0.5 slice

1. Add agent hierarchy, scopes, owner-managed shared memory, tool registry, permission policies, and KPI definitions.
2. Add an authenticated private API and deterministic workflows; connect n8n without moving canonical state out of PostgreSQL.
3. Add Redis only for queues, locks, or caching that need it; keep durable jobs and audit history in PostgreSQL.
4. Deploy to Proxmox behind private networking, with backup/recovery and monitoring before enabling any production write tools.

## v0.6 — Business automation

- Initial owner-managed sales pipeline with project-linked leads, stages, values, and follow-up dates
- Opportunity changes recorded as Company Brain events; lead details stay out of agent memory by default
- Marking an opportunity Won creates an internal customer onboarding checklist and Support tasks
- Owner/agent task completion stays synchronized with onboarding progress
- Due follow-up dates create internal Sales tasks through the agent worker, independent of AI provider availability
- Due Sales follow-ups now queue a Sales-agent run; with owner-granted sales memory/outreach permission, the agent can draft one lead-specific email for owner review
- Reminder completion is owner-controlled; rescheduling or closing the opportunity retires the prior reminder task
- Internal Support Desk cases can be linked to a project/contact and create an internal Support task; status changes stay synchronized
- Support case descriptions stay excluded from agent prompts unless the owner enables the Support-only, assigned-case memory scope
- New Support cases queue a scoped Support-agent triage run; Support memory is owner-enabled and limited to the linked case, and proposed case-status changes require owner approval
- Support Desk shows active/high-priority/waiting workload, oldest-case age, and live agent-run status without inventing service-level targets
- Owner-managed financial ledger records income/expenses by date, category, and project; voiding is audited and preserves history
- Ledger entries contribute to the month-to-date revenue and expense metrics
- Owner-reviewed CSV statement imports normalize standard amount or debit/credit exports, flag possible duplicate rows, and preserve import provenance
- Finance agent can propose sales income from confirmed Gmail billing evidence; owner approval is required before recording it
- Sales agent receives classified unread prospecting messages and can propose a project-linked lead; owner approval creates the pipeline record and internal follow-up
- Gmail lead discovery is limited to connected unread messages; external web prospecting is not implemented
- Next: provider/bank imports and reconciliation, then deeper infrastructure and GitHub workflows
- Financial integrations
- Proxmox/Nextcloud deeper health data
- GitHub engineering workflows
- n8n automation
