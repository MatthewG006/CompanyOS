# CompanyOS Architecture v0.5

## Objective
Provide one command center for the owner's businesses and the future AI workforce.

## System boundary

```text
                         OWNER
                           |
                           v
                 Next.js Command Center
                           |
                    Private Company API
                           |
          +----------------+----------------+
          |                |                |
     PostgreSQL        n8n / queue       AI Router
     source of truth   deterministic       |
          |             workflows     ChatGPT / Claude / Codex
          |                            API models / local models
          +----------- integrations --------+
                 Gmail / Calendar / GitHub
                 Proxmox / Nextcloud / CRM
```

## Data domains
- Companies and projects
- Agents and roles
- Tasks
- Events
- Owner approvals
- Financial metrics
- System checks

## Future domains
- Customers
- Leads
- Support tickets
- Subscriptions
- Transactions
- AI usage and cost
- Knowledge documents
- Decisions
- Agent memory
- Integrations and OAuth connections

## Permission model

### Read
Automatic.

### Low-risk writes
Allowed through controlled workflows after validation.

### Medium-risk writes
Require an explicit policy gate.

### High-risk writes
Require owner approval.

## Control-plane boundaries

- PostgreSQL is the canonical record for companies, projects, tasks, events, approvals, and agent runs. Provider chat history is not canonical memory.
- Deterministic code handles collection, health checks, calculations, routing rules, and workflow state transitions. Invoke an AI model only for work that benefits from interpretation or generation.
- AI providers receive only the context required for one bounded task. A provider adapter does not receive database credentials or unrestricted tools.
- Free ChatGPT, Claude, and Codex consumer sessions use an owner-mediated prompt/result handoff. CompanyOS does not treat those subscriptions as API credentials or depend on consumer MCP write access.
- API-backed models and local models are optional workers. Provider selection must be replaceable without moving business state out of PostgreSQL.
- Tools are server-side capabilities with explicit scopes. Read operations can be granted independently; write operations pass through policy checks and, where required, an owner approval record.
- n8n coordinates deterministic workflows through authenticated private API calls. Redis may provide transient queue, lock, or cache behavior, but PostgreSQL remains the durable system of record.
- Keep service endpoints private behind the local network, VPN, or authenticated reverse proxy. Do not publish unauthenticated n8n, Redis, PostgreSQL, or CompanyOS APIs.

## Delivery sequence

1. v0.5: audited task runs, provider adapters, and manual free-account handoffs with no autonomous tools.
2. Next control-plane layer: agent hierarchy, shared scoped memory, tool registry, permission policies, and KPI records.
3. Workflow layer: durable job dispatch, Redis where useful, n8n integration, schedules, retries, and idempotency.
4. Production deployment: authenticated private API on Proxmox, backups, monitoring, and recovery before enabling external write actions.

## First production rule
Do not expose the Command Center directly to the public Internet. Put it behind Tailscale, a private VPN, or an authenticated reverse proxy until authentication, session management, audit logging, and action permissions are implemented.
