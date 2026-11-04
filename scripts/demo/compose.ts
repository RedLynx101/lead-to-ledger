// Builds the gallery images and the demo video from the screenshots and facts that
// capture.ts saved, plus the committed result files. Every number shown here is read
// from a file under results/ or from facts.json, never typed in.
//
//   node scripts/demo/compose.ts [--in tmp/demo] [--portfolio <folder>] [--form-crop <px>]
//
// Writes docs/images/ for the README, and, with --portfolio, Upwork (1600 x 1200) and
// Fiverr (1280 x 769) images plus demo.mp4 into that folder. Needs Edge and ffmpeg.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const { values: args } = parseArgs({ options: { in: { type: 'string', default: 'tmp/demo' }, portfolio: { type: 'string' }, 'form-crop': { type: 'string', default: '0' } } });
const ROOT = path.resolve(import.meta.dirname, '../..');
const IN = path.resolve(ROOT, args.in!);
const read = <T>(file: string) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as T;
// --form-crop trims that many pixels off the top of the form shot (for a capture taken before
// capture.ts started that shot below the page heading).
const formCrop = Number(args['form-crop']);
if (formCrop > 0) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(IN, 'form-filled.png'), '-vf', `crop=iw:ih-${formCrop}:0:${formCrop}`, path.join(IN, 'form-filled-cropped.png')]);
const formShot = formCrop > 0 ? 'form-filled-cropped' : 'form-filled';
const img = (name: string) => `data:image/png;base64,${readFileSync(path.join(IN, `${name}.png`)).toString('base64')}`;

// ---- Numbers, from committed results ---------------------------------------------------
interface Group { key: string; cells: number; customer_duplicates: number; invoice_duplicates: number; failed: number }
interface Cell { group: string; needed_reconnect: boolean; invoices: number; duplicates_found_by_reconcile: number; invoice_duplicates: number }
const restart = read<{ summary: { cells: number; passed: number; by_group: Group[] }; control: { invoices_counted: number }; cells: Cell[] }>('results/restart/matrix.json');
const group = (key: string) => restart.summary.by_group.find((g) => g.key === key)!;
const dups = (g: Group) => g.customer_duplicates + g.invoice_duplicates;
const kill = group('kill');
const failure = group('failure');
const late = group('late_commit');
const lag = group('query_lag');
const token = group('token');
const conc = group('concurrency');
const replayMode = (restart.summary as unknown as { by_mode: Group[] }).by_mode.find((g) => g.key === 'replay')!;
const tokenCells = restart.cells.filter((c) => c.group === 'token');
const reconnects = tokenCells.filter((c) => c.needed_reconnect).length;
const tokenOneInvoice = tokenCells.every((c) => c.invoices === 1);
const gapCells = restart.cells.filter((c) => c.invoice_duplicates > 0);
const gapFound = gapCells.every((c) => c.duplicates_found_by_reconcile >= c.invoice_duplicates);

