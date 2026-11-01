# Where the simulators' behaviour comes from

A simulator only proves the code matches a reading of the docs. This file records which reading, so nobody mistakes a guess for a fact. Docs were read on 2026-11-01.

**Basis** says where a behaviour comes from:
- **Docs:** stated on the vendor's page.
- **Secondary:** from another integrator's report or a community thread, not the vendor's docs.
- **Assumed:** the docs are silent or vague, and this is a guess.

**Real check** is what the real sandbox showed. Every row says "not yet" until the real run against the HubSpot test account and QuickBooks sandbox, which hasn't happened.

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
| `/crm/v3/...` and `/crm/{area}/2026-09/...` reach the same records | Docs. v3 is legacy and unsupported from September 2027; the guide says many endpoints have identical contracts but doesn't list which | not yet |
| Create, read and patch record shape: `id`, `properties`, `createdAt`, `updatedAt`, `archived` | Docs | not yet |
| Read and patch by email with `idProperty=email` | Docs | not yet |
| Requested but undefined properties are omitted; defined with no value are `null` | Docs | not yet |
| Default properties returned for contacts and deals | Docs, for search. Assumed the same for reads | not yet |
| Duplicate email is `409` with `category: CONFLICT` and "Contact already exists. Existing ID: N" | Secondary (community threads, integrator docs). The docs page doesn't cover it | not yet |
| Unknown property is `400 VALIDATION_ERROR` with code `PROPERTY_DOESNT_EXIST` | Docs | not yet |
| Exact wording and nesting of validation bodies (`errors`, `message` with embedded JSON) | Assumed from v3-era samples | not yet |
| Read-only property is rejected with `READ_ONLY_VALUE` | Assumed | not yet |
| Enumeration values outside the options are rejected with `INVALID_OPTION` | Assumed | not yet |
| Batch upsert by `idProperty`, `new` flag on results | Docs for the call; `new` flag assumed | not yet |
| Batch upsert by email is all or nothing | Docs say partial upserts aren't supported with email. All-or-nothing is how the simulator reads that | not yet |
| Search paths, operators, 200 per page, 10,000 result cap, 5 groups, 6 filters per group, 18 total | Docs | not yet |
| Search is oldest first by default, sort takes one rule, cursor is `paging.next.after` | Docs | not yet |
| Search lags writes | Docs: "It may take a few moments". The simulator's default of 1,500 ms is a guess, because no number is published | not yet |
| Direct reads aren't behind the search index | Assumed. The search-before-create gap depends on this | not yet |
| Search rate limit: 5 a second per account, and no rate limit headers | Docs | not yet |
| General limit of 100 per 10 seconds on Free and Starter, shared by service keys | Docs | not yet |
| `429` fields: `status`, `message`, `errorType`, `correlationId`, `requestId`, `policyName` | Docs | not yet |
| `policyName` values `TEN_SECONDLY_ROLLING` and `SECONDLY` | Docs name `DAILY` and `TEN_SECONDLY_ROLLING`; `SECONDLY` is assumed for search | not yet |
| `401` categories `INVALID_AUTHENTICATION` and `EXPIRED_AUTHENTICATION` | Secondary | not yet |
| Service keys don't refresh; they expire only by rotation or deletion | Docs. A `401` is treated as a stop, not a refresh | not yet |
| `403 MISSING_SCOPES`, `423 Locked` | Docs | not yet |
| `404` body with `category: OBJECT_NOT_FOUND` | Secondary | not yet |
| Property create fields, `type` and `fieldType` pairs, up to 10 unique properties per object | Docs | not yet |
| Creating a property or group that exists is `409 OBJECT_ALREADY_EXISTS` | Secondary | not yet |
| Group create path, `/crm/{area}/{version}/{object}/groups` | Assumed; the page doesn't document it | not yet |
| `hasUniqueValue` blocks a second record with `409` | Docs for the flag; the `409` is assumed | not yet |
| Association type IDs: deal to contact 3, contact to deal 4 | Docs | not yet |
| `associations` on create, `?associations=` on read, `PUT .../associations/default/...` | Docs | not yet |
| Deal needs `dealname` and `dealstage`; default pipeline stage IDs including `closedwon` | Docs for required fields. Docs say to read stage IDs from the pipelines API, so the code does | not yet |
| 502, 503 and 504 come back as HTML | Assumed: a gateway in front of the API. Clients must not assume JSON | not yet |

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
| `requestid` replays the first response | Docs, but the page gives one invoice example. **The question the real run has to answer, per record type.** The simulator makes it a per-type setting: `replay`, `duplicate_error`, `ignored` | not yet |
| Fault 600 "Duplicate Request ID" exists | Docs list it without saying when it fires instead of a replay | not yet |
| Up to 50 characters, unique per realm | Docs | not yet |
| A failed attempt isn't remembered by `requestid` | Assumed | not yet |
| Same `requestid` with a different body replays the first response | Assumed; the docs example sends the same content | not yet |
| OAuth URLs, `state` required, `code` single use, Basic auth, token response fields, 3,600-second access token | Docs | not yet |
| Reusing a code returns `invalid_grant` and may revoke the first exchange's tokens | Docs | not yet |
| Refresh token value changes at least every 24 hours; the old value stops working | Docs. The simulator's default rotates on every refresh, the harshest reading. `after_24h` is the other setting | not yet |
| Redirect URIs must match exactly | Docs. The FAQ says `https` only with no IP addresses; whether `http://localhost` is allowed for development keys is unchecked | not yet |
| `POST /v3/company/{realm}/customer` and `/invoice` minimum bodies and response shape, including `time` | Docs | not yet |
| DisplayName unique across customers, vendors and employees; no colon, tab or newline; Fault 6240 | Docs. The simulator checks customers only | not yet |
| 6240 detail text naming the existing ID | Docs: "The customer ID is: XXX". Exact wording unverified, so clients shouldn't parse it | not yet |
| Invoice needs `CustomerRef` and at least one `Line`; totals, `DueDate` and `SubTotalLineDetail` filled in | Docs for the fields and sample; 30-day due date comes from the sample | not yet |
| DocNumber up to 21 characters; `DocNumber` is filterable | Docs | not yet |
| DocNumber is not an idempotency key, and doesn't always block duplicates | Docs: "It does not silently return an existing record"; "two Invoices in the same company cannot share one (depending on settings)". The simulator's default is no rejection, the harder case | not yet |
| Fault 6140 on a duplicate, `include=allowduplicatedocnum` | Docs | not yet |
| With `CustomTxnNumbers` off, supplied DocNumbers are kept | Assumed. Docs warn against sending one in that mode: "it can lead to unwanted duplicates" | not yet |
| HTTP 200 with a `Fault` in the body | Docs | not yet |
| Fault JSON shape: `Fault.Error[].Message, Detail, code, element`, `Fault.type` | Docs show XML with the same fields; the JSON form is secondary | not yet |
| `401` body with lowercase `fault.error` and code 3200 | Secondary. Docs give only the code. Clients must accept either case | not yet |
| `429` body with `ThrottleExceeded` and code 3001; 500 requests a minute per realm | Secondary; the docs page for limits wasn't available | not yet |
| API answers XML unless `Accept: application/json` | Docs mention `Accept` is optional and JSON is recommended. XML as the default is secondary | not yet |
| Query syntax, ignores case, backslash escapes, no `OR`, `QueryResponse` shape | Docs. JSON field names come from the invoice sample | not yet |
| Query with no match returns an empty `QueryResponse` | Assumed | not yet |
| Fault 4000 or 4001 on a bad query | Docs | not yet |
| Sandbox company has sample customers and items, including `Services` | Docs samples, and the simulator's seed is smaller than the real set | not yet |
| 502, 503 and 504 come back as HTML | Assumed: a gateway in front of the API | not yet |
