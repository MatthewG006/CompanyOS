# CompanyOS production deployment (Proxmox)

This setup runs the Next.js app, PostgreSQL, and Codex execution runtime in
Docker Compose on Proxmox. PostgreSQL has no published host port. The app binds
to `127.0.0.1` on the Proxmox host. Cloudflare Tunnel connects outbound from
that host to the app container; it does not expose a host port. Production
CompanyOS includes an owner sign-in using `COMPANYOS_ADMIN_TOKEN`; it issues an
HTTP-only, same-site, 12-hour session cookie. Protect the hostname with
Cloudflare Access as an additional access boundary.

The Worker currently attached to `companyos.skymountaincloud.com` is a
placeholder. This project uses the Proxmox app and agent worker because Codex
CLI execution and PostgreSQL require a persistent Node.js/Docker runtime. Do
not deploy the placeholder or the full app source as a plain Worker.

## Prepare the host

Install Docker Engine and the Compose plugin on a dedicated Linux VM/LXC in
Proxmox. Keep PostgreSQL and app containers on that host; do not publish ports
5432 or 3000 on the LAN/WAN interfaces. Use Cloudflare Tunnel to connect the
public HTTPS hostname to the private app container.

Transfer the CompanyOS source tree to the host and run the following commands
from its `production` directory:

```sh
cp .env.production.example .env.production
chmod 600 .env.production
```

Generate a 32-byte URL-safe password for `POSTGRES_PASSWORD`, and put the same
value in the password portion of `DATABASE_URL` (the example uses characters
that do not need URL encoding). Generate separate random values for
`COMPANYOS_ADMIN_TOKEN` and `COMPANYOS_INGEST_TOKEN`. For a new, empty database,
generate a 32-byte hexadecimal `COMPANYOS_ENCRYPTION_KEY`. If restoring the
existing CompanyOS database with saved Google OAuth credentials, use the same
encryption key that encrypted those credentials in the source environment;
otherwise they cannot be decrypted. Keep these values in a password manager
and in the host's protected secret backup. Never rotate the encryption key
without first re-encrypting stored integration credentials.

Set `APP_URL=https://companyos.skymountaincloud.com`. If Google OAuth is
enabled, register
`https://companyos.skymountaincloud.com/api/integrations/google/callback` as an
authorized redirect URL in the Google OAuth client. Do not copy `.env.local`
from a development machine; configure only the production database URL and
required production secrets here.

Create a remotely-managed Cloudflare Tunnel in the dashboard. Before assigning
the hostname to the tunnel, remove `companyos.skymountaincloud.com` from the
placeholder Worker's Custom Domains. Configure the tunnel's public hostname as
`companyos.skymountaincloud.com` with service `http://app:3000`. Create a
Cloudflare Access application and owner-only policy for that hostname before
opening the route to users. Save the tunnel token on the Proxmox host as
`production/.cloudflare-tunnel-token`, with file permissions readable only by
the deployment account and root. Never commit or paste the token into chat.

## Build and migrate

Build the immutable app image and start PostgreSQL:

```sh
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.cloudflare.yml build app
docker compose --env-file .env.production -f docker-compose.yml up -d postgres
```

Back up any existing CompanyOS database before the first production migration.
Run the idempotent schema migration; do not run the seed or reset scripts:

```sh
docker compose --env-file .env.production -f docker-compose.yml run --rm migrate
```

Then start the app and Cloudflare Tunnel from the `production` directory:

```sh
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.cloudflare.yml up -d app cloudflared
docker compose --env-file .env.production -f docker-compose.yml ps
curl --fail http://127.0.0.1:3000/api/health
```

Verify the tunnel is healthy in Cloudflare Zero Trust and that the hostname
loads CompanyOS rather than the original placeholder. Open `/login` and sign in
with `COMPANYOS_ADMIN_TOKEN`. Admin API operations accept the validated owner
session or server token; event ingestion uses the separate
`COMPANYOS_INGEST_TOKEN`. The public health endpoint returns only an up/down
result.