interface Check { pass: boolean }
interface M { category: { accuracy: number }; real_lead_lost: { rate: number }; high_priority: { recall: number }; junk_promoted: { promoted: number; junk: number }; pass_bar: { checks: Record<string, Check>; passed: boolean } }
const granite = read<{ metrics: M }>('results/scoring/test-granite-4.1-8b.json').metrics;
const bonsai = read<{ metrics: M }>('results/scoring/test-rerun-1.json').metrics;
type I = { summary: { attacks: { n: number; steered: number } } };
const injG = read<I>('results/scoring/injection-granite-4.1-8b.json').summary.attacks;
const injB = read<I>('results/scoring/injection-bonsai.json').summary.attacks;
const facts = JSON.parse(readFileSync(path.join(IN, 'facts.json'), 'utf8')) as {
  model: string;
  drill: { doc_number: string; invoices_after_kill: number; invoices_after_restart: number; events: Array<{ at: string; event: string; detail: Record<string, unknown> | null }> };
};
// The real run: one HubSpot test account and one QuickBooks sandbox company.
type Verdict = 'matched' | 'fixed' | 'harsher' | 'left';
const real = read<{ started_at: string; checks_total: number; checks_failed: number; facts: Record<string, unknown> & { kill_drills: Array<{ at: string; invoices: number; status: string }> } }>('results/real/summary.json');
const simCheck = read<{ quickbooks: Array<{ behaviour: string; verdict: Verdict }>; hubspot: Array<{ behaviour: string; verdict: Verdict }> }>('results/real/simulator-check.json');
const verdictOf = (behaviour: string) => {
  const row = [...simCheck.quickbooks, ...simCheck.hubspot].find((r) => r.behaviour === behaviour);
  if (!row) throw new Error(`no simulator check for "${behaviour}"`);
  return row.verdict;
};
const fixedCount = [...simCheck.quickbooks, ...simCheck.hubspot].filter((r) => r.verdict === 'fixed').length;
const drillsOk = real.facts.kill_drills.filter((d) => d.invoices === 1 && d.status === 'done').length;
const SIM_FOOT = 'Synthetic data, on the simulators of HubSpot and QuickBooks.';
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const CHECK_NAMES: Record<string, string> = { category_accuracy: 'accuracy', sales_ready_recall: 'sales-ready recall', real_lead_lost_rate: 'real leads sorted as not a lead', injection_steered: 'injection' };
const missed = (m: M) => Object.entries(m.pass_bar.checks).filter(([, c]) => !c.pass).map(([k]) => CHECK_NAMES[k] ?? k);
const passBar = (m: M) => `${Object.keys(m.pass_bar.checks).length - missed(m).length} of ${Object.keys(m.pass_bar.checks).length}`;
const missedNote = missed(granite).join() === missed(bonsai).join() ? `Both missed the same check: ${missed(granite).join(', ')}.` : `Granite missed: ${missed(granite).join(', ') || 'none'}. Bonsai missed: ${missed(bonsai).join(', ') || 'none'}.`;

