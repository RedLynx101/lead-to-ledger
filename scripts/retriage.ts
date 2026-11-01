// Runs triage again for leads that arrived while the model was down. Their contacts are
// already in the CRM with no ai_ fields, so this only fills those in.

import { hubspotSettings, llmSettings } from '../src/config.ts';
import { createDb, migrate } from '../src/db.ts';
import { HubSpotClient } from '../src/hubspot/client.ts';
import type { PipelineForm } from '../src/triage/pipeline.ts';
import { triage } from '../src/triage/service.ts';

const db = createDb();
await migrate(db);
const hubspot = new HubSpotClient(hubspotSettings());
const llm = llmSettings();

const pending = await db.query<{ key: string; form: PipelineForm }>(
  `select t.key, s.form from triage_runs t join lead_submissions s using (key)
   where t.status = 'done' and t.outcome = 'model_unavailable' order by t.created_at`,
);

const outcomes: Record<string, number> = {};
for (const row of pending.rows) {
  const result = await triage({ db, hubspot, llm }, { submission_key: row.key, form: row.form, rule: null });
  const outcome = result.outcome ?? 'unknown';
  outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
}
console.log(JSON.stringify({ retried: pending.rows.length, outcomes }));
await db.end();
