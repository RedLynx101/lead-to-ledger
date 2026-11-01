// Receiving a form submission. The row goes on disk first, then n8n is told. If n8n is
// down, the row waits and the re-drive loop tries again, so a dead workflow engine can
// delay a lead but not lose it.

import type { Db } from '../db.ts';
import { submissionKey } from '../triage/service.ts';
import { INQUIRY_TYPES } from '../leads/types.ts';
import type { LeadForm } from '../leads/types.ts';

const TEXT_LIMIT = 200;
const MESSAGE_LIMIT = 5000;
const MAX_HANDOFF_ATTEMPTS = 8;

export function normalizeForm(fields: Record<string, unknown>): { ok: true; form: LeadForm } | { ok: false; error: string } {
  const text = (name: string, limit = TEXT_LIMIT) => String(fields[name] ?? '').trim().slice(0, limit);
  const email = text('email').toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Please enter a valid email address.' };
  const message = text('message', MESSAGE_LIMIT);
  if (!message) return { ok: false, error: 'Please tell us what you need.' };
  const inquiry = text('inquiry_type');
  return {
    ok: true,
    form: {
      first_name: text('first_name'),
      last_name: text('last_name'),
      email,
      phone: text('phone'),
      company: text('company'),
      job_title: text('job_title'),
      website: text('website'),
      property_city: text('property_city'),
      property_state: text('property_state').toUpperCase(),
      inquiry_type: (INQUIRY_TYPES as readonly string[]).includes(inquiry) ? (inquiry as LeadForm['inquiry_type']) : 'other',
      customer_number: text('customer_number'),
      message,
      hp_field: text('hp_field'),
    },
  };
}

async function handOff(db: Db, key: string, form: unknown, synthetic: boolean, webhookUrl: string): Promise<boolean> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ submission_key: key, synthetic, form }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await db.query('update lead_submissions set handed_off_at = now(), handoff_attempts = handoff_attempts + 1, last_handoff_error = null where key = $1', [key]);
    return true;
  } catch (error) {
    await db.query('update lead_submissions set handoff_attempts = handoff_attempts + 1, last_handoff_error = $2 where key = $1', [key, (error as Error).message.slice(0, 300)]);
    return false;
  }
}

export interface ReceiveResult {
  ok: true;
  key: string;
  duplicate: boolean;
  handed_off: boolean;
}

export async function receiveLead(
  db: Db,
  fields: Record<string, unknown>,
  options: { webhookUrl: string },
): Promise<ReceiveResult | { ok: false; error: string }> {
  const normalized = normalizeForm(fields);
  if (!normalized.ok) return normalized;
  const { form } = normalized;
  const synthetic = fields.synthetic === true || fields.synthetic === 'true';
  const key = submissionKey(form);
  const stored = await db.query<{ inserted: boolean }>(
    `insert into lead_submissions (key, form, synthetic) values ($1, $2, $3)
     on conflict (key) do update set resubmit_count = lead_submissions.resubmit_count + 1
     returning (xmax = 0) as inserted`,
    [key, JSON.stringify(form), synthetic],
  );
  const inserted = stored.rows[0].inserted;
  // A double-click or a repeat visit: the first copy is already on its way.
  if (!inserted) return { ok: true, key, duplicate: true, handed_off: false };
  const handedOff = await handOff(db, key, form, synthetic, options.webhookUrl);
  return { ok: true, key, duplicate: false, handed_off: handedOff };
}

export async function handOffPending(db: Db, options: { webhookUrl: string }): Promise<number> {
  const pending = await db.query<{ key: string; form: unknown; synthetic: boolean }>(
    // The second branch catches a lead n8n accepted but never finished, for example
    // because this service was down when n8n called back. Repeating it is safe: the
    // contact upsert is by email, and triage answers from its row.
    `select s.key, s.form, s.synthetic from lead_submissions s
     where s.handoff_attempts < $1
       and ((s.handed_off_at is null and s.received_at < now() - interval '5 seconds')
            or (s.handed_off_at < now() - interval '5 minutes'
                and not exists (select 1 from triage_runs t where t.key = s.key)))
     order by s.received_at limit 25`,
    [MAX_HANDOFF_ATTEMPTS],
  );
  let delivered = 0;
  for (const row of pending.rows) {
    if (await handOff(db, row.key, row.form, row.synthetic, options.webhookUrl)) delivered += 1;
  }
  return delivered;
}