// ---- Style ------------------------------------------------------------------------------
const CSS = (u: number) => `
:root { --bg:#faf9f6; --ink:#17202a; --mute:#5d6873; --line:#d6dad6; --teal:#0e6377; --teal-bg:#e3f4f8; --orange:#c2410c; --orange-bg:#fdeee3; }
* { box-sizing:border-box; margin:0; }
html, body { width:100%; height:100%; }
body { background:var(--bg); color:var(--ink); font-family:"Segoe UI",system-ui,sans-serif; padding:${48 * u}px ${64 * u}px ${40 * u}px; display:flex; flex-direction:column; overflow:hidden; }
code { font-family:Consolas,monospace; }
.top { display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--line); padding-bottom:${16 * u}px; margin-bottom:${26 * u}px; }
.tag { display:flex; gap:${14 * u}px; align-items:center; font-family:Consolas,monospace; font-size:${17 * u}px; letter-spacing:.12em; color:var(--mute); }
.tag b { border:1.5px solid var(--ink); color:var(--ink); padding:${6 * u}px ${12 * u}px; border-radius:${5 * u}px; font-weight:700; }
.name { font-family:Georgia,serif; font-size:${26 * u}px; font-weight:700; }
h1 { font-family:Georgia,serif; font-size:${56 * u}px; line-height:1.12; font-weight:600; letter-spacing:-.01em; }
h2 { font-family:Georgia,serif; font-size:${40 * u}px; line-height:1.15; font-weight:600; }
.lede { color:var(--mute); font-size:${23 * u}px; line-height:1.45; margin-top:${12 * u}px; max-width:${1300 * u}px; }
.main { flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; gap:${18 * u}px; margin:${22 * u}px 0; }
.inner { display:flex; flex-direction:column; gap:${18 * u}px; }
.main.spread { justify-content:space-evenly; gap:${24 * u}px; }
.foot { padding-top:${16 * u}px; border-top:1px solid var(--line); display:flex; justify-content:space-between; gap:${24 * u}px; font-family:Consolas,monospace; font-size:${15 * u}px; color:var(--mute); }
.flow { display:flex; align-items:stretch; gap:${10 * u}px; }
.box { flex:1; border:1.5px solid var(--ink); background:#fff; border-radius:${6 * u}px; padding:${14 * u}px; }
.box.ai { border-color:var(--teal); background:var(--teal-bg); }
.box .t { font-size:${21 * u}px; font-weight:600; }
.box.ai .t { color:var(--teal); }
.box .s { font-family:Consolas,monospace; font-size:${14.5 * u}px; color:var(--mute); margin-top:${6 * u}px; line-height:1.35; }
.arrow { color:var(--teal); font-size:${26 * u}px; flex:0 0 auto; align-self:center; }
.gate { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:${10 * u}px; flex:0 0 auto; }
.diamond { width:${34 * u}px; height:${34 * u}px; background:var(--orange); transform:rotate(45deg); margin:0 ${8 * u}px; }
.gate span { font-family:Consolas,monospace; font-size:${14 * u}px; color:var(--orange); font-weight:700; text-align:center; line-height:1.2; }
.lane .label { display:flex; justify-content:space-between; font-family:Consolas,monospace; font-size:${15 * u}px; letter-spacing:.1em; color:var(--mute); margin-bottom:${10 * u}px; }
.notes { display:grid; grid-template-columns:1fr 1fr; gap:${16 * u}px ${36 * u}px; margin-top:${10 * u}px; }
.note { font-size:${18.5 * u}px; line-height:1.4; }
.note b { display:block; font-size:${19 * u}px; margin-bottom:${4 * u}px; }
.shot { flex:1; min-height:0; display:flex; justify-content:center; align-items:center; }
.frame { flex:0 0 auto; border:1px solid var(--line); border-radius:${10 * u}px; overflow:hidden; background:#fff; box-shadow:0 ${8 * u}px ${26 * u}px rgba(23,32,42,.10); }
.chrome { height:${30 * u}px; background:#eef0ee; display:flex; align-items:center; gap:${7 * u}px; padding:0 ${12 * u}px; border-bottom:1px solid var(--line); }
.chrome i { width:${11 * u}px; height:${11 * u}px; border-radius:50%; background:#cfd4cf; display:block; }
.chrome em { font-style:normal; font-family:Consolas,monospace; font-size:${13.5 * u}px; color:var(--mute); margin-left:${10 * u}px; }
.chrome em b { color:var(--ink); font-weight:600; }
.view { overflow:hidden; position:relative; }
.view img { display:block; width:100%; }
.frame.cut .view::after { content:''; position:absolute; left:0; right:0; bottom:0; height:${70 * u}px; background:linear-gradient(rgba(250,249,246,0), #faf9f6); }
.tiles { display:grid; grid-template-columns:repeat(3, 1fr); gap:${18 * u}px; }
.tile { background:#fff; border:1px solid var(--line); border-radius:${8 * u}px; padding:${20 * u}px ${22 * u}px; }
.tile .k { font-family:Consolas,monospace; font-size:${14.5 * u}px; color:var(--mute); letter-spacing:.06em; }
.tile .v { font-family:Georgia,serif; font-size:${48 * u}px; font-weight:600; margin-top:${6 * u}px; line-height:1.05; }
.tile .v small { font-size:${21 * u}px; color:var(--mute); font-family:"Segoe UI",sans-serif; font-weight:400; }
.tile .d { font-size:${16.5 * u}px; color:var(--mute); margin-top:${8 * u}px; line-height:1.4; }
.tile.warn { border-color:var(--orange); background:var(--orange-bg); }
table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); }
th, td { text-align:left; padding:${14 * u}px ${18 * u}px; border-bottom:1px solid var(--line); font-size:${19 * u}px; }
th { font-family:Consolas,monospace; font-size:${14.5 * u}px; color:var(--mute); font-weight:600; letter-spacing:.06em; }
td.num { font-family:Consolas,monospace; }
tr:last-child td { border-bottom:0; }
.small { font-size:${16 * u}px; color:var(--mute); line-height:1.4; }
.term { background:#17202a; color:#e7ece9; border-radius:${10 * u}px; padding:${24 * u}px ${28 * u}px; font-family:Consolas,monospace; font-size:${19 * u}px; line-height:1.65; }
.term .c { color:#8fa3ad; }
.term .g { color:#7fd3a3; }
.term .o { color:#f6a26b; }
.caption { font-size:${24 * u}px; line-height:1.4; }
.caption b { color:var(--teal); }
`;

