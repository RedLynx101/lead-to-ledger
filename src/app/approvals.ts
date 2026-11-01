// The page where a person says yes to an invoice. The form carries the digest of what the
// person saw, so an edit made after the page loaded makes the approval fail.
//
// There's no login here: this runs on localhost, and the name is whatever gets typed. A
// real deployment needs the name to come from a sign-in.

import type { Db } from '../db.ts';
import type { InvoiceJob } from '../worker/jobs.ts';

export async function listJobs(db: Db): Promise<Array<InvoiceJob & { approved_by: string | null }>> {
  const res = await db.query<InvoiceJob & { approved_by: string | null }>(
    `select j.*, a.approved_by from invoice_jobs j left join approvals a on a.id = j.approval_id order by j.created_at desc limit 100`,
  );
  return res.rows;
}

const esc = (value: unknown) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const money = (amount: unknown) => (typeof amount === 'number' ? `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '');

const STATUS_LABELS: Record<string, string> = {
  awaiting_approval: 'Waiting for approval',
  queued: 'Approved, in the queue',
  running: 'Running',
  done: 'Done',
  needs_person: 'Needs a person',
};

export function renderApprovalsPage(jobs: Array<InvoiceJob & { approved_by: string | null }>, notice?: string): string {
  const rows = jobs
    .map((job) => {
      const { customer, invoice } = job.payload ?? {};
      const action =
        job.status === 'awaiting_approval'
          ? `<form method="post" action="/approvals/${esc(job.id)}/approve" class="approve">
               <input type="hidden" name="digest" value="${esc(job.digest)}">
               <input name="approved_by" placeholder="Your name" aria-label="Your name" required autocomplete="off">
               <button type="submit">Approve</button>
             </form>`
          : job.approved_by
            ? `<span class="mute">Approved by ${esc(job.approved_by)}</span>`
            : '';
      return `<tr>
        <td>${esc(customer?.DisplayName) || '<span class="mute">unknown</span>'}<div class="mute small">${esc(invoice?.description)}</div></td>
        <td class="num mono">${money(invoice?.amount)}</td>
        <td class="mono">${esc(invoice?.doc_number)}</td>
        <td><span class="pill ${esc(job.status)}">${esc(STATUS_LABELS[job.status] ?? job.status)}</span>${job.problem ? `<div class="small warn">${esc(job.problem)}</div>` : ''}</td>
        <td class="mono">${esc(job.qb_invoice_id)}</td>
        <td>${action}</td>
      </tr>`;
    })
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice approvals</title>
<style>
:root { --bg:#faf9f6; --ink:#17202a; --mute:#66707a; --line:#d9dcd8; --teal:#0e6377; --teal-bg:#e3f4f8; --orange:#c2410c; --orange-bg:#fdeee3; --green:#166534; --green-bg:#e7f5ec; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:1100px; margin:0 auto; padding:28px 20px 60px; }
h1 { font-size:22px; margin:0 0 4px; }
.sub { color:var(--mute); margin:0 0 18px; }
.notice { background:var(--orange-bg); color:var(--orange); border-radius:6px; padding:10px 12px; margin:0 0 16px; }
.wrap { overflow-x:auto; border:1px solid var(--line); border-radius:6px; background:#fff; }
table { border-collapse:collapse; width:100%; min-width:820px; }
th,td { text-align:left; padding:10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; color:var(--mute); font-weight:600; white-space:nowrap; }
tr:last-child td { border-bottom:0; }
.mono { font-family:ui-monospace,Consolas,monospace; font-size:13px; }
.num { text-align:right; white-space:nowrap; }
.mute { color:var(--mute); }
.small { font-size:13px; }
.warn { color:var(--orange); }
.pill { display:inline-block; padding:1px 7px; border-radius:4px; font-size:12px; white-space:nowrap; background:#eef0ee; color:var(--mute); }
.pill.awaiting_approval, .pill.needs_person { background:var(--orange-bg); color:var(--orange); }
.pill.queued, .pill.running { background:var(--teal-bg); color:var(--teal); }
.pill.done { background:var(--green-bg); color:var(--green); }
.approve { display:flex; gap:6px; }
.approve input { font:inherit; padding:5px 8px; border:1px solid var(--line); border-radius:4px; width:130px; }
.approve button { font:inherit; font-weight:600; color:#fff; background:var(--teal); border:0; border-radius:4px; padding:5px 12px; cursor:pointer; }
.note { color:var(--mute); font-size:13px; margin-top:18px; }
</style></head><body><main>
<h1>Invoice approvals</h1>
<p class="sub">Nothing is sent to QuickBooks until someone approves it here. Each approval covers exactly what's shown, once.</p>
${notice ? `<p class="notice">${esc(notice)}</p>` : ''}
<div class="wrap"><table>
<thead><tr><th>Customer and deal</th><th class="num">Amount</th><th>Invoice number</th><th>Status</th><th>QuickBooks ID</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="mute">No won deals yet. The worker polls the CRM for them.</td></tr>'}</tbody>
</table></div>
<p class="note">Everything on this page comes from synthetic test data for a fictional company.</p>
</main></body></html>`;
}

export const APPROVAL_MESSAGES: Record<string, string> = {
  no_name: 'An approval needs a name.',
  not_found: 'That job no longer exists.',
  not_awaiting_approval: "That job isn't waiting for approval any more.",
  stale_digest: 'The deal changed after this page loaded, so that approval was refused. Check the new details and approve again.',
};