## Updating

Take a PostgreSQL backup before an application/schema update. Transfer the new
source, rebuild the image, run the migration, then restart the app:

```sh
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.cloudflare.yml build app
docker compose --env-file .env.production -f docker-compose.yml run --rm migrate
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.cloudflare.yml up -d app cloudflared
```

The named Docker volume `companyos-postgres` persists data. Back it up regularly
with a tested PostgreSQL dump and keep a copy off the Proxmox host. Test restore
before relying on the backup. Preserve `.env.production` and the encryption key
separately; database backups alone cannot decrypt stored Google credentials.

An optional backup container makes one custom-format PostgreSQL dump per day
and retains 14 days in the `companyos-backups` volume. Start it after the first
successful app launch:

```sh
docker compose --env-file .env.production -f docker-compose.yml --profile backup up -d backup
```

This local volume is not an off-host backup. Copy dumps to encrypted storage on
a separate machine, and periodically restore a dump into a disposable database
to verify recovery.

## Moving an existing local database

If production should inherit the current Windows CompanyOS records, make a
PostgreSQL custom-format dump from the existing local Compose database before
deploying. Stop app writes, then from the Windows project directory run:

```powershell
docker compose exec -T postgres pg_dump -U companyos -d companyos -Fc --no-owner -f /tmp/companyos.dump
docker compose cp postgres:/tmp/companyos.dump .\companyos.dump
```

Copy the dump securely to the Proxmox host. Start only the production
`postgres` service, then restore into its empty database before running the
CompanyOS migration:

```sh
docker compose --env-file .env.production -f docker-compose.yml up -d postgres
docker compose --env-file .env.production -f docker-compose.yml exec -T postgres pg_restore -U companyos -d companyos --clean --if-exists --no-owner < companyos.dump
docker compose --env-file .env.production -f docker-compose.yml run --rm migrate
```

Keep the dump protected because it contains business data and encrypted
integration credentials. Do not run the restore command against a production
database that already contains data. After verifying production, securely
remove temporary dump copies according to your retention policy.

## Agent execution

ChatGPT Free and Claude Free work through owner-mediated copy/paste handoff.
API-based OpenAI, Anthropic, or Ollama runs need provider credentials in
`.env.production` and may incur charges. The app image includes a pinned Codex
CLI and a separate `companyos-codex-home` volume for its sign-in state. That
volume contains refreshable account credentials in file-based storage; protect
the Proxmox host with full-disk encryption and limit Docker access to trusted
administrators. Never copy a developer's `~/.codex` directory into production.

After the app is running, sign in inside the production app container with device
authentication (enable device-code login in the ChatGPT account first):

```sh
docker compose --env-file .env.production -f docker-compose.yml exec app codex login --device-auth
docker compose --env-file .env.production -f docker-compose.yml exec app codex login status
```

Only after `codex login status` succeeds, start the opt-in queue poller:

```sh
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.cloudflare.yml --profile agents up -d agent-worker
```

The worker polls CompanyOS; the app executes each Codex run in its existing
ephemeral, isolated task workspace. The CLI version is pinned by
`CODEX_CLI_VERSION` (default `0.143.0`); update it intentionally and rebuild the
image when upgrading. Keep external writes behind owner approvals.

## Production limits

- CompanyOS has a single-owner token login, not multi-user identity, MFA,
  account recovery, or per-user authorization. Keep the authenticated reverse
  proxy and private network boundary in place.
- The deployment publishes no PostgreSQL port and exposes the app only on host
  loopback. Do not change this to `0.0.0.0` without an authenticated gateway.
- Configure host-level firewalling, monitoring, encrypted off-host backups,
  and a tested recovery procedure before treating the service as business
  critical.
- Do not run `db:seed` or `db:reset` against production data.