// Sizes each screenshot frame to the space it has. "fit" shows the whole (cropped) image;
// "fill" uses the full width and cuts the bottom off with a fade.
const LAYOUT = `
for (const shot of document.querySelectorAll('.shot')) {
  const frame = shot.querySelector('.frame'), view = frame.querySelector('.view'), image = view.querySelector('img');
  const chrome = frame.querySelector('.chrome').offsetHeight + 2;
  const W = shot.clientWidth, H = shot.clientHeight;
  const ratio = image.naturalWidth / (image.naturalHeight * Number(shot.dataset.crop || 1));
  let w, h;
  if (shot.dataset.fit === 'fill') { w = W; h = Math.min(W / ratio, H - chrome); if (h < W / ratio - 1) frame.classList.add('cut'); }
  else { w = Math.min(W, (H - chrome) * ratio); h = w / ratio; }
  frame.style.width = w + 'px';
  view.style.height = h + 'px';
}
// Text-only cards: scale the block up (at most 1.3x) when the canvas has room to spare.
const inner = document.querySelector('.main .inner');
if (inner) {
  const main = inner.parentElement;
  const z = Math.min(1.3, (main.clientHeight * 0.85) / inner.offsetHeight);
  // Chromium's zoom keeps percentage widths as they are, so only the type and spacing grow.
  if (z > 1.02) inner.style.zoom = z;
}
document.body.dataset.ready = '1';
`;

const page = (u: number, tag: string, head: string, main: string, foot = SIM_FOOT, layout: 'center' | 'spread' = 'center') => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS(u)}</style></head><body>
<div class="top"><div class="tag"><b>LEAD TO LEDGER</b>${tag}</div><div class="name">Noah Hicks</div></div>
${head}
<div class="main ${layout}">${layout === 'center' && !main.includes('class="shot"') ? `<div class="inner">${main}</div>` : main}</div>
<div class="foot"><span>${foot}</span><span>Built with AI coding agents under review</span></div>
<script>addEventListener('load', () => { ${LAYOUT} });</script>
</body></html>`;

const shot = (name: string, label: string, opts: { fit?: 'fit' | 'fill'; crop?: number } = {}) =>
  `<div class="shot" data-fit="${opts.fit ?? 'fit'}" data-crop="${opts.crop ?? 1}"><div class="frame"><div class="chrome"><i></i><i></i><i></i><em>${label}</em></div><div class="view"><img src="${img(name)}"></div></div></div>`;

// The approval page's content sits in its top 42%; the rest is empty page.
const APPROVALS_CROP = 0.42;

const leadFlow = `<div class="flow">
  <div class="box"><div class="t">Web form</div><div class="s">saved before anything else</div></div><div class="arrow">→</div>
  <div class="box"><div class="t">n8n</div><div class="s">plain rules first</div></div><div class="arrow">→</div>
  <div class="box ai"><div class="t">Local model</div><div class="s">strict schema, checked by code</div></div><div class="arrow">→</div>
  <div class="box ai"><div class="t">HubSpot</div><div class="s">ai_ fields only</div></div><div class="arrow">→</div>
  <div class="box"><div class="t">Sales</div><div class="s">still decides</div></div>
</div>`;

const dealFlow = `<div class="flow">
  <div class="box"><div class="t">Won deal</div><div class="s">polled, one job per deal</div></div><div class="arrow">→</div>
  <div class="gate"><div class="diamond"></div><span>person<br>approves</span></div><div class="arrow">→</div>
  <div class="box ai"><div class="t">Worker</div><div class="s">lease, key, look first</div></div><div class="arrow">→</div>
  <div class="box ai"><div class="t">QuickBooks</div><div class="s">customer, invoice, read-back</div></div><div class="arrow">→</div>
  <div class="box"><div class="t">Deal note</div><div class="s">invoice number on the deal</div></div>
