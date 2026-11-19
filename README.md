# NitM

News in the Morning: daily news collection, LLM briefing, and email delivery. The runtime uses Cloudflare Workers, Cron Triggers, Workers Assets, and D1. Firebase is reference material only and is not required to run this project.

## Features

- Google OAuth login with D1 invitation and administrator authorization
- Admin-managed RSS/Atom sources, invitations, user subscription status, schedule, and LLM settings
- Daily Korean briefing of all feed items published in the previous 24 hours, with Korea-related article bodies enriched, Korea news first, original publication timezone labels and linked sources
- Resend delivery, test email, manual run, dated lessons and email history
- 30-day retention for lessons and operational history

## Develop

Requirements: Node.js 20+, npm, Wrangler, and a Cloudflare account for deployment.

```sh
npm install
npm run db:local:migrate
npm test
npm run dev
```

The app is served by Wrangler, normally at `http://localhost:8787`. Copy `.dev.vars.example` to `.dev.vars` and fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Set local Resend and LLM configuration with `wrangler secret put NAME --local`; add `http://localhost:8787/auth/callback` to the Google OAuth client's authorized redirect URIs for local testing.

## Deploy

1. Create a D1 database and put the returned ID in `wrangler.jsonc`:

   ```sh
   npx wrangler d1 create nitm
   ```

2. Create a Google OAuth Web application client in Google Cloud Console. Add `https://<worker-domain>/auth/callback` as an authorized redirect URI. Register Worker secrets:

   ```sh
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put LLM_API_KEY
   npx wrangler secret put LLM_BASE_URL
   npx wrangler secret put LLM_MODEL
   ```

   For an existing installation, copy the current D1 LLM Base URL and model into these secrets. All LLM settings, including key, URL, and model, are read only from Worker secrets.

3. Set `BOOTSTRAP_ADMIN_EMAIL` and a Resend-verified `MAIL_FROM` in `wrangler.jsonc`, then deploy the new Worker code:

   ```sh
   npm run deploy
   ```

4. Apply the remote D1 migration to remove legacy LLM values after verifying the Worker uses secrets. New installations can run migrations before the first deployment.

   ```sh
   npm run db:remote:migrate
   ```

5. Sign in with Google using the bootstrapped account. Configure the schedule in **관리자**; the admin screen shows whether the LLM secrets are present. Then test the full email flow.

The initial configuration is UTC at 06:00, Korean summary language, with six reference RSS feeds. See [deployment details](doc/5_DEPLOYMENT.md) and the [system documentation](doc/README.md).

The single source of truth for the software version is the root `VERSION` file. Update that file to change the version; the dev, check, and deploy scripts synchronize package metadata and the email version asset automatically. Lesson emails show the software version, the requested `LLM_MODEL`, and the model name returned by the provider.

## Validate

```sh
npm test
npm run check
```

`npm run check` performs JavaScript syntax checks and a Wrangler dry-run bundle; it does not deploy. The RFP is [doc/0_RFP.md](doc/0_RFP.md).