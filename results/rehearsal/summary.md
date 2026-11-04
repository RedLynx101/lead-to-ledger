# Rehearsal on the simulators

The real-run script run against the simulators, to prove it works before keys exist. These facts describe the simulators, not HubSpot or QuickBooks.

- Commit `d511075`, 2026-11-04T00:11:40.975Z to 2026-11-04T00:12:44.708Z. Model: scripted stand-in.
- 27 of 27 checks passed.

## What the simulators had to assume

| Fact | Result |
|---|---|
| hubspot_property_setup | `{"group:ai_triage":"exists","ai_category":"exists","ai_priority":"exists","ai_summary":"exists","ai_confidence":"exists","ai_needs_review":"exists","ai_source":"exists","ai_model":"exists","ltl_synthetic":"exists","group:ltl_ledger":"exists","ltl_qb_invoice_id":"exists","ltl_qb_doc_number":"exists"}` |
| hubspot_won_stage_present | `true` |
| hubspot_won_pipeline | `"default"` |
| hubspot_deal_without_pipeline | `{"status":400,"category":"VALIDATION_ERROR"}` |
| hubspot_duplicate_email | `{"status":409,"category":"CONFLICT"}` |
| hubspot_unknown_property | `{"status":400,"category":"VALIDATION_ERROR"}` |
| hubspot_not_found | `{"status":404,"category":null}` |
| hubspot_bad_token | `{"status":401,"category":"INVALID_AUTHENTICATION"}` |
| hubspot_rate_limit_headers | `["x-hubspot-ratelimit-interval-milliseconds","x-hubspot-ratelimit-max","x-hubspot-ratelimit-remaining"]` |
| hubspot_read_by_email_right_after_create | `true` |
| hubspot_search_lag_ms_upper_bound | `2033` |
| qb_custom_txn_numbers | `false` |
| qb_requestid_customer | `"replay"` |
| qb_requestid_customer_new_body | `"replayed the first response"` |
| qb_duplicate_display_name | `{"status":400,"code":"6240"}` |
| qb_query_sees_new_invoice_within_ms | `3` |
| qb_doc_number_kept | `true` |
| qb_requestid_invoice | `"replay"` |
| qb_duplicate_doc_number | `"allowed"` |
| qb_bad_query | `{"status":400,"code":"4000"}` |
| qb_bad_token | `{"status":401,"code":"3200"}` |
| kill_drills | `[{"at":"after:qb.create_invoice","invoices":1,"status":"done","foundByLookup":true},{"at":"before:qb.create_invoice","invoices":1,"status":"done","foundByLookup":false},{"at":"after:qb.create_customer","invoices":1,"status":"done","foundByLookup":true}]` |
| qb_duplicates_found_by_reconcile | `0` |

## Checks

- ok [preflight] QuickBooks is connected
- ok [preflight] a QuickBooks test read works
- ok [preflight] the HubSpot key can read contact properties
- ok [hubspot] the ai_ and ltl_ properties exist
- ok [hubspot] deal pipelines are readable
- ok [hubspot] a contact can be created
- ok [quickbooks] the item "Services" exists
- ok [lead path] shadow: every lead was triaged through n8n
- ok [lead path] shadow: lead0.mw1d3ago reached the CRM with no ai_ fields
- ok [lead path] shadow: lead1.mw1d3ago reached the CRM with no ai_ fields
- ok [lead path] shadow: lead2.mw1d3ago reached the CRM with no ai_ fields
- ok [lead path] live: every lead was triaged through n8n
- ok [lead path] live: lead3.mw1d3ago holds exactly the stored ai_ values
- ok [lead path] live: lead4.mw1d3ago holds exactly the stored ai_ values
- ok [lead path] live: lead5.mw1d3ago holds exactly the stored ai_ values
- ok [lead path] a replayed webhook changed no ai_ field
- ok [invoice path] the worker polled the won deal into a job
- ok [invoice path] approval through the page
- ok [invoice path] the job finished
- ok [invoice path] one invoice in QuickBooks
- ok [invoice path] the invoice is noted on the deal
- ok [kill drills] after:qb.create_invoice: the worker died at that point
- ok [kill drills] after:qb.create_invoice: one invoice after a restart
- ok [kill drills] before:qb.create_invoice: the worker died at that point
- ok [kill drills] before:qb.create_invoice: one invoice after a restart
- ok [kill drills] after:qb.create_customer: the worker died at that point
- ok [kill drills] after:qb.create_customer: one invoice after a restart

Raw responses, scrubbed, are in `samples/`.
