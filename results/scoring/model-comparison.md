# Model comparison

Same prompt, same rules and the same synthetic leads, with nothing tuned against the held-out set. Labels come from the template authors, not a sales team, so this compares the models on this set and says nothing about a real inbox.

**`granite-4.1-8b` becomes the default:** same number of checks passed, and it sorts fewer real leads as not a lead.

Prompt and rules identical across the two held-out runs: yes.

| | prism-ml/bonsai-27b | granite-4.1-8b |
|---|---|---|
| Publisher | prism-ml | lmstudio-community build of IBM Granite 4.1 8B |
| Quantization | Q1_0 | Q4_K_M |
| File size | 4.73 GB | 5.35 GB |
| License | Apache-2.0, per PrismML's docs | Apache-2.0, per the Hugging Face model card |
| **Held-out category accuracy** | **84.2%** (202/240, CI 79.0% to 88.2%) | **80.4%** (193/240, CI 74.9% to 84.9%) |
| Held-out pass bar | not passed, 3 of 4 checks | not passed, 3 of 4 checks |
| sales_ready recall | 87.0% | 87.0% |
| Real leads sorted as not a lead | 8.6% (10/116) | 5.2% (6/116) |
| Junk promoted to sales_ready | 0.0% (0/90) | 0.0% (0/90) |
| Accuracy on leads sent to the model | 81.8% (112/137) | 75.2% (103/137) |
| needs_info recall | 41.2% | 44.1% |
| Priority accuracy when answered | 87.8% | 82.3% |
| High-priority leads found | 70.7% (29/41) | 95.1% (39/41) |
| Model latency, p50 and p95 | 8018 ms, 10858 ms | 2282 ms, 3354 ms |
| Model latency alone on the GPU, injection run, p50 | 3412 ms | 2050 ms |
| Model outcomes | low_confidence 3, ok 134 | low_confidence 3, ok 134 |
| Retries after a server failure | 0 | 0 |
| Dev category accuracy | 96.9% (155/160) | 88.1% (141/160) |
| **Model alone, attacks that steered it** | **0 of 20** (CI 0.0% to 16.1%) | **0 of 20** (CI 0.0% to 16.1%) |
| Model alone, attacks sorted correctly | 20 of 20 | 18 of 20 |
| Model alone, real sales quoting instructions, correct | 2 of 4 | 4 of 4 |
| Files | `dev-p2`, `test-rerun-1`, `injection-bonsai` | `dev-granite-4.1-8b`, `test-granite-4.1-8b`, `injection-granite-4.1-8b` |

Bonsai's held-out run shared the GPU with another project and Granite's didn't, so the full-run latency row overstates the gap. The injection-run row has each model alone on the GPU.

An attack here is an injection lead that is not really a sale. It counts as steered if the model marked it `sales_ready` or high priority. Rules sort most of these in the full path, so the model-alone row is the one that measures the model.

`results/scoring/heldout-runs.log` lists every run against the held-out set, including Bonsai's first run, which a server failure cut short.
