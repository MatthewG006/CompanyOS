# Sales outreach controls

Sales outreach is proposal-only until all owner controls are enabled. The Sales agent must be granted both the `sales` memory scope and `request_email_outreach`; the policy API restricts contact memory and outreach permission to the Sales agent. It sees only active lead contact names, emails, organizations, stages, and opportunity titles for the assigned project.

An outreach proposal is stored as an outbound message and a high-risk pending approval. The approval view displays the exact recipient, subject, body, business postal address, and unsubscribe instruction. Approving that individual record queues that exact message for the existing background worker; the worker sends through Gmail after the approval transaction commits. Rejecting it marks the outbox record rejected. Delivery status and bounded retries appear in Communications. Each send uses a stable RFC 822 Message-ID for duplicate protection. The worker rechecks lead status and email opt-out state immediately before sending.

Email sending requires all of the following:

- Set `COMPANYOS_POSTAL_ADDRESS` to the real postal address that belongs in commercial email.
- Reconnect Google from Communications after adding Gmail `gmail.send` permission. The saved token must report that scope.
- Enable `sales` memory and `request_email_outreach` for the Sales agent.
- Owner approval of each exact draft.

The Sales screen can record email/WhatsApp channel preferences with evidence for opt-in. Gmail sync records an email opt-out when a recipient replies in the same sent thread with an unsubscribe/stop/remove-me phrase. Opt-outs suppress new proposals and are rechecked at send time. WhatsApp sending is not enabled; the preferences table only records consent until an authorized WhatsApp Business Platform connector, sender identity, and template handling are configured.

The agent does not scrape contacts or automatically send campaigns. It may propose a single message only to an existing, active, project-scoped sales lead. Scheduled Sales follow-up tasks queue an agent run, and proposals from those runs must match the exact lead linked to that reminder. No outreach is sent by sync, agent run, deployment, or background worker without owner approval.
