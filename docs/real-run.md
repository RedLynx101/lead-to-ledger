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

**Confirmed on 2026-11-03:** a service key created in a developer test account worked for every call the real run makes.

**If a test account has no Service keys page** anyway, there are two ways on, neither of them paid:

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

## The run

With both connected:

```
npm run real-run
```

It checks the keys and the QuickBooks connection, printing only pass or fail, starts the stack against the real services, probes the behaviour the simulators had to assume, runs six leads through n8n in shadow and then live, runs a won deal through approval to an invoice, and kills a worker at three points around the QuickBooks writes. Everything it creates is synthetic and marked, and it deletes nothing. The saved run took 2 minutes 14 seconds from starting the stack to writing the results, then brought the stack down.

Real responses go under `results/real/`, with tokens, the realm ID and the HubSpot portal ID removed, including from the `url` HubSpot puts on each record. `results/real/simulator-check.json` compares each one with what the simulators assumed, and `docs/simulator-sources.md` has the same in its "Real check" column.

## What happened on 2026-11-03

The consent click went through `npm run connect:quickbooks -- --print-url`, with the localhost redirect. The first attempt at the run stopped when HubSpot refused a deal with no `pipeline`, which the simulator had accepted. The simulator and every caller were fixed, and the second attempt passed all 29 checks. `results/real/summary.md` has the results.
