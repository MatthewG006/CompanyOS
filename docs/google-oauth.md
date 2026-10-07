# Google OAuth setup for local CompanyOS

CompanyOS v0.4 uses Google's OAuth 2.0 authorization-code flow to obtain read-only Gmail and Calendar access. The local app stores the OAuth token encrypted in PostgreSQL; it does not reuse a ChatGPT connection.

## 1. Create Google credentials

In Google Cloud Console, create or select a project, configure the OAuth consent screen, then create an OAuth client for a Web application.

For local development, add this authorized redirect URI:

`http://localhost:3000/api/integrations/google/callback`

Requested scopes:

- `openid`
- `email`
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/calendar.readonly`

## 2. Configure `.env.local`

Set:

```text
APP_URL=http://localhost:3000
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
COMPANYOS_ENCRYPTION_KEY=<64 hex characters>
```

Generate the encryption key with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## 3. Connect Google

Run the app and visit:

`http://localhost:3000/communications`

Click **Connect Google**. After successful consent, CompanyOS records the connection and can synchronize Gmail and Calendar.

## 4. Sync

Use **Sync** next to Gmail or Calendar, or **Sync configured** from Operations.

Tokens are server-side secrets. Never put Google client secrets, refresh tokens or the encryption key into client-side code.
