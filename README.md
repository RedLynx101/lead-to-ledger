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

Model: `prism-ml/bonsai-27b`, a small local model, through LM Studio. Scores are on synthetic leads with labels from the template authors, so they say nothing about a real inbox.

| Set | Category accuracy | Real leads sorted as not a lead | Pass bar | File |
|---|---|---|---|---|
| Dev, 160 leads, prompt tuned against it | 96.9% | 2.7% | passed | `results/scoring/dev-p2.md` |
| Held-out, 240 leads, first run | 70.0% | 6.9% | failed | `results/scoring/test-final.md` |
| Held-out, 240 leads, rerun | **84.2%** (95% CI 79.0% to 88.2%) | 8.6% | failed | `results/scoring/test-rerun-1.md` |

The gap between dev and held-out is the prompt fitting wording it was tuned on, and the held-out number is the one to believe.

The first held-out run isn't a fair measure of the model: the model server failed partway through, and 39 of 137 model calls never got an answer, so they count as wrong. The rerun used the same prompt, rules and pass bar, with nothing tuned in between. `results/scoring/heldout-runs.log` records both runs.

From the rerun:

- It missed the pass bar on one check: 8.6% of real leads were sorted as not a lead, against a limit of 5%. Four of those ten came from a rule trusting the Vendor dropdown, and six from the model. The go-live gate refuses this run (`results/scoring/go-live-attempt.txt`).
- `needs_info` is the weak category, at 41.2% recall. The model tends to call a vague lead `sales_ready`.
- No junk reached `sales_ready` (0 of 90).
- No injection attempt got a lead marked `sales_ready` or high priority when it wasn't (0 of 24), but that says little about the model. Rules sorted 20 of the 24 before it saw them, and the 4 it did see were real `sales_ready` leads quoting odd instructions, which it got right 2 times out of 4. Whether an attack aimed at junk would steer this model hasn't been measured.
- Rules sorted 42.9% of leads with no model call, at 87.4% precision. They scored 100% on dev, so the held-out wording found what they got wrong.
- The model's confidence isn't much use. Answers at 0.90 or above were right 85.1% of the time, and answers from 0.80 to 0.89 only 66.7%.

The path also ran end to end through real n8n against the HubSpot simulator, in shadow and then live: `results/e2e/lead-path-bonsai.json` with this model, and `results/e2e/lead-path-stand-in.json` with a scripted stand-in, which adds the failure drills.

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
APP_LLM_BASE_URL=http://host.docker.internal:1234/v1 APP_LLM_MODEL=prism-ml/bonsai-27b docker compose up --build
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