</div>`;

// The kill drill, told from the job's own event log. The demo stack uses the worker's default lease.
const LEASE_S = 120;
const blank = '<span class="c">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>';
const drillLines = facts.drill.events.flatMap((e) => {
  const d = e.detail ?? {};
  const time = `<span class="c">${e.at.slice(11, 19)}</span>`;
  const text: Record<string, string> = {
    approved: `approved by ${d.by}`,
    claimed: d.after_dead_worker ? `<span class="o">claimed again by the restarted worker (attempt ${d.attempt})</span>` : `claimed by a worker (attempt ${d.attempt})`,
    created: d.call === 'qb.create_customer' ? `customer created (QuickBooks ID ${d.id})` : d.call === 'qb.create_invoice' ? `invoice created (QuickBooks ID ${d.id})` : 'job created',
    unknown_outcome_resolving: `<span class="o">last attempt's result unknown: waiting, then looking first</span>`,
    found_existing: `<span class="g">found the invoice the dead worker wrote (ID ${d.id}): no second write</span>`,
    done: '<span class="g">done</span>',
  };
  const line = `<div>${time}  ${text[e.event] ?? e.event}</div>`;
  // The kill is not in the job's log: the process just stops. Show it where it happened.
  if (!d.after_dead_worker) return [line];
  return [
    `<div>${blank}  <span class="o">worker container killed (SIGKILL) while QuickBooks held the invoice write</span></div>`,
    `<div>${blank}  <span class="c">container restarted; the job waits for the dead worker's ${LEASE_S} s lease to run out</span></div>`,
    line,
  ];
});

