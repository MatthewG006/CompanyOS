# CompanyOS v0.4 integration setup

## GitHub

Set:

```text
GITHUB_TOKEN=...
GITHUB_OWNER=MatthewG006
GITHUB_REPO=<optional-repository-name>
```

Start with the smallest fine-grained token permissions necessary. For read-only dashboards, repository metadata and issue/pull-request read access are sufficient; do not grant write permissions until an explicit write workflow exists.

## Proxmox

Set:

```text
PVE_API_URL=https://<your-proxmox-host>:8006
PVE_TOKEN_ID=<token-id>
PVE_TOKEN_SECRET=<token-secret>
```

Use an API token with only the permissions required for node status collection. Prefer HTTPS with a trusted certificate. Do not disable TLS verification globally.

## Nextcloud

Set:

```text
NEXTCLOUD_URL=https://app.skymountaincloud.com
```

The v0.4 collector uses `/status.php` for a lightweight health check. Add app-token/OAuth capabilities only when a specific CompanyOS workflow needs them.

## n8n / Firebase

CompanyOS exposes a signed event endpoint:

`POST /api/events/ingest`

Send:

```json
{
  "source": "firebase",
  "event_type": "analytics",
  "title": "Plant draw completed",
  "severity": "info",
  "project_slug": "plenty-of-plants",
  "idempotency_key": "firebase-event-123",
  "payload": {
    "user_id": "internal-user-id",
    "plant": "fern"
  }
}
```

Authenticate with:

`Authorization: Bearer <COMPANYOS_INGEST_TOKEN>`

For n8n, keep the token in n8n credentials/secrets. For Firebase, prefer a server-side Cloud Function or n8n bridge rather than exposing the CompanyOS ingest token in the browser app.
