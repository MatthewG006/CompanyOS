# CompanyOS Agent Contract

Every agent should have these fields:

- name
- role
- department
- mission
- inputs
- tools
- allowed_actions
- prohibited_actions
- escalation_rules
- success_metrics
- memory_scope

Example:

```yaml
name: CTO
role: Technology Lead
department: Technology
mission: Maintain technical integrity across all CompanyOS projects.
inputs:
  - project_requirements
  - incidents
  - architecture_docs
  - engineering_metrics
tools:
  - company_database_read
  - github_read
  - issue_create
  - deployment_status
allowed_actions:
  - request_task_creation
  - request_task_status_change
  - request_task_delegation
  - review_architecture
  - request_tests
prohibited_actions:
  - delete_production_data
  - rotate_payment_credentials
  - change_dns_without_approval
escalation_rules:
  - production_data_change
  - security_boundary_change
  - material_cost_increase
success_metrics:
  - deployment_success_rate
  - incident_resolution_time
memory_scope:
  - project
  - tasks
  - systems
```

For task runs, CompanyOS enforces these memory scopes. `project` supplies the project description and status; `tasks` supplies up to eight task summaries from that project; `systems` supplies up to five recent health-check summaries. `sales` is restricted to the Sales agent and exposes active lead contact fields only when explicitly enabled. `support` is restricted to the Support agent and exposes only the case linked to the assigned task when explicitly enabled. Unknown scope values are ignored. Other email, calendar, contact, and financial records are not included in agent memory.

`request_task_creation` lets an agent ask CompanyOS to create one follow-up task in the same project and assigned to the same agent. The proposal is bounded and saved as a pending owner approval. It does not authorize direct task creation; approving the request is the only path that creates the task.

`request_task_status_change` lets an agent propose `in_progress` or `done` for only the task it was assigned. CompanyOS verifies the task is still assigned to that agent and belongs to the same project at approval time. A completed task cannot be reopened through this tool.

Support case descriptions enter model context only when the owner explicitly enables the `support` scope for the Support agent. This scope includes only the case linked to that run's task. `request_support_case_update` can propose `in_progress`, `waiting`, or `resolved` for that linked case; the proposal requires owner approval, updates the case and task together, and does not contact the customer.

`request_task_delegation` lets an agent with direct reports propose a task for one of those reports. The recipient must still report directly to the requesting agent when the owner approves, and the new task stays in the source task's project.

Agents should return structured results whenever possible:

```json
{
  "status": "completed|blocked|needs_approval|failed",
  "summary": "...",
  "actions_taken": [],
  "evidence": [],
  "risks": [],
  "next_actions": []
}
```
