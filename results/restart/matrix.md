# Restart tests: matrix

Run against the HubSpot and QuickBooks simulators, not the real APIs. A real worker process is killed, a second one finishes the job, and the simulator counts what exists. Real `requestid` behaviour is unknown until the sandbox run, so each cell runs against all three simulated behaviours.

- Commit `70a4356`, Node v24.22.1 on win32, 2026-11-01T17:50:31.221Z to 2026-11-01T17:57:56.699Z.
- Lease 1 s, settling period 600 ms, request held 300 ms, late commit 3100 ms.
- Control: with the worker's checks skipped, one blind retry after a lost response counted 2 invoices, and the reconcile sweep found it. So the counts below can see a duplicate.

## Result

**187 of 187 cells passed. Duplicates: 0 customers, 2 invoices.** Outside the known gap: 0.

| Group | Cells | Customer duplicates | Invoice duplicates | Failed |
|---|---|---|---|---|
| kill | 81 | 0 | 0 | 0 |
| late_commit | 7 | 0 | 1 | 0 |
| query_lag | 6 | 0 | 1 | 0 |
| failure | 84 | 0 | 0 | 0 |
| token | 6 | 0 | 0 | 0 |
| concurrency | 3 | 0 | 0 | 0 |

| `requestid` behaviour | Cells | Customer duplicates | Invoice duplicates | Failed |
|---|---|---|---|---|
| replay | 68 | 0 | 0 | 0 |
| duplicate_error | 56 | 0 | 0 | 0 |
| ignored | 57 | 0 | 2 | 0 |
| n/a | 6 | 0 | 0 | 0 |

## Kills, by call

| Call | Cells | Customer duplicates | Invoice duplicates | Failed |
|---|---|---|---|---|
| hubspot.get_deal | 9 | 0 | 0 | 0 |
| qb.query_item | 9 | 0 | 0 | 0 |
| qb.query_customer | 9 | 0 | 0 | 0 |
| qb.create_customer | 12 | 0 | 0 | 0 |
| qb.query_invoice | 9 | 0 | 0 | 0 |
| qb.create_invoice | 12 | 0 | 0 | 0 |
| qb.verify_invoice | 9 | 0 | 0 | 0 |
| hubspot.patch_deal | 12 | 0 | 0 | 0 |

## Kills, by when

| When | Cells | Customer duplicates | Invoice duplicates | Failed |
|---|---|---|---|---|
| before | 24 | 0 | 0 | 0 |
| during_commits | 24 | 0 | 0 | 0 |
| after | 24 | 0 | 0 | 0 |
| during_abandoned | 9 | 0 | 0 | 0 |

## The known gap

The lookup before a create can miss a record in two ways: the first attempt commits after the settling period, or queries lag behind writes. If QuickBooks also ignores `requestid` and DocNumbers aren't unique, a duplicate lands. These cells force both. A job marked needs_person stopped and asked instead of guessing.

| Cell | Customers | Invoices | Job status | Found by reconcile |
|---|---|---|---|---|
| late_commit/replay/qb.create_customer | 1 | 1 | done | 0 |
| late_commit/replay/qb.create_invoice | 1 | 1 | done | 0 |
| late_commit/duplicate_error/qb.create_customer | 1 | 1 | done | 0 |
| late_commit/duplicate_error/qb.create_invoice | 1 | 1 | done | 0 |
| late_commit/ignored/qb.create_customer | 1 | 1 | done | 0 |
| late_commit/ignored/qb.create_invoice | 1 | 2 | needs_person | 1 |
| late_commit/ignored/qb.create_invoice/unique_doc_numbers | 1 | 1 | done | 0 |
| query_lag/replay/qb.create_customer | 1 | 1 | done | 0 |
| query_lag/replay/qb.create_invoice | 1 | 1 | done | 0 |
| query_lag/duplicate_error/qb.create_customer | 1 | 0 | needs_person | 0 |
| query_lag/duplicate_error/qb.create_invoice | 1 | 1 | needs_person | 0 |
| query_lag/ignored/qb.create_customer | 1 | 0 | needs_person | 0 |
| query_lag/ignored/qb.create_invoice | 1 | 2 | needs_person | 1 |

## Token refresh

A process killed after Intuit rotates a refresh token and before the new value is saved loses the connection. These cells show what that costs.

| Cell | Needed a reconnect | Invoices | Job status |
|---|---|---|---|
| token/every_refresh/before | no | 1 | done |
| token/every_refresh/during | yes | 1 | done |
| token/every_refresh/after | yes | 1 | done |
| token/after_24h/before | no | 1 | done |
| token/after_24h/during | no | 1 | done |
| token/after_24h/after | no | 1 | done |
