# The invoice path

From a won deal to a QuickBooks invoice, and how it stays single when things die.

```
HubSpot deal reaches closed won
  -> poller finds it (no webhook, so no public URL) and writes one durable job row
  -> a person approves that exact content on /approvals
  -> a worker claims the row with a conditional update
  -> re-reads the deal, stops if anything changed
  -> customer: look up, then create with a key
  -> invoice:  look up, then create with a key
  -> read the invoice back and count
  -> note the invoice on the deal
```

## The durable row, the claim, the key

**The row.** `invoice_jobs` has one row per deal, enforced by a unique constraint. Polling the same deal a hundred times still gives one job.

**The claim.** `SELECT ... FOR UPDATE SKIP LOCKED` in a transaction, so only one worker gets a job. Each claim gets a lease and a lease token. A worker that dies stops renewing, and the next worker takes over once the lease expires. Every state change includes the lease token, so a stale worker that wakes up later fails its next update and stops.

**The key.** Each record has one fixed key, with nothing in it that varies by attempt: `ltl-customer-<contact id>` and `ltl-invoice-<deal id>`. It goes to QuickBooks as `requestid`.

**The journal.** `external_calls` gets a row before each write. A worker that finds one still at `intent` knows the last attempt's outcome is unknown, so it waits out a settling period and looks before it writes again.

## Approval

An approval is tied to one job and a hash of exactly what will be sent.

| Attempt | Result |
|---|---|
| Approve content that changed after the page loaded | Refused. The form carries the hash the person saw. |
| Approve twice | Refused. The job isn't waiting any more. |
| Edit the deal after approval, seen by the poller | The job goes back to waiting, and an alert is raised. |
| Edit the deal after approval, not seen yet | The worker re-reads the deal before writing, and sends it back. |
| Use another job's approval | Refused at claim. |
| Put a finished job back in the queue | Refused at claim. Its approval is spent, and the job goes to a person. |
| Edit the deal after the invoice exists | Nothing changes in QuickBooks. A person is told, once. |

The approver's name is whatever gets typed, because there's no login on this local page. A real deployment needs it to come from a sign-in.

## How each write stays single

Being honest about this matters more than the mechanism, so here's what's assumed and what isn't.

**QuickBooks customers.** Intuit requires `DisplayName` to be unique, and this repo puts the HubSpot contact ID in it. So the name both finds the customer after a lost response and blocks a second one, whatever `requestid` does. If QuickBooks says the name exists but no search finds it, a person decides.

**QuickBooks invoices.** Three layers, because none is enough by itself:

1. `requestid`. Intuit's docs say a repeat returns the first response, and they also list error 600 "Duplicate Request ID". **Whether it holds for each record type is what the sandbox run has to answer.** The restart tests run against all three possible behaviours.
2. A lookup by `DocNumber` before every create, which is the pattern Intuit recommends. `DocNumber` is the worker's chosen handle, `LTL-<deal id>`. Intuit's docs say it isn't an idempotency key and only blocks duplicates "depending on settings", so the tests assume it doesn't.
3. A read-back after the create, and a reconcile sweep later. More than one invoice with the same number goes to a person. **This code never deletes or voids anything.**

**The gap that remains.** A lookup can miss a record in two ways: a killed worker's request commits after the settling period, or queries lag behind writes, which Intuit's docs don't rule out. If either happens, QuickBooks ignores `requestid`, and DocNumbers aren't unique, a duplicate lands. The restart tests force both cases and count them. The reconcile sweep finds the duplicate and sends it to a person, so it's caught, not prevented. A longer settling period narrows the first window at the cost of slower recovery. The sandbox run measures whether either condition is real.

**HubSpot.** It has no general idempotency key, so the code doesn't rely on one:

- Contacts are upserted by email, which HubSpot keeps unique, so a repeat updates the same contact.
- `ai_` and `ltl_` fields are written with PATCH, where a repeat sets the same values.
- A plain create isn't retried. This repo only creates deals in demos and tests.
- Search lags writes, so a search before a create could miss a record committed a moment ago. Production code doesn't use search before a create: it reads by `idProperty` or upserts. The poller's search only needs to be eventually right, because its cursor overlaps and there's one job per deal.

**QuickBooks tokens.** Intuit rotates refresh tokens, and a refresh that a process dies in the middle of can lose the connection. No code on this side can close that. The job waits, a person reconnects, and nothing is written in between. It costs a click, not a duplicate.

## Restart tests

`scripts/restart-tests.ts` kills a real worker process before, during and after each API call, runs a second worker, and has the simulators count what exists. Results are in `results/restart/`.

- **Before and after:** the worker ends itself at an exact point in the code, with no cleanup.
- **During:** the simulator holds the request, and the harness kills the worker from outside while it waits. The simulator then finishes the write or abandons it.
- **Failures with no kill:** a response lost after commit, timeouts, 429, 5xx, HTML gateway pages, and a 200 with a Fault in the body.
- **Control:** a blind retry with the worker's checks skipped, to prove the counts can see a duplicate.

These run on simulators. They show the logic holds if QuickBooks and HubSpot behave as the simulators do. The sandbox run checks that assumption.

## Known gaps

- Alerts are rows on the status page. Nothing pushes them to a person yet.
- The approver's name is self-typed.
- The poller takes the deal's lowest-numbered contact as the customer.
- One line per invoice, using one item, and no tax handling. A real client's invoices will need more.
- Deleted or voided invoices aren't noticed. A lookup that finds nothing after a person deleted an invoice would create it again if the job were re-run.
