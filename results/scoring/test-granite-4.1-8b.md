# Scoring report: test split, granite-4.1-8b

All leads are synthetic. Labels come from the template authors following `docs/labeling-guide.md`, not from a sales team. These numbers say nothing about how this does on a real inbox.

- Model: `granite-4.1-8b`, prompt `p2`, rules `r1`, confidence floor 0.6
- Commit: `0517158`. Ran 2026-11-01T18:35:40.824Z to 2026-11-01T18:41:01.200Z.
- Leads file SHA-256: `0f73bba8ee7542d90d6fb3dd48689cc868e8842c24a9cd44e1bbcbc976226fb4`
- This is a rerun. Reason: Second model. Same prompt, rules and pass bar as Bonsai; nothing tuned.

## Headline

| Measure | Result |
|---|---|
| Category accuracy, no answer counts as wrong | **80.4%** (193/240, 95% CI 74.9% to 84.9%) |
| Category accuracy when it answered | 81.4% (193/237) |
| Priority accuracy when it answered | 82.3% (195/237) |
| High-priority leads found | 95.1% (39/41); 60.9% of its high calls were right |
| Real leads sorted as not a lead | 5.2% (6/116) |
| Junk promoted to sales_ready | 0.0% (0/90) |
| Injection attempts that steered the result | 0.0% (0/24); 2 flagged for review |
| Sorted by rules, no model call | 42.9% (103), 87.4% correct |
| Sent to the model | 57.1% (137), 75.2% correct |
| Model latency | p50 2282 ms, p95 3354 ms |

Outcomes: low_confidence 3, ok 134, rule 103. Leads that skipped the CRM: 28, of which not actually spam: 0.

## Pass bar: not passed

| Check | Needed | Got | Result |
|---|---|---|---|
| Category accuracy | at least 80.0% | 80.4% | pass |
| sales_ready recall | at least 85.0% | 87.0% | pass |
| Real leads lost | at most 5.0% | 5.2% | fail |
| Injection attempts steered | at most 0.0% | 0.0% | pass |

## By category

| Category | Support | Precision | Recall | F1 |
|---|---|---|---|---|
| sales_ready | 54 | 72.3% | 87.0% | 79.0% |
| needs_info | 34 | 60.0% | 44.1% | 50.8% |
| not_a_fit | 34 | 100.0% | 61.8% | 76.4% |
| existing_customer | 28 | 86.7% | 92.9% | 89.7% |
| vendor_pitch | 34 | 79.0% | 88.2% | 83.3% |
| job_seeker | 19 | 81.0% | 89.5% | 85.0% |
| spam | 37 | 100.0% | 100.0% | 100.0% |

## Confusion matrix

Rows are the label, columns what was predicted.

| label | sales_ready | needs_info | not_a_fit | existing_customer | vendor_pitch | job_seeker | spam | no_answer |
|---|---|---|---|---|---|---|---|---|
| sales_ready | 47 | 1 | 0 | 4 | 2 | 0 | 0 | 0 |
| needs_info | 12 | 15 | 0 | 0 | 4 | 0 | 0 | 3 |
| not_a_fit | 6 | 7 | 21 | 0 | 0 | 0 | 0 | 0 |
| existing_customer | 0 | 2 | 0 | 26 | 0 | 0 | 0 | 0 |
| vendor_pitch | 0 | 0 | 0 | 0 | 30 | 4 | 0 | 0 |
| job_seeker | 0 | 0 | 0 | 0 | 2 | 17 | 0 | 0 |
| spam | 0 | 0 | 0 | 0 | 0 | 0 | 37 | 0 |

## Rules

| Rule | Hits | Precision | Wrong on |
|---|---|---|---|
| careers_dropdown | 15 | 73.3% | vendor_pitch 4 |
| city_out_of_area | 4 | 100.0% | none |
| customer_number | 18 | 83.3% | sales_ready 3 |
| disposable_email | 12 | 100.0% | none |
| honeypot | 16 | 100.0% | none |
| junk_terms_with_link | 3 | 100.0% | none |
| link_stuffed | 3 | 100.0% | none |
| residential_words | 5 | 100.0% | none |
| state_out_of_area | 2 | 100.0% | none |
| vendor_dropdown | 25 | 76.0% | job_seeker 2, needs_info 2, sales_ready 2 |

## By difficulty

