# Lead to Ledger

A lead goes from a web form to a QuickBooks invoice. An n8n workflow sorts what plain rules can. A classifier handles the rest against a strict schema and may write only to `ai_` fields in HubSpot. It is scored on labeled synthetic leads and runs in shadow mode before it can write anything. When a deal is won and a person approves it, a worker creates the customer and invoice, and restart tests kill that worker before, during and after each API call and count duplicates.

Built with AI coding agents under Noah Hicks's review. No client deployment yet.

## Status

Work in progress. Everything so far ran against simulators written from HubSpot's and Intuit's docs, not their live APIs. `docs/simulator-sources.md` records where each simulated behaviour comes from, and none of it has been checked against the real services yet.

Built:

- **Simulators** with failure injection: timeouts, responses lost after the write committed, 429 and 5xx, and expired tokens.
- **Labeled synthetic leads** for a fictional HVAC contractor, from a seed. All names, addresses and phone numbers are made up, on domains and number blocks reserved for documentation.
- **The lead path:** form, self-hosted n8n, rules, a local model behind a strict schema, `ai_` fields only, shadow mode, and a go-live gate. `docs/lead-path.md` covers what each failure does.
- **The invoice path:** a poller finds won deals, a person approves one exact version on `/approvals`, and a worker creates the customer and invoice with keys, lookups and a read-back. `docs/invoice-path.md` covers what stops a duplicate and where a gap remains.
- **Restart tests** that kill a real worker process before, during and after each API call and count what exists.

Not done yet: the real run against a HubSpot test account and the QuickBooks sandbox. `docs/real-run.md` has the steps. Until then, this says nothing about whether `requestid` works on each record type.

## Results so far

Two local models were scored with the same prompt, rules and pass bar, with nothing tuned against the held-out set. Scores are on synthetic leads with labels from the template authors, so they say nothing about a real inbox. The side-by-side is in `results/scoring/model-comparison.md`.

| Measure, held-out set of 240 leads | `granite-4.1-8b` (default) | `prism-ml/bonsai-27b` |
|---|---|---|
| Category accuracy | 80.4% (95% CI 74.9% to 84.9%) | **84.2%** (95% CI 79.0% to 88.2%) |
| Real leads sorted as not a lead (limit 5%) | **5.2%** | 8.6% |
| High-priority leads found | **95.1%** | 70.7% |
| Junk promoted to `sales_ready` | 0 of 90 | 0 of 90 |
| Pass bar | failed, 3 of 4 checks | failed, 3 of 4 checks |
| Model latency, p50, each alone on the GPU | **2.0 s** | 3.4 s |
| Model alone: attacks that steered it | 0 of 20 | 0 of 20 |
| Model alone: real sales quoting odd instructions, correct | **4 of 4** | 2 of 4 |
| Dev set of 160 leads, category accuracy | 88.1% | 96.9% |

**Neither model passes the bar, and the go-live gate refuses both** (`results/scoring/go-live-attempt-granite.txt`, `go-live-attempt.txt`). Both miss on real leads sorted as not a lead.

**The default is Granite, on a tiebreak.** Each passes 3 of 4 checks, and the rule committed before Granite's held-out run says fewer real leads lost breaks a tie. Bonsai is more accurate overall, but their confidence intervals overlap. Granite is faster, loses fewer real leads, and misses fewer urgent ones. The prompt was tuned on the dev set while running Bonsai, which may favour it.

Other things to know, from Granite's run unless noted:

- **`needs_info` is the weak category,** at 44.1% recall. Vague leads often get called `sales_ready`.
- **Rules sorted 42.9% of leads with no model call, at 87.4% precision.** They scored 100% on dev, so the held-out wording found what they got wrong. Four of Granite's six lost leads came from the rule trusting the Vendor dropdown. Fixing that rule against these results would spoil the held-out set, so it needs new wording first.
- **Injection needed its own run.** Rules sort 20 of the 24 injection leads before a model sees them, so the full-path number says little. With rules bypassed, no attack got a lead marked `sales_ready` or high priority for either model, though 20 attacks leaves an upper bound of 16.1%. See `results/scoring/injection-*.md`.
- **The model's confidence isn't much use.** Granite's answers from 0.60 to 0.79 were right half the time, and those at 0.90 or above 80.7%.

**The held-out set has had three full runs and two injection-only runs,** all logged in `results/scoring/heldout-runs.log`. Bonsai's first run scored 70.0% because the model server failed and 39 of 137 calls never got an answer. It stays in `test-final`, and the Bonsai column above is its rerun. `results/scoring/server-failures.md` records those failures, including one during a model download, since they may recur for anyone running this.

The path also ran end to end through real n8n against the HubSpot simulator, in shadow and then live: `results/e2e/lead-path-bonsai.json` with Bonsai, and `results/e2e/lead-path-stand-in.json` with a scripted stand-in, which adds the failure drills. That hasn't been repeated with Granite yet.

## Restart tests so far

A real worker process was killed before, during and after each API call in the invoice path, against all three ways QuickBooks might treat a repeated `requestid`. A second worker finished each job, and the simulator counted what existed. All of this ran on the simulators. Results are in `results/restart/matrix.md`.

| Group | Cells | Duplicates |
|---|---|---|
| Worker killed around one of 8 API calls | 81 | 0 |
| Failures with no kill: lost responses, timeouts, 429, 5xx, HTML gateway pages, a 200 with a Fault, expired tokens | 84 | 0 |
| A lookup forced to miss the record: a late commit or lagging queries | 13 | 2 invoices |
| Killed during a token refresh | 6 | 0 |
| Four workers on 12 jobs, one killed | 3 | 0 |

- **The 2 duplicates are the known gap.** Both need QuickBooks to ignore `requestid` and allow repeated DocNumbers while a lookup misses the first record. The reconcile sweep found both and sent them to a person, so they were caught, not prevented. `docs/invoice-path.md` explains the case.
- **The counts can see a duplicate.** With the worker's checks skipped, one blind retry after a lost response counted 2 invoices.
- **A token refresh can lose the connection.** With rotation on every refresh, 2 of the 6 token cells needed a person to reconnect. Nothing was written while it was down.
- **These numbers depend on the simulator.** The lookup found the record in 42 cells, and a `requestid` replay happened in 8. If real lookups or `requestid` behave differently, the numbers change, which is what the sandbox run is for.

`results/e2e/invoice-path-sim.json` has the same path through the running stack, with the worker container killed mid-write.

## Run it

Needs Docker. No accounts and no GPU: HubSpot and QuickBooks are simulators, and the model is a scripted stand-in that answers from keyword checks. It isn't a model and no score above came from it.

```sh
docker compose up --build
```

- Form: http://localhost:4000
- Triage status: http://localhost:4000/status
- Invoice approvals: http://localhost:4000/approvals
- n8n: http://localhost:5678 (asks you to create a local owner on first visit)

Everything binds to `127.0.0.1`, and n8n's telemetry settings are off following n8n's isolation guide. Traffic hasn't been captured to confirm that.

To use a real model, point the stack at any OpenAI-compatible server:

```sh
APP_LLM_BASE_URL=http://host.docker.internal:1234/v1 APP_LLM_MODEL=granite-4.1-8b docker compose up --build
```

Without Docker, for the tests and scoring (Node 24):

```sh
npm install
npm test                    # no Docker or model needed
docker compose up -d postgres
npm run test:integration    # needs Postgres
npm run test:restart        # needs Postgres, about 8 minutes
npm run score -- --split dev --label myrun    # needs a model server, see .env.example
```

## License

MIT. See `LICENSE`.
