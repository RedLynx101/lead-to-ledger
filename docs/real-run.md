# Connecting to the real services

Everything else in this repo runs on simulators. These steps connect it to a HubSpot test account and a QuickBooks sandbox company for the one real run, and they cost nothing. Keys go in `.env`, which is git-ignored, and nowhere else.

Checked against the vendors' docs on 2026-11-01.

## HubSpot: a service key

HubSpot stopped allowing new legacy private apps on 2026-10-26. A service key is its replacement for calling the API directly.

1. Sign in to HubSpot and switch into the test account: **Development > Testing > Test Accounts**, then open it.
2. In the test account, go to **Development > Keys > Service keys** and click **Create service key**.
3. Name it `lead-to-ledger` and add these eight scopes:

   ```
   crm.objects.contacts.read
   crm.objects.contacts.write
   crm.objects.deals.read
   crm.objects.deals.write
   crm.schemas.contacts.read
   crm.schemas.contacts.write
   crm.schemas.deals.read
   crm.schemas.deals.write
   ```

4. Click **Create**, then **Show** and **Copy** on the key's page.
5. Add it to `.env`:

   ```
   HUBSPOT_TOKEN=<the key>
   ```

**If a test account has no Service keys page:** HubSpot's docs don't say whether test accounts offer them, so this is unconfirmed until someone looks. There are two ways on, neither of them paid:

- **Simplest:** create the service key in the main HubSpot account, the same way, if that account holds no real customer data. Everything this repo writes there is synthetic, marked `ltl_synthetic`, on reserved email domains.
- **Keeps the data in the test account:** a private app with a static token. Run `npm install -g @hubspot/cli@latest`, `hs account auth`, then `hs project create`, choosing **App**, private distribution and a static token. In `src/app/app-hsmeta.json`, set `requiredScopes` to the eight scopes above, then run `hs project upload`. In **Development > Projects**, open the project, click the app, open the **Distribution** tab, click **Add test install(s)**, and install it in the test account. The docs say only that the token is "in your app settings", so look for it on the app's **Auth** tab.

## QuickBooks: the redirect URI and one consent click

1. Sign in at developer.intuit.com. Go to **My Hub > App dashboard**, open the app, then **Settings > Redirect URIs**.
2. On the sandbox tab, click **Add URI**, enter exactly this, and save:

   ```
   http://localhost:8765/callback
   ```

3. Start Postgres and run the consent flow:

   ```
   docker compose up -d postgres
   npm run connect:quickbooks
   ```

   Your browser opens on Intuit's consent page. Pick the sandbox company and click **Connect**. The terminal prints `Connected. A test read of the sandbox company worked.` Tokens are stored encrypted in Postgres, and a key for that is added to `.env` the first time.

**If Intuit refuses `http://localhost:8765/callback`:** Intuit's docs say localhost without HTTPS is allowed for sandbox apps, so this shouldn't happen. If it does, use Intuit's OAuth Playground, which needs no tunnel and no public URL:

1. Open the OAuth 2.0 Playground from Intuit's docs (**Develop > Authentication and authorization > OAuth Playground**).
2. In **Select app**, pick the sandbox company. Select the `com.intuit.quickbooks.accounting` scope, then **Get authorization code**, then **Connect**.
3. Click **Get tokens**. Add the Realm ID and refresh token to `.env`:

   ```
   INTUIT_REALM_ID=<realm id>
   INTUIT_REFRESH_TOKEN=<refresh token>
   ```

4. Run:

   ```
   docker compose up -d postgres
   npm run connect:quickbooks -- --from-env
   ```

5. Delete those two lines from `.env`. The refresh token has moved into Postgres, encrypted.

## What the real run saves

Real responses go under `results/real/` with tokens, realm IDs and portal IDs stripped. `docs/simulator-sources.md` then gets its "Real check" column filled in, including whether `requestid` stops a duplicate on each record type.
