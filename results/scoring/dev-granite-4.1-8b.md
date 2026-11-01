# Scoring report: dev split, granite-4.1-8b

All leads are synthetic. Labels come from the template authors following `docs/labeling-guide.md`, not from a sales team. These numbers say nothing about how this does on a real inbox.

- Model: `granite-4.1-8b`, prompt `p2`, rules `r1`, confidence floor 0.6
- Commit: `db0aab6`. Ran 2026-11-01T18:32:08.957Z to 2026-11-01T18:35:17.663Z.
- Leads file SHA-256: `d2a7469bd55625c2457b679753f697d4c946eab2fd7a1ae85ce6ffa1fc4ff087`

## Headline

| Measure | Result |
|---|---|
| Category accuracy, no answer counts as wrong | **88.1%** (141/160, 95% CI 82.2% to 92.3%) |
| Category accuracy when it answered | 90.4% (141/156) |
| Priority accuracy when it answered | 78.8% (123/156) |
| High-priority leads found | 100.0% (18/18); 37.5% of its high calls were right |
| Real leads sorted as not a lead | 0.0% (0/74) |
| Junk promoted to sales_ready | 3.2% (2/63) |
| Injection attempts that steered the result | 50.0% (2/4); 4 flagged for review |
| Sorted by rules, no model call | 21.3% (34), 100.0% correct |
| Sent to the model | 78.8% (126), 84.9% correct |
| Model latency | p50 1325 ms, p95 2513 ms |

Outcomes: low_confidence 4, ok 122, rule 34. Leads that skipped the CRM: 8, of which not actually spam: 0.

## Pass bar: not passed

| Check | Needed | Got | Result |
|---|---|---|---|
| Category accuracy | at least 80.0% | 88.1% | pass |
| sales_ready recall | at least 85.0% | 94.1% | pass |
| Real leads lost | at most 5.0% | 0.0% | pass |
| Injection attempts steered | at most 0.0% | 50.0% | fail |

## By category

| Category | Support | Precision | Recall | F1 |
|---|---|---|---|---|
| sales_ready | 34 | 72.7% | 94.1% | 82.0% |
| needs_info | 22 | 81.3% | 59.1% | 68.4% |
| not_a_fit | 23 | 100.0% | 91.3% | 95.5% |
| existing_customer | 18 | 100.0% | 77.8% | 87.5% |
| vendor_pitch | 24 | 100.0% | 100.0% | 100.0% |
| job_seeker | 13 | 100.0% | 100.0% | 100.0% |
| spam | 26 | 100.0% | 92.3% | 96.0% |

## Confusion matrix

Rows are the label, columns what was predicted.

| label | sales_ready | needs_info | not_a_fit | existing_customer | vendor_pitch | job_seeker | spam | no_answer |
|---|---|---|---|---|---|---|---|---|
| sales_ready | 32 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| needs_info | 5 | 13 | 0 | 0 | 0 | 0 | 0 | 4 |
| not_a_fit | 1 | 1 | 21 | 0 | 0 | 0 | 0 | 0 |
| existing_customer | 4 | 0 | 0 | 14 | 0 | 0 | 0 | 0 |
| vendor_pitch | 0 | 0 | 0 | 0 | 24 | 0 | 0 | 0 |
| job_seeker | 0 | 0 | 0 | 0 | 0 | 13 | 0 | 0 |
| spam | 2 | 0 | 0 | 0 | 0 | 0 | 24 | 0 |

## Rules

| Rule | Hits | Precision | Wrong on |
|---|---|---|---|
| careers_dropdown | 4 | 100.0% | none |
| city_out_of_area | 3 | 100.0% | none |
| customer_number | 5 | 100.0% | none |
| disposable_email | 2 | 100.0% | none |
| honeypot | 6 | 100.0% | none |
| junk_terms_with_link | 5 | 100.0% | none |
| residential_words | 4 | 100.0% | none |
| state_out_of_area | 1 | 100.0% | none |
| vendor_dropdown | 4 | 100.0% | none |

## By difficulty

| Difficulty | n | Accuracy |
|---|---|---|
| easy | 38 | 97.4% |
| medium | 73 | 91.8% |
| hard | 49 | 75.5% |

## By tag

| Tag | n | Accuracy |
|---|---|---|
| almost_nothing | 4 | 25.0% |
| apprentice | 2 | 100.0% |
| bid | 4 | 100.0% |
| billing | 3 | 100.0% |
| building_type_unknown | 2 | 0.0% |
| deadline | 2 | 100.0% |
| disguised | 6 | 100.0% |
| down_now | 10 | 80.0% |
| freemail | 4 | 50.0% |
| honeypot | 6 | 100.0% |
| hq_elsewhere | 2 | 100.0% |
| hq_in_area | 2 | 50.0% |
| indirect | 1 | 100.0% |
| injection | 4 | 50.0% |
| internship | 2 | 100.0% |
| large | 4 | 100.0% |
| link | 2 | 100.0% |
| links | 2 | 100.0% |
| location_unknown | 2 | 50.0% |
| long | 2 | 0.0% |
| maintenance | 2 | 100.0% |
| multi_site | 2 | 100.0% |
| multifamily | 6 | 100.0% |
| new_site | 2 | 100.0% |
| out_of_area | 6 | 83.3% |
| parts | 2 | 100.0% |
| phishing | 5 | 100.0% |
| renewal | 2 | 0.0% |
| replacement | 2 | 100.0% |
| residential | 6 | 100.0% |
| resubmission | 5 | 100.0% |
| retrofit | 2 | 100.0% |
| scam | 2 | 100.0% |
| scheduling | 2 | 100.0% |
| sounds_urgent | 4 | 100.0% |
| spanish | 2 | 100.0% |
| staffing | 2 | 100.0% |
| subcontractor | 2 | 100.0% |
| terse | 3 | 100.0% |
| test_submission | 4 | 100.0% |
| too_small | 3 | 100.0% |
| unit_count_unknown | 2 | 0.0% |
| urgent | 4 | 100.0% |
| wrong_dropdown | 24 | 91.7% |
| wrong_service | 8 | 87.5% |

## Is the model's confidence worth anything?

Accuracy of the model's own answer, by the confidence it reported, before the floor is applied.

| Confidence | n | Accuracy |
|---|---|---|
| 0.00-0.59 | 4 | 100.0% |
| 0.60-0.79 | 10 | 90.0% |
| 0.80-0.89 | 6 | 66.7% |
| 0.90-1.00 | 106 | 88.7% |
