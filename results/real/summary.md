# Real run

Run against a HubSpot test account and the QuickBooks sandbox, with synthetic data. Tokens, realm IDs and portal IDs are removed from everything saved here.

- Commit `d511075`, 2026-11-04T00:07:37.592Z to 2026-11-04T00:09:51.981Z. Model: scripted stand-in.
- 29 of 29 checks passed.

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
| hubspot_rate_limit_headers | `["x-hubspot-ratelimit-daily","x-hubspot-ratelimit-daily-remaining","x-hubspot-ratelimit-interval-milliseconds","x-hubspot-ratelimit-max","x-hubspot-ratelimit-remaining","x-hubspot-ratelimit-secondly","x-hubspot-ratelimit-secondly-remaining"]` |
| hubspot_read_by_email_right_after_create | `true` |
| hubspot_search_lag_ms_upper_bound | `227` |
| qb_custom_txn_numbers | `false` |
| qb_requestid_customer | `"replay"` |
| qb_requestid_customer_new_body | `"replayed the first response"` |
| qb_duplicate_display_name | `{"status":400,"code":"6240"}` |
| qb_query_sees_new_invoice_within_ms | `351` |
| qb_doc_number_kept | `true` |
| qb_requestid_invoice | `"replay"` |
| qb_duplicate_doc_number | `"allowed"` |
| qb_bad_query | `{"status":400,"code":"4000"}` |
| qb_bad_token | `{"status":401,"code":"3200"}` |
| kill_drills | `[{"at":"after:qb.create_invoice","invoices":1,"status":"done","foundByLookup":true},{"at":"before:qb.create_invoice","invoices":1,"status":"done","foundByLookup":false},{"at":"after:qb.create_customer","invoices":1,"status":"done","foundByLookup":true}]` |
| qb_duplicates_found_by_reconcile | `0` |

## Checks

- ok [preflight] .env has HUBSPOT_TOKEN, INTUIT_CLIENT_ID, INTUIT_CLIENT_SECRET, LTL_TOKEN_KEY
- ok [preflight] INTUIT_ENVIRONMENT is sandbox
- ok [preflight] QuickBooks is connected
- ok [preflight] a QuickBooks test read works
- ok [preflight] the HubSpot key can read contact properties
- ok [hubspot] the ai_ and ltl_ properties exist
- ok [hubspot] deal pipelines are readable
- ok [hubspot] a contact can be created
- ok [quickbooks] the item "Services" exists
- ok [lead path] shadow: every lead was triaged through n8n
- ok [lead path] shadow: lead0.mw1cy2jj reached the CRM with no ai_ fields
- ok [lead path] shadow: lead1.mw1cy2jj reached the CRM with no ai_ fields
- ok [lead path] shadow: lead2.mw1cy2jj reached the CRM with no ai_ fields
- ok [lead path] live: every lead was triaged through n8n
- ok [lead path] live: lead3.mw1cy2jj holds exactly the stored ai_ values
- ok [lead path] live: lead4.mw1cy2jj holds exactly the stored ai_ values
- ok [lead path] live: lead5.mw1cy2jj holds exactly the stored ai_ values
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
