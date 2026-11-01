# Lead template format

`scripts/gen-leads.ts` turns templates into labeled synthetic leads. Templates live in two files that share no wording:

- `data/templates/dev.templates.json`: the development set's wording. Prompts and rules may be tuned against the leads built from it.
- `data/templates/heldout.templates.json`: the held-out test set's wording, written separately from the prompt and rules. Nothing is tuned against it.

Each file is a JSON array of objects:

```json
{
  "id": "sr-01",
  "category": "sales_ready",
  "priority": "normal",
  "difficulty": "easy",
  "tags": ["maintenance"],
  "form": {
    "inquiry_type": "new_project",
    "region": "in_area",
    "email_kind": "company",
    "company_kind": "property",
    "title_kind": "facilities",
    "website": true,
    "honeypot": false,
    "customer_number": false
  },
  "message": "We manage a {sqft} sq ft office building in {city} ..."
}
```

`category`, `priority` and `difficulty` follow `docs/labeling-guide.md`. A template's `id` must be unique across its file. `tags` are free-form short strings used to break out results; use `injection` when the message contains text aimed at an AI reader, and `wrong_dropdown` when `inquiry_type` points away from the true category.

## Form fields

| Field | Values | Effect on the generated lead |
|---|---|---|
| `inquiry_type` | `new_project`, `existing_service`, `careers`, `vendor`, `other` | The dropdown the person picked on the form. |
| `region` | `in_area`, `out_of_area`, `in_area_hq_elsewhere` | Chooses `{city}` and `{state}`. `out_of_area` picks a place outside the service area, sometimes in Ohio or Kentucky. `in_area_hq_elsewhere` keeps `{city}` in the area and also fills `{hq_city}` and `{hq_state}` with somewhere else. |
| `email_kind` | `company`, `freemail`, `disposable` | `company` uses the company's domain, `freemail` a personal mailbox, `disposable` a throwaway domain. All are reserved, non-routable domains. |
| `company_kind` | `property`, `business`, `institution`, `vendor`, `none` | The kind of company name generated. `none` leaves the company field empty. |
| `title_kind` | `facilities`, `owner`, `sales`, `student`, `none` | The kind of job title generated. `none` leaves it empty. |
| `website` | `true`, `false` | Whether the website field is filled. |
| `honeypot` | `true`, `false` | Whether the hidden form field a person never sees was filled in. Only bots do that. |
| `customer_number` | `true`, `false` | Whether the optional "customer number" form field is filled in with a contract number. |
| `location_field` | `true`, `false` | Default `true`. `false` leaves the property city and state form fields empty, so any location has to come from the message. |

## Slots

Use only these in `message`. Each lead gets its own values, drawn from the seed.

| Slot | Example | Slot | Example |
|---|---|---|---|
| `{first}` | Dana | `{tonnage}` | 40 |
| `{last}` | Ruiz | `{rtu_count}` | 6 |
| `{full}` | Dana Ruiz | `{sites}` | 4 |
| `{title}` | Facilities Manager | `{equipment}` | rooftop unit |
| `{company}` | Cedar Square Management | `{brand}` | Trane |
| `{city}` | Dayton | `{building}` | medical office building |
| `{state}` | OH | `{timeline}` | by the end of next month |
| `{hq_city}` | Chicago | `{urgent_time}` | since this morning |
| `{hq_state}` | IL | `{month}` | March |
| `{sqft_small}` | 8,500 | `{weekday}` | Tuesday |
| `{sqft}` | 24,000 | `{contract_no}` | MA-20418 |
| `{sqft_large}` | 85,000 | `{ticket_no}` | T-77310 |
| `{units_small}` | 12 | `{invoice_no}` | INV-55102 |
| `{units}` | 48 | `{tech}` | Marcus |
| `{units_large}` | 160 | `{vendor_product}` | SEO retainer |
| `{budget}` | $18,000 | `{school}` | Sinclair Community College |
| `{phone}` | +1-614-555-0142 | `{cert}` | EPA 608 Universal |
| `{url}` | https://cedarsquare.example.com | `{years}` | 7 |
| `{spam_url}` | https://win-now.example.net/x7 | `{trade_school_year}` | second-year |

`{timeline}` always means more than 14 days out, so it doesn't make a lead high priority by itself. `{sqft}` runs from 10,000 to 45,000 and `{sqft_large}` from 55,000 to 240,000, so they sit on either side of the 50,000 sq ft high-priority line. `{sqft_small}` is under 10,000. `{units_small}` is under 20, `{units}` is 20 to 90 and `{units_large}` is 100 or more. Pick the slot that matches the label you are writing, because the label doesn't change with the value.

In `{city}`, `{state}` for `in_area` is always in the service area in `docs/labeling-guide.md`. Don't write city names into a message directly unless the template is about a specific place; use the slots so leads vary. A template may name a city outright if that is the point, for example a Toledo property on a template labeled `not_a_fit`.

## Rules for writing templates

- Write the way people fill out web forms: uneven, sometimes terse, sometimes too long, not polished. The generator also adds noise, including lowercase, dropped punctuation, typos and mobile signatures, so don't add typos to every template.
- Every template must have a label the guide supports. If the guide can't settle it, drop the template.
- No real people, real companies, real phone numbers, real email addresses or real URLs in the text. Use the slots. HVAC brand names appear only through `{brand}`.
- Spam templates may be crude but must not contain slurs or sexual content. Mentioning that a site is a casino or crypto promotion is enough.
