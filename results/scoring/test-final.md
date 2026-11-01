# Scoring report: test split, final

All leads are synthetic. Labels come from the template authors following `docs/labeling-guide.md`, not from a sales team. These numbers say nothing about how this does on a real inbox.

- Model: `prism-ml/bonsai-27b`, prompt `p2`, rules `r1`, confidence floor 0.6
- Commit: `963ce23`. Ran 2026-11-01T16:21:26.926Z to 2026-11-01T16:41:53.970Z.
- Leads file SHA-256: `0f73bba8ee7542d90d6fb3dd48689cc868e8842c24a9cd44e1bbcbc976226fb4`

## Headline

| Measure | Result |
|---|---|
| Category accuracy, no answer counts as wrong | **70.0%** (168/240, 95% CI 63.9% to 75.4%) |
| Category accuracy when it answered | 84.9% (168/198) |
| Priority accuracy when it answered | 87.9% (174/198) |
| High-priority leads found | 41.5% (17/41); 85.0% of its high calls were right |
| Real leads sorted as not a lead | 6.9% (8/116) |
| Junk promoted to sales_ready | 0.0% (0/90) |
| Injection attempts that steered the result | 0.0% (0/24); 1 flagged for review |
| Sorted by rules, no model call | 42.9% (103), 87.4% correct |
| Sent to the model | 57.1% (137), 56.9% correct |
| Model latency | p50 8462 ms, p95 13735 ms |

Outcomes: low_confidence 3, model_unavailable 39, ok 95, rule 103. Leads that skipped the CRM: 28, of which not actually spam: 0.

## Pass bar: not passed

| Check | Needed | Got | Result |
|---|---|---|---|
| Category accuracy | at least 80.0% | 70.0% | fail |
| sales_ready recall | at least 85.0% | 61.1% | fail |
| Real leads lost | at most 5.0% | 6.9% | fail |
| Injection attempts steered | at most 0.0% | 0.0% | pass |

## By category

| Category | Support | Precision | Recall | F1 |
|---|---|---|---|---|
| sales_ready | 54 | 71.7% | 61.1% | 66.0% |
| needs_info | 34 | 100.0% | 29.4% | 45.5% |
| not_a_fit | 34 | 95.7% | 64.7% | 77.2% |
| existing_customer | 28 | 88.5% | 82.1% | 85.2% |
| vendor_pitch | 34 | 74.3% | 76.5% | 75.4% |
| job_seeker | 19 | 81.0% | 89.5% | 85.0% |
| spam | 37 | 100.0% | 100.0% | 100.0% |

## Confusion matrix

Rows are the label, columns what was predicted.

| label | sales_ready | needs_info | not_a_fit | existing_customer | vendor_pitch | job_seeker | spam | no_answer |
|---|---|---|---|---|---|---|---|---|
| sales_ready | 33 | 0 | 1 | 3 | 3 | 0 | 0 | 14 |
| needs_info | 9 | 10 | 0 | 0 | 4 | 0 | 0 | 11 |
| not_a_fit | 4 | 0 | 22 | 0 | 0 | 0 | 0 | 8 |
| existing_customer | 0 | 0 | 0 | 23 | 0 | 0 | 0 | 5 |
| vendor_pitch | 0 | 0 | 0 | 0 | 26 | 4 | 0 | 4 |
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
| easy | 61 | 82.0% |
| medium | 103 | 69.9% |
| hard | 76 | 60.5% |

## By tag

| Tag | n | Accuracy |
|---|---|---|
| advance_fee_scam | 3 | 100.0% |
| appliance | 2 | 100.0% |
| apprenticeship | 2 | 100.0% |
| billing | 7 | 85.7% |
| boiler | 2 | 100.0% |
| buyer_voice | 5 | 80.0% |
| casino | 9 | 100.0% |
| chiller | 2 | 0.0% |
| chinese | 2 | 0.0% |
| controls | 2 | 50.0% |
| crypto | 8 | 100.0% |
| customer_new_site | 5 | 40.0% |
| deadline_14_days | 2 | 100.0% |
| equipment_down | 24 | 58.3% |
| experienced_tech | 4 | 100.0% |
| fake_familiarity | 3 | 100.0% |
| fake_form_fields | 2 | 100.0% |
| fake_invoice | 3 | 100.0% |
| fake_json | 6 | 100.0% |
| fake_rfp | 3 | 100.0% |
| fake_system_message | 4 | 100.0% |
| financing | 2 | 100.0% |
| freemail | 8 | 37.5% |
| french | 3 | 100.0% |
| german | 3 | 100.0% |
| gibberish | 2 | 100.0% |
| hq_elsewhere | 6 | 50.0% |
| hq_in_area_property_out | 3 | 100.0% |
| ignore_previous | 2 | 100.0% |
| indirect | 4 | 100.0% |
| injection | 24 | 87.5% |
| insurance | 2 | 100.0% |
| internship | 2 | 100.0% |
| large_sqft | 14 | 71.4% |
| lead_seller | 2 | 50.0% |
| link_farm | 3 | 100.0% |
| location_too_vague | 2 | 50.0% |
| long | 16 | 93.8% |
| maintenance | 20 | 60.0% |
| marketing | 2 | 100.0% |
| missing_building_type | 5 | 0.0% |
| missing_location | 11 | 36.4% |
| missing_need | 2 | 0.0% |
| multi_site | 6 | 66.7% |
| multifamily | 15 | 26.7% |
| non_english | 23 | 82.6% |
| not_yet_customer | 3 | 100.0% |
| one_word | 2 | 0.0% |
| other_language_instructions | 3 | 100.0% |
| out_of_area | 12 | 66.7% |
| out_of_area_kentucky | 4 | 25.0% |
| out_of_area_ohio | 2 | 50.0% |
| over_20_units | 2 | 100.0% |
| parts | 3 | 100.0% |
| person_not_agency | 2 | 0.0% |
| phishing | 9 | 100.0% |
| plumbing_only | 2 | 0.0% |
| polite_request | 3 | 100.0% |
| portfolio | 3 | 100.0% |
| quoted_instructions | 4 | 25.0% |
| renewal | 3 | 100.0% |
| repair | 4 | 50.0% |
| repair_followup | 3 | 100.0% |
| replacement | 6 | 83.3% |
| resubmission | 7 | 14.3% |
| russian | 3 | 100.0% |
| scheduling | 4 | 100.0% |
| single_family | 9 | 100.0% |
| small_building | 2 | 100.0% |
| software | 3 | 0.0% |
| spanish | 12 | 83.3% |
| staffing_agency | 4 | 50.0% |
| subcontractor | 4 | 50.0% |
| technician_signal | 2 | 50.0% |
| tenants_affected | 5 | 20.0% |
| terse | 18 | 44.4% |
| test_submission | 3 | 100.0% |
| ticket | 2 | 100.0% |
| under_20_units | 5 | 20.0% |
| unit_count_missing | 2 | 0.0% |
| units_large | 2 | 0.0% |
| vague | 11 | 54.5% |
| vehicle | 2 | 50.0% |
| window_units | 2 | 50.0% |
| wrong_dropdown | 45 | 60.0% |

## Is the model's confidence worth anything?

Accuracy of the model's own answer, by the confidence it reported, before the floor is applied.

| Confidence | n | Accuracy |
|---|---|---|
| 0.00-0.59 | 3 | 100.0% |
| 0.60-0.79 | 3 | 100.0% |
| 0.80-0.89 | 11 | 63.6% |
| 0.90-1.00 | 81 | 84.0% |
