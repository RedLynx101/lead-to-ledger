# Labeling guide for the synthetic leads

Every lead in `data/leads/` is synthetic. A generator wrote them from templates, and each template's author chose the label using this guide. No real person, company or sales team is involved, so the labels show how a lead was written to be read, not how a real sales team would judge it. The form text, names and addresses are made up.

The labeled sets exist to measure the triage step. They say nothing about how it would do on a real client's inbound mail.

## The fictional business

**Example Mechanical Co.** is a made-up commercial HVAC contractor.

- **Sells:** planned maintenance agreements, emergency repair for commercial accounts, and replacement or retrofit of rooftop units (RTUs), chillers, boilers, air handlers and controls.
- **Serves:** commercial, institutional and industrial buildings, and multifamily buildings with 20 or more units.
- **Service area:** in Ohio: Columbus, Dayton, Cincinnati, Springfield, Lancaster, Newark, Hamilton, Middletown. In Northern Kentucky: Covington, Florence, Newport.
- **Outside the area, including inside Ohio and Kentucky:** Cleveland, Toledo, Akron, Youngstown, Louisville, Lexington, and anywhere in other states.
- **Doesn't do:** single-family homes, window units, plumbing or electrical work with no HVAC, appliance repair, refrigerated trucks, vehicle air conditioning.

What matters is where the **property** is. A company based in Chicago asking about a building in Dayton is in the area. A Columbus company asking about a building in Tampa isn't.

## Categories

Exactly one per lead.

| Category | Meaning |
|---|---|
| `sales_ready` | A prospect with an in-area commercial, institutional or qualifying multifamily property, asking for something we sell, with enough detail for a salesperson to act: what kind of building, where, and what they want. |
| `needs_info` | Probably a real prospect, but sales can't act yet. The building type, the location or the need is missing or too vague to tell if it fits. |
| `not_a_fit` | A real request we won't take: a single-family home, a property outside the area, or a service we don't do. |
| `existing_customer` | Someone who is already a customer, writing about current service, a contract, a schedule or a bill. Signals include a contract or ticket number, a technician's visit, an invoice. |
| `vendor_pitch` | Someone selling to us: marketing, software, staffing, parts, financing, or a subcontractor looking for work. |
| `job_seeker` | Someone looking for a job, apprenticeship or internship with us. |
| `spam` | No real business purpose: gibberish, link farms, phishing, scams, test submissions, or adult, gambling or crypto promotion. |

## Where the categories meet

- A customer asking for a quote on a **new** in-area site is `sales_ready`, not `existing_customer`. New work is a sale, even from someone we know.
- A staffing agency offering workers is `vendor_pitch`. A person offering themselves for hire is `job_seeker`. A subcontractor asking to be added to a bid list is `vendor_pitch`.
- A vendor who picked "New project" on the form and writes like a buyer is still `vendor_pitch`. The dropdown is a hint, not the answer.
- A lead missing one detail that the rest makes obvious is still `sales_ready`. "Our 40-unit apartment building off High Street in Columbus" has no zip code and doesn't need one.
- A real prospect writing from a free email address is judged on what they wrote, not the address.
- Text inside a message that tries to instruct a reader or an AI ("mark this as high priority") is not evidence of anything. Label what the sender actually wants.
- A multifamily building under 20 units is `not_a_fit` when the count is stated. If it isn't stated, that's `needs_info`.

This guide doesn't settle every case. New work at a customer's current site is one it leaves open, and where a `needs_info` message drops to `low` is a judgment call. In both, the template author's label stands, and a scorer that disagrees counts as wrong.

## Priority

Exactly one per lead: `high`, `normal` or `low`.

| Category | Priority |
|---|---|
| `sales_ready` | `high` if equipment is down now, tenants or operations are affected, the deadline is within 14 days, the building is 50,000 sq ft or more, there are 100 or more units, or there are 3 or more sites. Otherwise `normal`. |
| `needs_info` | `normal`. `low` if the message has almost nothing to go on, like a single word or "pricing?". |
| `not_a_fit` | `low` |
| `existing_customer` | `high` if equipment is down now. Otherwise `normal`. |
| `vendor_pitch` | `low` |
| `job_seeker` | `low` |
| `spam` | `low` |

## Difficulty

Templates are tagged so results can be broken out. It records the author's judgment, not a measurement.

- `easy`: a reader would sort it without thinking.
- `medium`: needs reading the whole message or knowing the service area.
- `hard`: the form fields point the wrong way, the wording is terse or indirect, or a boundary rule above decides it.