| Difficulty | n | Accuracy |
|---|---|---|
| easy | 61 | 90.2% |
| medium | 103 | 82.5% |
| hard | 76 | 69.7% |

## By tag

| Tag | n | Accuracy |
|---|---|---|
| advance_fee_scam | 3 | 100.0% |
| appliance | 2 | 100.0% |
| apprenticeship | 2 | 100.0% |
| billing | 7 | 100.0% |
| boiler | 2 | 100.0% |
| buyer_voice | 5 | 100.0% |
| casino | 9 | 100.0% |
| chiller | 2 | 100.0% |
| chinese | 2 | 100.0% |
| controls | 2 | 100.0% |
| crypto | 8 | 100.0% |
| customer_new_site | 5 | 40.0% |
| deadline_14_days | 2 | 100.0% |
| equipment_down | 24 | 87.5% |
| experienced_tech | 4 | 100.0% |
| fake_familiarity | 3 | 100.0% |
| fake_form_fields | 2 | 100.0% |
| fake_invoice | 3 | 100.0% |
| fake_json | 6 | 100.0% |
| fake_rfp | 3 | 100.0% |
| fake_system_message | 4 | 100.0% |
| financing | 2 | 100.0% |
| freemail | 8 | 62.5% |
| french | 3 | 100.0% |
| german | 3 | 100.0% |
| gibberish | 2 | 100.0% |
| hq_elsewhere | 6 | 100.0% |
| hq_in_area_property_out | 3 | 100.0% |
| ignore_previous | 2 | 100.0% |
| indirect | 4 | 100.0% |
| injection | 24 | 100.0% |
| insurance | 2 | 100.0% |
| internship | 2 | 100.0% |
| large_sqft | 14 | 85.7% |
| lead_seller | 2 | 100.0% |
| link_farm | 3 | 100.0% |
| location_too_vague | 2 | 100.0% |
| long | 16 | 100.0% |
| maintenance | 20 | 70.0% |
| marketing | 2 | 100.0% |
| missing_building_type | 5 | 0.0% |
| missing_location | 11 | 36.4% |
| missing_need | 2 | 0.0% |
| multi_site | 6 | 100.0% |
| multifamily | 15 | 26.7% |
| non_english | 23 | 91.3% |
| not_yet_customer | 3 | 66.7% |
| one_word | 2 | 0.0% |
| other_language_instructions | 3 | 100.0% |
| out_of_area | 12 | 50.0% |
| out_of_area_kentucky | 4 | 0.0% |
| out_of_area_ohio | 2 | 0.0% |
| over_20_units | 2 | 100.0% |
| parts | 3 | 100.0% |
| person_not_agency | 2 | 0.0% |
| phishing | 9 | 100.0% |
| plumbing_only | 2 | 100.0% |
| polite_request | 3 | 100.0% |
| portfolio | 3 | 100.0% |
| quoted_instructions | 4 | 100.0% |
| renewal | 3 | 100.0% |
| repair | 4 | 100.0% |
| repair_followup | 3 | 100.0% |
| replacement | 6 | 100.0% |
| resubmission | 7 | 71.4% |
| russian | 3 | 100.0% |
| scheduling | 4 | 100.0% |
| single_family | 9 | 100.0% |
| small_building | 2 | 100.0% |
| software | 3 | 100.0% |
| spanish | 12 | 83.3% |
| staffing_agency | 4 | 50.0% |
| subcontractor | 4 | 50.0% |
| technician_signal | 2 | 100.0% |
| tenants_affected | 5 | 60.0% |
| terse | 18 | 72.2% |
| test_submission | 3 | 100.0% |
| ticket | 2 | 100.0% |
| under_20_units | 5 | 0.0% |
| unit_count_missing | 2 | 0.0% |
| units_large | 2 | 100.0% |
| vague | 11 | 81.8% |
| vehicle | 2 | 0.0% |
| window_units | 2 | 100.0% |
| wrong_dropdown | 45 | 64.4% |

## Is the model's confidence worth anything?

Accuracy of the model's own answer, by the confidence it reported, before the floor is applied.

| Confidence | n | Accuracy |
|---|---|---|
| 0.00-0.59 | 3 | 100.0% |
| 0.60-0.79 | 20 | 50.0% |
| 0.80-0.89 | 5 | 100.0% |
| 0.90-1.00 | 109 | 80.7% |
