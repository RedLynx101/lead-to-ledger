# Where the simulators' behaviour comes from

A simulator only proves the code matches a reading of the docs. This file records which reading, so nobody mistakes a guess for a fact. Docs were read on 2026-11-01.

**Basis** says where a behaviour comes from:
- **Docs:** stated on the vendor's page.
- **Secondary:** from another integrator's report or a community thread, not the vendor's docs.
- **Assumed:** the docs are silent or vague, and this is a guess.

**Real check** is what the real run showed on 2026-11-04 (UTC): one HubSpot developer test account and one QuickBooks sandbox company, with synthetic data. Each result is a single observation, not a guarantee. Four rows were wrong and the simulators now match the real response; only the deal `pipeline` one broke anything. The same comparison, with a verdict per behaviour, is in `results/real/simulator-check.json`, and the raw responses are in `results/real/samples/`.

## HubSpot

Sources:
[object APIs](https://developers.hubspot.com/docs/api-reference/latest/crm/using-object-apis),
[contacts](https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/guide),
[deals](https://developers.hubspot.com/docs/api-reference/crm-deals-v3/guide),
[search](https://developers.hubspot.com/docs/api-reference/search/guide),
[properties](https://developers.hubspot.com/docs/api-reference/latest/crm/properties/guide),
[associations](https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/guide),
[usage limits](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines),
[service keys](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys),
[versioning](https://developers.hubspot.com/docs/developer-tooling/platform/versioning),
[migration guide](https://developers.hubspot.com/docs/api-reference/legacy/migration-guide).

| Behaviour | Basis | Real check |
|---|---|---|
| `/crm/v3/...` and `/crm/{area}/2026-09/...` reach the same records | Docs. v3 is legacy and unsupported from September 2027; the guide says many endpoints have identical contracts but doesn't list which | Dated paths worked for every call. `v3` paths weren't tried |
| Create, read and patch record shape: `id`, `properties`, `createdAt`, `updatedAt`, `archived` | Docs | Matched. Real records also carry a `url` into HubSpot's app, with the portal ID in it; the simulator leaves it out and nothing reads it |
| Read and patch by email with `idProperty=email` | Docs | Read by email worked straight after a create. Patch by email wasn't tried |
| Requested but undefined properties are omitted; defined with no value are `null` | Docs | Not checked |
| Default properties returned for contacts and deals | Docs, for search. Assumed the same for reads | Matched on search: the same six contact properties |
| Duplicate email is `409` with `category: CONFLICT` and "Contact already exists. Existing ID: N" | Secondary (community threads, integrator docs). The docs page doesn't cover it | Matched: `409 CONFLICT`, the same message |
| Unknown property is `400 VALIDATION_ERROR` with code `PROPERTY_DOESNT_EXIST` | Docs | Matched |
| Exact wording and nesting of validation bodies (`errors`, `message` with embedded JSON) | Assumed from v3-era samples | Close: detail entries carry `details: []`, not `localizedErrorMessage`. **Simulator fixed** |
| Read-only property is rejected with `READ_ONLY_VALUE` | Assumed | Not checked |
| Enumeration values outside the options are rejected with `INVALID_OPTION` | Assumed | Not checked |
| Batch upsert by `idProperty`, `new` flag on results | Docs for the call; `new` flag assumed | Upsert by email worked through n8n for six leads. The `new` flag wasn't inspected |
| Batch upsert by email is all or nothing | Docs say partial upserts aren't supported with email. All-or-nothing is how the simulator reads that | Not checked |
| Search paths, operators, 200 per page, 10,000 result cap, 5 groups, 6 filters per group, 18 total | Docs | An email `EQ` search and the poller's filtered, sorted deal search worked. Limits not checked |
| Search is oldest first by default, sort takes one rule, cursor is `paging.next.after` | Docs | Not checked beyond the poller working |
| Search lags writes | Docs: "It may take a few moments". The simulator's default of 1,500 ms is a guess, because no number is published | One check: found within 227 ms. The simulator's 1,500 ms stays as the harsher case |
| Direct reads aren't behind the search index | Assumed. The search-before-create gap depends on this | Consistent: a read by email found the contact straight after the create |
| Search rate limit: 5 a second per account, and no rate limit headers | Docs | Search responses carried the two daily headers but not the others. The simulator sends none, and nothing reads them. The 5 a second limit wasn't tested |
| General limit of 100 per 10 seconds on Free and Starter, shared by service keys | Docs | Headers on every general call, plus daily and per-second ones the simulator doesn't send. The limit wasn't reached |
| `429` fields: `status`, `message`, `errorType`, `correlationId`, `requestId`, `policyName` | Docs | Not checked: no 429 came back |
| `policyName` values `TEN_SECONDLY_ROLLING` and `SECONDLY` | Docs name `DAILY` and `TEN_SECONDLY_ROLLING`; `SECONDLY` is assumed for search | Not checked |
| `401` categories `INVALID_AUTHENTICATION` and `EXPIRED_AUTHENTICATION` | Secondary | Matched: `INVALID_AUTHENTICATION` for a bad token. Expiry not checked |
| Service keys don't refresh; they expire only by rotation or deletion | Docs. A `401` is treated as a stop, not a refresh | A service key in a developer test account worked for every call. Rotation not checked |
| `403 MISSING_SCOPES`, `423 Locked` | Docs | Not checked |
| `404` body with `category: OBJECT_NOT_FOUND` | Secondary | **Mismatch:** a GET for a missing contact gave `404` with an empty body. **Simulator fixed** for GET. The client already treated any 404 as not found |
| Property create fields, `type` and `fieldType` pairs, up to 10 unique properties per object | Docs | Not seen: the properties existed before the saved run |
| Creating a property or group that exists is `409 OBJECT_ALREADY_EXISTS` | Secondary | Matched: all 10 properties and 2 groups came back `409` and were read as existing |
| Group create path, `/crm/{area}/{version}/{object}/groups` | Assumed; the page doesn't document it | Matched: the path answered `409` for both existing groups |
| `hasUniqueValue` blocks a second record with `409` | Docs for the flag; the `409` is assumed | Not checked |
| Association type IDs: deal to contact 3, contact to deal 4 | Docs | Matched: deals created with type 3 were read back with their contact by the worker |
| `associations` on create, `?associations=` on read, `PUT .../associations/default/...` | Docs | Matched for create and read. `PUT` not tried |
| Deal needs `dealname` and `dealstage`; default pipeline stage IDs including `closedwon` | Docs for required fields. Docs say to read stage IDs from the pipelines API, so the code does | **Mismatch:** `pipeline` is required too, and the first attempt stopped on it. **Simulator fixed**, and every caller now sends one. `closedwon` is in the default pipeline, as assumed |
| 502, 503 and 504 come back as HTML | Assumed: a gateway in front of the API. Clients must not assume JSON | Not checked |

## QuickBooks Online

Sources, all on developer.intuit.com under `/app/developer/qbo/docs/`:
[field definitions and `requestid`](https://developer.intuit.com/app/developer/qbo/docs/learn/learn-basic-field-definitions),
[error codes](https://developer.intuit.com/app/developer/qbo/docs/develop/troubleshooting/error-codes),
[OAuth 2.0](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0),
[authorization FAQ](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/faq),
[customer](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/customer),
[invoice](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice),
[query syntax](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries),
[REST formats](https://developer.intuit.com/app/developer/qbo/docs/learn/rest-api-features).

| Behaviour | Basis | Real check |
|---|---|---|
| `requestid` replays the first response | Docs, but the page gives one invoice example. **The question the real run has to answer, per record type.** The simulator makes it a per-type setting: `replay`, `duplicate_error`, `ignored` | **Replays, for customers and invoices:** the second call returned the first record's Id. The simulator's `replay` setting matches. One sandbox company, one check per type |
| Fault 600 "Duplicate Request ID" exists | Docs list it without saying when it fires instead of a replay | Not seen |
| Up to 50 characters, unique per realm | Docs | Not checked beyond the keys used |
| A failed attempt isn't remembered by `requestid` | Assumed | Not checked |
| Same `requestid` with a different body replays the first response | Assumed; the docs example sends the same content | Matched for customers: the changed body was ignored and the first response came back |
| OAuth URLs, `state` required, `code` single use, Basic auth, token response fields, 3,600-second access token | Docs | Consent and code exchange worked through `connect:quickbooks -- --print-url`. Token lifetime and refresh weren't exercised |
| Reusing a code returns `invalid_grant` and may revoke the first exchange's tokens | Docs | Not checked |
| Refresh token value changes at least every 24 hours; the old value stops working | Docs. The simulator's default rotates on every refresh, the harshest reading. `after_24h` is the other setting | Not checked |
| Redirect URIs must match exactly | Docs. The redirect URI page allows localhost without HTTPS for sandbox apps, and the FAQ says `https` only with no IP addresses | Matched: `http://localhost:8765/callback` was accepted for the sandbox app |
| `POST /v3/company/{realm}/customer` and `/invoice` minimum bodies and response shape, including `time` | Docs | Matched, including `time` |
| DisplayName unique across customers, vendors and employees; no colon, tab or newline; Fault 6240 | Docs. The simulator checks customers only | Matched customer to customer: `400`, Fault 6240. Vendors and employees not checked |
| 6240 detail text naming the existing ID | Docs: "The customer ID is: XXX". Exact wording unverified, so clients shouldn't parse it | **Mismatch:** the detail was "The name supplied already exists. : null", with no ID. **Simulator fixed.** Nothing parsed it; the worker looks the customer up |
| Invoice needs `CustomerRef` and at least one `Line`; totals, `DueDate` and `SubTotalLineDetail` filled in | Docs for the fields and sample; 30-day due date comes from the sample | Matched: a minimal invoice was accepted, due 30 days out |
| DocNumber up to 21 characters; `DocNumber` is filterable | Docs | Matched: queries by DocNumber found the invoices |
| DocNumber is not an idempotency key, and doesn't always block duplicates | Docs: "It does not silently return an existing record"; "two Invoices in the same company cannot share one (depending on settings)". The simulator's default is no rejection, the harder case | **Confirmed: the sandbox allowed a second invoice with the same DocNumber** under a new `requestid`, as the simulator's default assumes |
| Fault 6140 on a duplicate, `include=allowduplicatedocnum` | Docs | Not seen, since duplicates were allowed |
| With `CustomTxnNumbers` off, supplied DocNumbers are kept | Assumed. Docs warn against sending one in that mode: "it can lead to unwanted duplicates" | Matched: `CustomTxnNumbers` was off and the supplied DocNumber was kept |
| HTTP 200 with a `Fault` in the body | Docs | Not seen |
| Fault JSON shape: `Fault.Error[].Message, Detail, code, element`, `Fault.type` | Docs show XML with the same fields; the JSON form is secondary | Matched for 6240 and 4000 |
| `401` body with lowercase `fault.error` and code 3200 | Secondary. Docs give only the code. Clients must accept either case | Matched: lowercase `fault.error`, code 3200 |
| `429` body with `ThrottleExceeded` and code 3001; 500 requests a minute per realm | Secondary; the docs page for limits wasn't available | Not checked |
| API answers XML unless `Accept: application/json` | Docs mention `Accept` is optional and JSON is recommended. XML as the default is secondary | Not checked: every call sent `Accept: application/json` |
| Query syntax, ignores case, backslash escapes, no `OR`, `QueryResponse` shape | Docs. JSON field names come from the invoice sample | Matched for the queries the worker makes |
| Query with no match returns an empty `QueryResponse` | Assumed | Matched: `{"QueryResponse":{}}` |
| A query sees a new record at once | Assumed. The docs don't say, and the worker's lookups depend on it. No lag by default, and `queryLagMs` lets the restart tests measure what a lag would cost | One check: a DocNumber query found a new invoice within 351 ms, counting its own round trip |
| `Active IN (true, false)` includes inactive customers | Docs | Not checked |
| A customer's balance moves when an invoice is created | Assumed. The restart tests use it to spot a double charge | Not checked |
| Fault 4000 or 4001 on a bad query | Docs | Matched: 4000 |
| Sandbox company has sample customers and items, including `Services` | Docs samples, and the simulator's seed is smaller than the real set | Matched: `Services` exists |
| 502, 503 and 504 come back as HTML | Assumed: a gateway in front of the API | Not checked |

## The scripted model stand-in

`src/simulators/llm.ts` isn't written from anyone's docs and isn't a model. It answers from keyword checks, so the stack runs with no GPU, and it can return bad output on command for tests. No score in this repo comes from it.
