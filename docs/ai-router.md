# CompanyOS AI Router

## v0.5 scope

CompanyOS creates a bounded prompt from an existing open task, project, assigned agent, and the agent's scoped memory snapshot. It stores each run and its result in PostgreSQL. A model response is a draft for owner review; the runner has no CompanyOS tools and cannot change tasks, send messages, or perform external actions.

## Providers

Configure API providers on the server in `.env.local`:

- OpenAI API: `OPENAI_API_KEY` and `AI_OPENAI_MODEL`
- Anthropic API: `ANTHROPIC_API_KEY` and `AI_ANTHROPIC_MODEL`
- Ollama: `OLLAMA_BASE_URL` and `OLLAMA_MODEL`
- Codex CLI: install and sign in to the Codex CLI on the CompanyOS host. CompanyOS detects `codex` on `PATH`; set `CODEX_CLI_PATH` if it is installed elsewhere. This uses the CLI's own account access and limits, not an OpenAI API key.

API provider use may incur charges according to the provider account. CompanyOS does not read ChatGPT Free or Claude Free subscription sessions as API credentials. Those services remain available through manual prompt handoff: copy the task prompt into the service, then paste its response into the run record. The separate Codex CLI provider can run a task automatically when the CLI is installed and signed in.

Codex CLI runs are started from a fresh temporary directory. A per-run permission profile denies filesystem access outside the runtime minimum and the empty temporary workspace, disables network access for model-invoked shell commands, and does not pass CompanyOS/provider environment variables to the CLI process. Runs are ephemeral, limited to 120 seconds and 300 KB of CLI output, and the temporary directory is removed afterwards. The CLI still requires its own local sign-in to call the model.

## Shared memory and permissions

The `memory_scope` field is enforced when the task prompt is built. Supported scopes are `project`, `tasks`, `systems`, `sales`, and `support`. Context is limited to the assigned task's project, and each source has row and text limits. The Projects screen has one owner-managed memory note per project, capped at 5,000 characters; it is included only with the `project` scope. Empty scope arrays remain task-only; the migration assigns the three baseline scopes only to agents whose scope is still empty. Sales contact data is excluded unless the owner explicitly enables `sales` memory for the Sales agent. Support descriptions are excluded unless the owner explicitly enables `support` memory for the Support agent; that scope reveals only the support case linked to the assigned task. All retrieved text is marked as untrusted data in the prompt.

The `request_task_creation`, `request_task_status_change`, and `request_support_case_update` permissions are enforced by the approval-backed action registry. Support status proposals are limited to the case linked to that Support run and require owner approval. Other `allowed_actions`, `prohibited_actions`, `escalation_rules`, and `success_metrics` are still descriptive metadata. Models cannot directly call CompanyOS tools or enact responses.

The registry currently supports `create_task`, `set_task_status`, `delegate_task`, and the internal `update_support_case` action. It requires the corresponding permission and binds actions to the task run's project and reporting line. Task status proposals may target only the assigned task and set it to `in_progress` or `done`; Support status proposals may target only the linked case. Delegation is limited to a direct report and the original project. Proposals are stored as pending approvals; approval plus action execution happens in one database transaction. Rejection makes no change. Migrations grant proposal permissions without replacing existing custom permissions. Production approval writes require owner authentication.

Approving a delegation creates the task and a queued `codex-cli` run in the same transaction. New unread Gmail attention classified as sales, support, or billing also creates one project-scoped task and queued Codex run for the matching agent; previously synced attention is marked as baseline during migration. That Gmail run receives only its category, subject (up to 300 characters), and snippet (up to 700 characters), in addition to the agent's normal scoped project memory. The agent cannot access Gmail directly or send a reply.

To process runs continuously, start `npm run agents:worker` in a second terminal while CompanyOS is running. The worker reports its instance ID and Codex sign-in health with each poll. The AI Workforce page shows whether the worker checked in during the last three minutes, queue totals, refreshes every eight seconds, and can run one queued task when you click **Run next queued task**. Both paths call the admin-protected `/api/agent-runs/worker` endpoint, which claims one run at a time using PostgreSQL row locks. Queue rows survive restarts. The Business Intelligence page shows Gmail workflow dispatch, task, and latest agent-run state, including bounded failure details; the authenticated `GET /api/workflows` endpoint powers that view. Workflow state changes to running, completed, or failed with the agent run, and a retry becomes the workflow's latest run. A run stuck in `running` for more than five minutes is marked failed. Failed Codex CLI runs with open, assigned tasks can be retried from run history. A database uniqueness rule permits only one retry per failed attempt; if that retry fails, it becomes a new attempt that can be retried. Queued runs use Codex CLI only and never fall back to billable API providers.

## Run lifecycle

- API-backed or Codex CLI run: `running` → `completed` or `failed`
- Manual handoff: `awaiting_external` → `completed`
- Approved delegation: task + `queued` run → `running` → `completed` or `failed`
- New Gmail follow-up: task + `queued` run → `running` → `completed` or `failed`
- Every run stores its bounded task input, selected provider/model, result or error, and timestamps in `agent_runs`.
- Run transitions emit events for the Company Brain timeline.

## Security and limits

- Provider keys are read only from server environment variables and never returned by the API.
- Production routes require `COMPANYOS_ADMIN_TOKEN`.
- API provider calls have a 60-second timeout. Codex CLI has a 120-second timeout. Manual results are limited to 30,000 characters.
- The runner does not expose tools, integrations, secrets, or database access to a model.
- No model response automatically executes an action or changes the task status.

## Owner-managed agent policy

The AI Workforce screen lets the owner select each agent's enforced task-proposal permissions (`request_task_creation`, `request_task_status_change`, `request_task_delegation`, `request_sales_lead`, `request_email_outreach`, and `request_support_case_update`) and supported memory scopes (`project`, `tasks`, `systems`, `sales`, `support`). PII scopes and write proposals are restricted to their corresponding Sales or Support agent. Sales outreach proposals require the Sales agent, explicit contact memory, the outreach permission, and `COMPANYOS_POSTAL_ADDRESS`; they require approval of the exact email before delivery. See [sales outreach controls](sales-outreach.md). Support case changes require the Support agent, assigned-case memory, and approval. Updates are owner-authenticated in production, written to PostgreSQL, and recorded as Company Brain events. Delegation permission can only be assigned to agents with direct reports. Existing running prompts are not changed; policy applies when future task runs build their prompts.