const cards: Record<string, (u: number) => string> = {
  cover: (u) =>
    page(
      u,
      'PORTFOLIO REPO',
      `<h1>From web lead to QuickBooks invoice, with AI that only takes notes</h1>
       <p class="lede">An n8n workflow sorts what rules can, a local model writes only to <code>ai_</code> fields, a person approves the money, and the worker that creates the invoice is tested by killing it.</p>`,
      `<div class="lane"><div class="label"><span>EVERY INBOUND LEAD</span><span>SHADOW MODE UNTIL A NAMED SIGN-OFF</span></div>${leadFlow}</div>
       <div class="lane"><div class="label"><span>EVERY WON DEAL</span><span>SAFE TO KILL AT ANY STEP</span></div>${dealFlow}</div>
       <div class="tiles">
         <div class="tile"><div class="k">WORKER KILLED MID-JOB</div><div class="v">${dups(kill)} <small>duplicates in ${kill.cells} runs</small></div></div>
         <div class="tile"><div class="k">REAL HUBSPOT AND QUICKBOOKS RUN</div><div class="v">${real.checks_total - real.checks_failed} <small>of ${real.checks_total} checks passed</small></div></div>
         <div class="tile"><div class="k">JUNK PROMOTED TO A SALE</div><div class="v">${granite.junk_promoted.promoted} <small>of ${granite.junk_promoted.junk}, held-out set</small></div></div>
       </div>`,
      'Synthetic data. Simulators, then one run on a HubSpot test account and the QuickBooks sandbox.',
      'spread',
    ),
  architecture: (u) =>
    page(
      u,
      'HOW IT WORKS',
      '<h2>Two paths, with a person at each point that matters</h2>',
      `<div class="lane"><div class="label"><span>EVERY INBOUND LEAD</span><span>SHADOW MODE UNTIL A NAMED SIGN-OFF</span></div>${leadFlow}</div>
       <div class="lane"><div class="label"><span>EVERY WON DEAL</span><span>SAFE TO KILL AT ANY STEP</span></div>${dealFlow}</div>
       <div class="notes">
         <div class="note"><b>Model down or wrong</b>The contact still reaches the CRM. Bad output writes nothing but a review flag.</div>
         <div class="note"><b>Edited after approval</b>Refused. The approval covers a hash of exactly what will be sent.</div>
         <div class="note"><b>Response lost after a write</b>The next attempt looks up the record before writing again.</div>
         <div class="note"><b>A duplicate gets through anyway</b>A sweep finds it and sends it to a person. Nothing is deleted.</div>
       </div>`,
      undefined,
      'spread',
    ),
  workflow: (u) => page(u, 'N8N', '<h2>The n8n workflow: rules, contact upsert, triage, alerts</h2>', shot('n8n-workflow', 'n8n, self-hosted, localhost only')),
  status: (u) => page(u, 'TRIAGE', '<h2>Every lead sorted, and what was written to the CRM</h2>', shot('status-live', `localhost:4000/status &nbsp;·&nbsp; model: <b>${facts.model}</b>`, { fit: 'fill' })),
  approvals: (u) =>
    page(
      u,
      'INVOICES',
      '<h2>Nothing reaches QuickBooks until a person approves it</h2>',
      shot('approvals-waiting', 'localhost:4000/approvals &nbsp;·&nbsp; <b>won deals, waiting</b>', { crop: APPROVALS_CROP }) +
        shot('approvals-done', 'localhost:4000/approvals &nbsp;·&nbsp; <b>after approval: invoice IDs from QuickBooks</b>', { crop: APPROVALS_CROP }),
    ),
  restart: (u) =>
    page(
      u,
      'RESTART TESTS',
      `<h2>Killed before, during and after every API call</h2>
       <p class="lede">A real worker process is killed, a second one finishes the job, and the simulator counts what exists. Each case runs against all three ways QuickBooks might treat a repeated request ID.</p>`,
      `<div class="tiles">
         <div class="tile"><div class="k">WORKER KILLED</div><div class="v">${dups(kill)} <small>duplicates in ${kill.cells} runs</small></div><div class="d">Around each of 8 API calls: before, during and after.</div></div>
         <div class="tile"><div class="k">INJECTED FAILURES</div><div class="v">${dups(failure)} <small>duplicates in ${failure.cells} runs</small></div><div class="d">Lost responses, timeouts, 429, 5xx, HTML error pages, 200 with a Fault, expired tokens.</div></div>
         <div class="tile"><div class="k">FOUR WORKERS AT ONCE</div><div class="v">${dups(conc)} <small>duplicates in ${conc.cells} runs</small></div><div class="d">Twelve jobs, two sharing a customer, one worker killed.</div></div>
         <div class="tile warn"><div class="k">LOOKUP FORCED TO MISS</div><div class="v">${dups(late) + dups(lag)} <small>duplicates in ${late.cells + lag.cells} runs</small></div><div class="d">Only when QuickBooks also ignores the request ID and allows a repeated invoice number.${gapFound ? ' The sweep found each one and sent it to a person.' : ''}</div></div>
         <div class="tile"><div class="k">TOKEN REFRESH KILLED</div><div class="v">${dups(token)} <small>duplicates in ${token.cells} runs</small></div><div class="d">${reconnects} of ${tokenCells.length} needed a person to reconnect${tokenOneInvoice ? '; each still ended with one invoice' : ''}.</div></div>
         <div class="tile"><div class="k">CONTROL</div><div class="v">${restart.control.invoices_counted} <small>invoices from one blind retry</small></div><div class="d">With the checks skipped, the counts do see a duplicate.</div></div>
       </div>`,
      `${restart.summary.passed} of ${restart.summary.cells} cases passed, on the simulators. Set to replay request IDs, as the real sandbox did: ${dups(replayMode)} duplicates in ${replayMode.cells}.`,
    ),
  scoring: (u) =>
    page(
      u,
      'TRIAGE SCORES',
      `<h2>Scored on 240 held-out synthetic leads</h2>
       <p class="lede">Two local models, the same prompt and rules, with nothing tuned against this set. Neither met the pass bar, so the go-live gate refused both.</p>`,
      `<table>
         <tr><th>HELD-OUT SET</th><th>GRANITE 4.1 8B (DEFAULT)</th><th>BONSAI 27B</th></tr>
         <tr><td>Category accuracy</td><td class="num">${pct(granite.category.accuracy)}</td><td class="num">${pct(bonsai.category.accuracy)}</td></tr>
         <tr><td>Real leads sorted as not a lead (limit 5%)</td><td class="num">${pct(granite.real_lead_lost.rate)}</td><td class="num">${pct(bonsai.real_lead_lost.rate)}</td></tr>
         <tr><td>Urgent leads flagged high priority</td><td class="num">${pct(granite.high_priority.recall)}</td><td class="num">${pct(bonsai.high_priority.recall)}</td></tr>
         <tr><td>Junk promoted to a sale</td><td class="num">${granite.junk_promoted.promoted} of ${granite.junk_promoted.junk}</td><td class="num">${bonsai.junk_promoted.promoted} of ${bonsai.junk_promoted.junk}</td></tr>
         <tr><td>Injection attacks that steered the model</td><td class="num">${injG.steered} of ${injG.n}</td><td class="num">${injB.steered} of ${injB.n}</td></tr>
         <tr><td>Pass bar checks met</td><td class="num">${passBar(granite)}</td><td class="num">${passBar(bonsai)}</td></tr>
       </table>
       <p class="small">${missedNote} Injection: the model alone, rules off. Bonsai's figures are from its logged rerun; a model server failure cut its first held-out run short.</p>`,
      'Synthetic leads, labeled by the people who wrote the templates, not a sales team.',
    ),
  real: (u) => {
    const f = real.facts as Record<string, unknown>;
    const words: Record<Verdict, string> = { matched: 'matched', fixed: '<b>was wrong, fixed</b>', harsher: 'slower, kept as the harder case', left: 'differs, unused' };
    const rows: Array<[string, string, string]> = [
      ['Same request ID twice: customer', f.qb_requestid_customer === 'replay' ? 'replayed, no second record' : String(f.qb_requestid_customer), 'Same requestid twice on a customer'],
      ['Same request ID twice: invoice', f.qb_requestid_invoice === 'replay' ? 'replayed, no second record' : String(f.qb_requestid_invoice), 'Same requestid twice on an invoice'],
      ['Same invoice number, new request ID', f.qb_duplicate_doc_number === 'allowed' ? 'allowed: a second invoice' : String(f.qb_duplicate_doc_number), 'Same DocNumber with a new requestid'],
      ['A query sees a new invoice', `within ${f.qb_query_sees_new_invoice_within_ms} ms`, 'A query sees a new invoice'],
      ['HubSpot search sees a new contact', `within ${f.hubspot_search_lag_ms_upper_bound} ms`, 'Search sees a new contact'],
      ['Deal created with no pipeline', `refused, ${(f.hubspot_deal_without_pipeline as { status: number }).status}`, 'Create a deal with no pipeline'],
      ['GET a missing contact', `${(f.hubspot_not_found as { status: number }).status}, empty body`, "GET a contact that doesn't exist"],
      ['Duplicate customer name', 'Fault 6240, no ID in the detail', 'Duplicate customer DisplayName'],
    ];
    return page(
      u,
      'REAL RUN',
      `<h2>Then one run against HubSpot and the QuickBooks sandbox</h2>
       <p class="lede">A HubSpot developer test account and a QuickBooks sandbox company, with synthetic records marked as such. ${real.checks_total - real.checks_failed} of ${real.checks_total} checks passed, including ${drillsOk} worker kills that each left one invoice. The simulators had ${fixedCount} details wrong, all now fixed; only the missing pipeline stopped anything.</p>`,
      `<table>
         <tr><th>CHECKED</th><th>REAL RESULT</th><th>SIMULATOR</th></tr>
         ${rows.map(([label, result, behaviour]) => `<tr><td>${label}</td><td>${result}</td><td>${words[verdictOf(behaviour)]}</td></tr>`).join('')}
       </table>`,
      `One run, ${real.started_at.slice(0, 10)} UTC. Single observations. Responses saved, scrubbed, in results/real/.`,
    );
  },
  drill: (u) =>
    page(
      u,
      'KILL DRILL',
      '<h2>The worker container was killed while QuickBooks was writing the invoice</h2>',
      `<div class="term">
         ${drillLines.join('\n')}
         <div><span class="c">--</span></div>
         <div>invoices numbered ${facts.drill.doc_number}: ${facts.drill.invoices_after_kill} right after the kill, <span class="g">${facts.drill.invoices_after_restart} after the restart</span></div>
       </div>`,
      "From this demo run on the simulators: the job's own event log.",
    ),
};

