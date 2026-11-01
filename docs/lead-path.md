# The lead path

What happens between a form submission and the CRM, and what each failure does.

```
web form -> Postgres row -> n8n webhook -> rules in a Code node
                                             |
                  hidden field or throwaway email: logged, no contact
                                             |
                                 otherwise: upsert the contact by email
                                             |
                       triage service: rule result, or model plus checks
                                             |
                       shadow: log what would be written
                       live:   write ai_ fields only
```

The contact is upserted before the AI step, so a dead model can't lose a lead. Sales qualifies from there. The `ai_` fields are notes.

## Who may write what

| Path | May write | Enforced by |
|---|---|---|
| Form, through n8n | `firstname`, `lastname`, `phone`, `company`, `jobtitle`, `website`, `city`, `state`, `message`, `ltl_synthetic`, and `email` as the upsert key | The mapping in `src/leads/contact.ts` |
| Triage | `ai_category`, `ai_priority`, `ai_summary`, `ai_confidence`, `ai_needs_review`, `ai_source`, `ai_model` | `assertOnlyAiFields` in `src/hubspot/client.ts`, which refuses anything else before sending |
| Nobody here | Lifecycle stage, lead status, owner, deals | Neither list includes them. The end-to-end run checks the simulator's write log |

The model sees the form's company, job title, property location, dropdown and message, plus whether the email is a free one and whether a website or customer number was given. It doesn't see names, the email address, the phone number or the customer number. A name or number the sender typed into the message still reaches it.

## Failures

| What goes wrong | What happens |
|---|---|
| Invalid JSON, an unknown category, or an extra property | No answer is written. Only `ai_needs_review` is set, so a person looks. |
| Low confidence | A summary but no category or priority, flagged for review. |
| Model down, timing out, or returning an error | The contact is already in the CRM with no `ai_` fields, and an alert is raised. `scripts/retriage.ts` fills them in once the model is back. |
| CRM down during the contact upsert | n8n retries three times, then raises an alert and puts the lead back in the queue. The re-drive loop sends it again. |
| CRM down during the `ai_` write | An alert is raised and the row is marked `write_failed`. The re-drive loop retries it from the stored answer, up to six attempts, with no second model call. |
| n8n down | The form still accepts the lead and stores it. The re-drive loop delivers it when n8n is back. |
| The triage service down while n8n calls it | The contact is in the CRM. n8n's alert also fails, because alerts live in this service, so it shows only in n8n's execution log. The re-drive loop sends the lead again after 5 minutes, because it has no triage row. |
| A double-click or repeat submission | Same email and same message, same key. One row, one model call, one write. |
| A replayed webhook | The contact upsert repeats harmlessly, because it's by email. Triage answers from its row. |
| Text in the form that tries to steer the model | It's sent as data. The answer can only land in `ai_` fields, from a fixed list. Obvious attempts are flagged for review. The flag is a coarse pattern match and misses plenty, so it isn't the defense. |

## Shadow mode and going live

Shadow is the default, and no row in `settings` also means shadow. In shadow mode the contact is still created, and `triage_runs.fields` holds exactly what a live write would have sent.

```sh
node scripts/set-mode.ts live --report results/scoring/<run>.json --signed-off-by "Name"
node scripts/set-mode.ts shadow
```

Going live needs a person's name and a scored run on the held-out set. A run that missed the pass bar is refused unless `--below-bar "why"` is given, and that reason is recorded in `mode_changes`. Rollback needs nothing and applies from the next lead. The pass bar is in `config/triage.json`. A real team would set its own, on leads it labeled.

## How it's scored

`scripts/score.ts` runs the same rules, model call and checks the service uses, but over a labeled file and without Postgres or HTTP. `data/leads/` holds two sets, both synthetic:

- **Dev (160 leads):** the prompt and rules were tuned against these.
- **Held-out (240 leads):** written by a separate agent from `docs/labeling-guide.md` and `docs/template-format.md`, without seeing the dev wording. The agent that wrote the prompt and rules didn't read it. Scoring it needs `--final` and a clean commit, and every attempt is logged in `results/scoring/heldout-runs.log`.

A lead with no answer counts as wrong in the headline number. Labels come from the template author, not a sales team, so a score here shows how the step does on this synthetic set and nothing about a real inbox.

## Known gaps

- Alerts are rows in this service's database, shown on `/status`. Nothing pushes them to a person yet.
- The steering flag is a regex.
- The model's confidence isn't well calibrated, so the floor catches little. See the calibration table in each scoring report.
- HubSpot's real behaviour hasn't been checked. See `docs/simulator-sources.md`.
