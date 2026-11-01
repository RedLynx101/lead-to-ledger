// A read-only page showing what the triage step did and, in shadow mode, what it would
// have written. It reads only local tables.

import type { Db } from '../db.ts';
import { currentMode } from '../triage/service.ts';
import type { TriageMode } from '../triage/service.ts';

export interface StatusData {
  mode: TriageMode;
  counts: { total: number; rule: number; model: number; needs_review: number; wrote_to_crm: number; waiting_handoff: number };
  runs: Array<Record<string, unknown>>;
  alerts: Array<{ at: string; kind: string; key: string | null; detail: string | null }>;
}

export async function statusData(db: Db): Promise<StatusData> {
  const counts = await db.query(
    `select count(*)::int as total,
            count(*) filter (where route = 'rule')::int as rule,
            count(*) filter (where route = 'model')::int as model,
            count(*) filter (where needs_review)::int as needs_review,
            count(*) filter (where wrote_to_crm)::int as wrote_to_crm,
            (select count(*)::int from lead_submissions where handed_off_at is null) as waiting_handoff
     from triage_runs`,
  );
  const runs = await db.query(
    `select t.created_at, t.key, t.status, t.route, t.rule_id, t.outcome, t.category, t.priority, t.summary, t.confidence,
            t.needs_review, t.skip_crm, t.fields, t.mode, t.wrote_to_crm, t.model, t.latency_ms, t.detail,
            s.form->>'company' as company, s.synthetic
     from triage_runs t left join lead_submissions s using (key)
     order by t.created_at desc limit 50`,
  );
  const alerts = await db.query('select at, kind, key, detail from alerts where acknowledged_at is null order by at desc limit 20');
  return { mode: await currentMode(db), counts: counts.rows[0], runs: runs.rows, alerts: alerts.rows };
}

const esc = (value: unknown) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export function renderStatusPage(data: StatusData): string {
  const rows = data.runs
    .map((run) => {
      const written = run.skip_crm
        ? '<span class="pill mute">not sent to CRM</span>'
        : run.wrote_to_crm
          ? '<span class="pill ok">written</span>'
          : run.mode === 'shadow'
            ? '<span class="pill shadow">logged only</span>'
            : '<span class="pill mute">nothing to write</span>';
      const modelOutcome: Record<string, string> = {
        ok: 'model',
        low_confidence: 'model, low confidence',
        invalid_output: 'model, bad output',
        model_unavailable: 'model down',
      };
      const sort = run.route === 'rule' ? `rule: ${esc(run.rule_id)}` : esc(modelOutcome[String(run.outcome)] ?? run.outcome);
      const review = run.needs_review ? '<span class="pill warn">review</span>' : '';
      return `<tr>
        <td class="mono">${esc(new Date(run.created_at as string).toISOString().slice(11, 19))}</td>
        <td>${esc(run.company) || '<span class="mute">none given</span>'}</td>
        <td class="mono">${sort}</td>
        <td>${esc(run.category) || '<span class="mute">no answer</span>'}</td>
        <td>${esc(run.priority)}</td>
        <td class="mono num">${run.confidence === null ? '' : Number(run.confidence).toFixed(2)}</td>
        <td class="summary">${esc(run.summary)} ${review}</td>
        <td>${written}</td>
      </tr>`;
    })
    .join('');
  const alerts = data.alerts
    .map((a) => `<li><span class="mono">${esc(new Date(a.at).toISOString().slice(11, 19))}</span> <strong>${esc(a.kind)}</strong> ${esc(String(a.detail ?? '').slice(0, 60))}</li>`)
    .join('');
  const c = data.counts;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Triage status</title>
<meta http-equiv="refresh" content="5">
<style>
:root { --bg:#faf9f6; --ink:#17202a; --mute:#66707a; --line:#d9dcd8; --teal:#0e6377; --teal-bg:#e3f4f8; --orange:#c2410c; --orange-bg:#fdeee3; --green:#166534; --green-bg:#e7f5ec; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:1180px; margin:0 auto; padding:28px 20px 60px; }
h1 { font-size:22px; margin:0 0 4px; }
.sub { color:var(--mute); margin:0 0 18px; }
.mode { display:inline-block; padding:3px 10px; border-radius:4px; font-weight:600; font-size:13px; }
.mode.shadow { background:var(--teal-bg); color:var(--teal); }
.mode.live { background:var(--orange-bg); color:var(--orange); }
.stats { display:flex; flex-wrap:wrap; gap:22px; margin:0 0 20px; padding:0; list-style:none; }
.stats b { display:block; font-size:22px; font-variant-numeric:tabular-nums; }
.stats span { color:var(--mute); font-size:13px; }
.wrap { overflow-x:auto; border:1px solid var(--line); border-radius:6px; background:#fff; }
table { border-collapse:collapse; width:100%; min-width:880px; }
th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; color:var(--mute); font-weight:600; white-space:nowrap; }
tr:last-child td { border-bottom:0; }
.mono { font-family:ui-monospace,Consolas,monospace; font-size:13px; }
.num { text-align:right; }
.summary { max-width:360px; }
.mute { color:var(--mute); }
.pill { display:inline-block; padding:1px 7px; border-radius:4px; font-size:12px; white-space:nowrap; }
.pill.ok { background:var(--green-bg); color:var(--green); }
.pill.shadow { background:var(--teal-bg); color:var(--teal); }
.pill.warn { background:var(--orange-bg); color:var(--orange); }
.pill.mute { background:#eef0ee; color:var(--mute); }
h2 { font-size:15px; margin:24px 0 8px; }
ul.alerts { margin:0; padding-left:18px; }
.note { color:var(--mute); font-size:13px; margin-top:18px; }
</style></head><body><main>
<h1>Triage status</h1>
<p class="sub">Mode: <span class="mode ${data.mode}">${data.mode === 'shadow' ? 'shadow: nothing is written to ai_ fields' : 'live: writing ai_ fields'}</span></p>
<ul class="stats">
  <li><b>${c.total}</b><span>leads</span></li>
  <li><b>${c.rule}</b><span>sorted by rules</span></li>
  <li><b>${c.model}</b><span>sent to the model</span></li>
  <li><b>${c.needs_review}</b><span>flagged for review</span></li>
  <li><b>${c.wrote_to_crm}</b><span>written to the CRM</span></li>
  <li><b>${c.waiting_handoff}</b><span>waiting for n8n</span></li>
</ul>
<div class="wrap"><table>
<thead><tr><th>Time (UTC)</th><th>Company</th><th>Sorted by</th><th>Category</th><th>Priority</th><th>Conf.</th><th>Summary</th><th>ai_ fields</th></tr></thead>
<tbody>${rows || '<tr><td colspan="8" class="mute">No leads yet. Submit the form at <a href="/">/</a>.</td></tr>'}</tbody>
</table></div>
<h2>Open alerts</h2>
${alerts ? `<ul class="alerts">${alerts}</ul>` : '<p class="mute">None.</p>'}
<p class="note">Everything on this page comes from synthetic test data for a fictional company. Sales still decides: the fields above are notes, not actions.</p>
</main></body></html>`;
}