// ---- Video frames: a screenshot with a caption --------------------------------------
const frame = (title: string, shotHtml: string, caption: string) => (u: number) => page(u, 'DEMO', `<h2>${title}</h2>`, `${shotHtml}<p class="caption">${caption}</p>`);

const video: Array<[string, (u: number) => string, number]> = [
  ['01', cards.cover!, 5],
  ['02', frame('A lead comes in through the web form', shot(formShot, 'localhost:4000 &nbsp;·&nbsp; a fictional HVAC company', { fit: 'fill' }), 'The submission is <b>saved to Postgres first</b>, then handed to n8n. If n8n is down, it waits and is sent again.'), 5],
  ['03', frame('n8n sorts what plain rules can handle', shot('n8n-workflow', 'localhost:5678'), 'Rules run in a Code node. The contact is upserted by email <b>before</b> the AI step, so a dead model cannot lose a lead.'), 6],
  ['04', frame('Shadow mode: the model answers, nothing is written', shot('status-shadow', 'localhost:4000/status', { fit: 'fill' }), 'Its answers are logged as what <b>would</b> be written. Going live needs a named sign-off on a scored run.'), 6],
  ['05', frame('Live: only ai_ fields, from a fixed list', shot('status-live', 'localhost:4000/status', { fit: 'fill' }), `Rules handle what they can. The model (${facts.model}) writes notes; <b>sales still decides</b>.`), 6],
  ['06', frame('A won deal waits for a person', shot('approvals-waiting', 'localhost:4000/approvals', { crop: APPROVALS_CROP }), 'The approval covers <b>one exact version</b>. Edit the deal afterwards and it comes back for approval.'), 5],
  ['07', frame('The worker creates the customer and the invoice', shot('approvals-done', 'localhost:4000/approvals', { crop: APPROVALS_CROP }), 'Each write carries a fixed key, looks first, reads the invoice back, and notes it on the deal.'), 5],
  ['08', cards.drill!, 8],
  ['09', cards.restart!, 7],
  ['10', cards.real!, 8],
  ['11', cards.scoring!, 7],
];

