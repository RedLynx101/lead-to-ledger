# Scoring report: dev split, p1-baseline

All leads are synthetic. Labels come from the template authors following `docs/labeling-guide.md`, not from a sales team. These numbers say nothing about how this does on a real inbox.

- Model: `prism-ml/bonsai-27b`, prompt `p1`, rules `r1`, confidence floor 0.6
- Commit: `df9506e` (with uncommitted changes). Ran 2026-11-01T15:47:26.778Z to 2026-11-01T16:00:36.255Z.
- Leads file SHA-256: `d2a7469bd55625c2457b679753f697d4c946eab2fd7a1ae85ce6ffa1fc4ff087`

## Headline

| Measure | Result |
|---|---|
| Category accuracy, no answer counts as wrong | **88.1%** (141/160, 95% CI 82.2% to 92.3%) |
| Category accuracy when it answered | 88.1% (141/160) |
| Priority accuracy when it answered | 86.3% (138/160) |
| High-priority leads found | 77.8% (14/18); 87.5% of its high calls were right |
| Real leads sorted as not a lead | 13.5% (10/74) |
| Junk promoted to sales_ready | 0.0% (0/63) |
| Injection attempts that steered the result | 0.0% (0/4); 4 flagged for review |
| Sorted by rules, no model call | 21.3% (34), 100.0% correct |
| Sent to the model | 78.8% (126), 84.9% correct |
| Model latency | p50 6665 ms, p95 7734 ms |

Outcomes: ok 126, rule 34. Leads that skipped the CRM: 8, of which not actually spam: 0.

## Pass bar: not passed

| Check | Needed | Got | Result |
|---|---|---|---|
| Category accuracy | at least 80.0% | 88.1% | pass |
| sales_ready recall | at least 85.0% | 88.2% | pass |
| Real leads lost | at most 5.0% | 13.5% | fail |
| Injection attempts steered | at most 0.0% | 0.0% | pass |

## By category

| Category | Support | Precision | Recall | F1 |
|---|---|---|---|---|
| sales_ready | 34 | 83.3% | 88.2% | 85.7% |
| needs_info | 22 | 100.0% | 54.5% | 70.6% |
| not_a_fit | 23 | 84.0% | 91.3% | 87.5% |
| existing_customer | 18 | 100.0% | 100.0% | 100.0% |
| vendor_pitch | 24 | 75.0% | 100.0% | 85.7% |
| job_seeker | 13 | 100.0% | 100.0% | 100.0% |
| spam | 26 | 95.8% | 88.5% | 92.0% |

## Confusion matrix

Rows are the label, columns what was predicted.

| label | sales_ready | needs_info | not_a_fit | existing_customer | vendor_pitch | job_seeker | spam | no_answer |
|---|---|---|---|---|---|---|---|---|
| sales_ready | 30 | 0 | 0 | 0 | 4 | 0 | 0 | 0 |
| needs_info | 4 | 12 | 4 | 0 | 1 | 0 | 1 | 0 |
| not_a_fit | 2 | 0 | 21 | 0 | 0 | 0 | 0 | 0 |
| existing_customer | 0 | 0 | 0 | 18 | 0 | 0 | 0 | 0 |
| vendor_pitch | 0 | 0 | 0 | 0 | 24 | 0 | 0 | 0 |
| job_seeker | 0 | 0 | 0 | 0 | 0 | 13 | 0 | 0 |
| spam | 0 | 0 | 0 | 0 | 3 | 0 | 23 | 0 |

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
| medium | 73 | 83.6% |
| hard | 49 | 85.7% |

## By tag

| Tag | n | Accuracy |
|---|---|---|
| almost_nothing | 4 | 50.0% |
| apprentice | 2 | 100.0% |
| bid | 4 | 25.0% |
| billing | 3 | 100.0% |
| building_type_unknown | 2 | 50.0% |
| deadline | 2 | 100.0% |
| disguised | 6 | 100.0% |
| down_now | 10 | 100.0% |
| freemail | 4 | 100.0% |
| honeypot | 6 | 100.0% |
| hq_elsewhere | 2 | 100.0% |
| hq_in_area | 2 | 0.0% |
| indirect | 1 | 100.0% |
| injection | 4 | 100.0% |
| internship | 2 | 100.0% |
| large | 4 | 50.0% |
| link | 2 | 50.0% |
| links | 2 | 100.0% |
| location_unknown | 2 | 50.0% |
| long | 2 | 100.0% |
| maintenance | 2 | 100.0% |
| multi_site | 2 | 100.0% |
| multifamily | 6 | 100.0% |
| new_site | 2 | 100.0% |
| out_of_area | 6 | 66.7% |
| parts | 2 | 100.0% |
| phishing | 5 | 40.0% |
| renewal | 2 | 100.0% |
| replacement | 2 | 100.0% |
| residential | 6 | 100.0% |
| resubmission | 5 | 100.0% |
| retrofit | 2 | 50.0% |
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
| wrong_dropdown | 24 | 87.5% |
| wrong_service | 8 | 100.0% |

## Is the model's confidence worth anything?

Accuracy of the model's own answer, by the confidence it reported, before the floor is applied.

| Confidence | n | Accuracy |
|---|---|---|
| 0.00-0.59 | 0 | n/a |
| 0.60-0.79 | 6 | 100.0% |
| 0.80-0.89 | 10 | 60.0% |
| 0.90-1.00 | 110 | 86.4% |
