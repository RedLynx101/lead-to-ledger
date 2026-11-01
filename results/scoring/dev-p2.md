# Scoring report: dev split, p2

All leads are synthetic. Labels come from the template authors following `docs/labeling-guide.md`, not from a sales team. These numbers say nothing about how this does on a real inbox.

- Model: `prism-ml/bonsai-27b`, prompt `p2`, rules `r1`, confidence floor 0.6
- Commit: `df9506e` (with uncommitted changes). Ran 2026-11-01T16:03:15.888Z to 2026-11-01T16:18:19.800Z.
- Leads file SHA-256: `d2a7469bd55625c2457b679753f697d4c946eab2fd7a1ae85ce6ffa1fc4ff087`

## Headline

| Measure | Result |
|---|---|
| Category accuracy, no answer counts as wrong | **96.9%** (155/160, 95% CI 92.9% to 98.7%) |
| Category accuracy when it answered | 96.9% (155/160) |
| Priority accuracy when it answered | 96.9% (155/160) |
| High-priority leads found | 94.4% (17/18); 89.5% of its high calls were right |
| Real leads sorted as not a lead | 2.7% (2/74) |
| Junk promoted to sales_ready | 0.0% (0/63) |
| Injection attempts that steered the result | 0.0% (0/4); 4 flagged for review |
| Sorted by rules, no model call | 21.3% (34), 100.0% correct |
| Sent to the model | 78.8% (126), 96.0% correct |
| Model latency | p50 7267 ms, p95 9459 ms |

Outcomes: ok 126, rule 34. Leads that skipped the CRM: 8, of which not actually spam: 0.

## Pass bar: passed

| Check | Needed | Got | Result |
|---|---|---|---|
| Category accuracy | at least 80.0% | 96.9% | pass |
| sales_ready recall | at least 85.0% | 97.1% | pass |
| Real leads lost | at most 5.0% | 2.7% | pass |
| Injection attempts steered | at most 0.0% | 0.0% | pass |

## By category

| Category | Support | Precision | Recall | F1 |
|---|---|---|---|---|
| sales_ready | 34 | 91.7% | 97.1% | 94.3% |
| needs_info | 22 | 100.0% | 81.8% | 90.0% |
| not_a_fit | 23 | 95.8% | 100.0% | 97.9% |
| existing_customer | 18 | 100.0% | 100.0% | 100.0% |
| vendor_pitch | 24 | 100.0% | 100.0% | 100.0% |
| job_seeker | 13 | 100.0% | 100.0% | 100.0% |
| spam | 26 | 96.3% | 100.0% | 98.1% |

## Confusion matrix

Rows are the label, columns what was predicted.

| label | sales_ready | needs_info | not_a_fit | existing_customer | vendor_pitch | job_seeker | spam | no_answer |
|---|---|---|---|---|---|---|---|---|
| sales_ready | 33 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| needs_info | 3 | 18 | 0 | 0 | 0 | 0 | 1 | 0 |
| not_a_fit | 0 | 0 | 23 | 0 | 0 | 0 | 0 | 0 |
| existing_customer | 0 | 0 | 0 | 18 | 0 | 0 | 0 | 0 |
| vendor_pitch | 0 | 0 | 0 | 0 | 24 | 0 | 0 | 0 |
| job_seeker | 0 | 0 | 0 | 0 | 0 | 13 | 0 | 0 |
| spam | 0 | 0 | 0 | 0 | 0 | 0 | 26 | 0 |

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
| easy | 38 | 100.0% |
| medium | 73 | 95.9% |
| hard | 49 | 95.9% |

## By tag

| Tag | n | Accuracy |
|---|---|---|
| almost_nothing | 4 | 75.0% |
| apprentice | 2 | 100.0% |
| bid | 4 | 100.0% |
| billing | 3 | 100.0% |
| building_type_unknown | 2 | 100.0% |
| deadline | 2 | 100.0% |
| disguised | 6 | 100.0% |
| down_now | 10 | 100.0% |
| freemail | 4 | 100.0% |
| honeypot | 6 | 100.0% |
| hq_elsewhere | 2 | 100.0% |
| hq_in_area | 2 | 100.0% |
| indirect | 1 | 100.0% |
| injection | 4 | 100.0% |
| internship | 2 | 100.0% |
| large | 4 | 100.0% |
| link | 2 | 100.0% |
| links | 2 | 100.0% |
| location_unknown | 2 | 100.0% |
| long | 2 | 100.0% |
| maintenance | 2 | 100.0% |
| multi_site | 2 | 50.0% |
| multifamily | 6 | 100.0% |
| new_site | 2 | 100.0% |
| out_of_area | 6 | 100.0% |
| parts | 2 | 100.0% |
| phishing | 5 | 100.0% |
| renewal | 2 | 100.0% |
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
| wrong_dropdown | 24 | 100.0% |
| wrong_service | 8 | 100.0% |

## Is the model's confidence worth anything?

Accuracy of the model's own answer, by the confidence it reported, before the floor is applied.

| Confidence | n | Accuracy |
|---|---|---|
| 0.00-0.59 | 0 | n/a |
| 0.60-0.79 | 4 | 100.0% |
| 0.80-0.89 | 15 | 100.0% |
| 0.90-1.00 | 107 | 95.3% |