// ---- Render -------------------------------------------------------------------------------
const browser = await chromium.launch({ channel: 'msedge', headless: true });
async function render(html: string, width: number, height: number, file: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const p = await context.newPage();
  await p.setContent(html, { waitUntil: 'load' });
  await p.waitForFunction(() => (globalThis as unknown as { document: { body: { dataset: { ready?: string } } } }).document.body.dataset.ready === '1');
  await p.screenshot({ path: file });
  await context.close();
  console.log(`wrote ${path.relative(ROOT, file)}`);
}

const DOCS = path.join(ROOT, 'docs/images');
mkdirSync(DOCS, { recursive: true });
for (const [name, card] of [['architecture', cards.architecture], ['n8n-workflow', cards.workflow], ['triage-status', cards.status], ['approvals', cards.approvals], ['kill-drill', cards.drill], ['restart-tests', cards.restart], ['real-run', cards.real], ['scores', cards.scoring]] as const) {
  await render(card!(1), 1600, 1000, path.join(DOCS, `${name}.png`));
}

if (args.portfolio) {
  const portfolio = path.resolve(args.portfolio);
  const gallery: Array<[string, (u: number) => string]> = [
    ['00-thumbnail', cards.cover!],
    ['01-architecture', cards.architecture!],
    ['02-n8n-workflow', cards.workflow!],
    ['03-triage', cards.status!],
    ['04-approvals', cards.approvals!],
    ['05-kill-drill', cards.drill!],
    ['06-restart-tests', cards.restart!],
    ['07-real-run', cards.real!],
    ['08-scores', cards.scoring!],
  ];
  for (const [dir, w, h, u] of [['upwork-1600x1200', 1600, 1200, 1], ['fiverr-1280x769', 1280, 769, 0.7]] as const) {
    mkdirSync(path.join(portfolio, dir), { recursive: true });
    for (const [name, card] of gallery) await render(card(u), w, h, path.join(portfolio, dir, `${name}.png`));
  }

  const frames = path.join(IN, 'frames');
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  const list: string[] = [];
  for (const [n, card, seconds] of video) {
    const file = path.join(frames, `${n}.png`);
    await render(card(1.2), 1920, 1080, file);
    list.push(`file '${file.replaceAll('\\', '/')}'`, `duration ${seconds}`);
  }
  list.push(`file '${path.join(frames, `${video.at(-1)![0]}.png`).replaceAll('\\', '/')}'`);
  writeFileSync(path.join(frames, 'list.txt'), `${list.join('\n')}\n`);
  const total = video.reduce((sum, v) => sum + v[2], 0);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(frames, 'list.txt'), '-t', String(total), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', path.join(portfolio, 'demo.mp4')]);
  console.log(`wrote demo.mp4 (${total} s)`);
}
await browser.close();
