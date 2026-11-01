// Runs one approved job: confirm the deal hasn't changed, create the customer, create the
// invoice, read it back, and note it on the deal. A kill at any point leaves durable state
// that the next worker can pick up.
//
// How a write stays single:
//   1. The key is fixed per record, so a retry always carries the same `requestid`.
//   2. An intent row goes on disk before the call. If a worker later finds one, the last
//      attempt's outcome is unknown, so it waits out a settling period and looks first.
//   3. It looks by a handle the worker chose: DisplayName for customers, DocNumber for
//      invoices. Found means confirmed, and there's no second write.
//   4. After the invoice exists, it reads it back and counts. More than one goes to a
//      person. This code never deletes or voids anything.
//
// Known gap: step 3 can't see a write that's still in flight. If QuickBooks commits the
// first attempt later than the settling period, ignores `requestid`, and isn't enforcing
// unique DocNumbers, a duplicate can land. The restart tests measure this case, and the
// reconcile sweep finds it afterwards.

import type { Db } from '../db.ts';
import { HubSpotError } from '../hubspot/client.ts';
import type { HubSpotClient } from '../hubspot/client.ts';
import type { QbEntity, QbFailure, QbResult, QuickBooksClient } from '../quickbooks/client.ts';
import { ReconnectNeeded, TokenRefreshFailed } from '../quickbooks/tokens.ts';
import {
  backToApproval,
  confirmCall,
  finishJob,
  getCall,
  LostLease,
  markIntent,
  markWrittenBack,
  raiseJobAlert,
  recordEvent,
  releaseForRetry,
  renewLease,
  saveCustomerId,
  saveInvoiceId,
  sendToPerson,
} from './jobs.ts';
import type { ClaimedJob } from './jobs.ts';
import { buildPayload, CONTACT_PROPERTIES_READ, contactIdOf, customerRequestId, DEAL_PROPERTIES_READ, digestOf, invoiceBody, invoiceRequestId } from './payload.ts';
import type { PayloadResult } from './payload.ts';

export interface WorkerSettings {
  leaseSeconds: number;
  /** How long to wait after an unknown outcome before trusting a lookup. */
  settleMs: number;
  retryDelayMs: number;
  maxAttempts: number;
  reconnectDelayMs: number;
  wonStage: string;
  itemName: string;
}

export interface WorkerDeps {
  db: Db;
  hubspot: HubSpotClient;
  qb: QuickBooksClient;
  settings: WorkerSettings;
  checkpoint: (name: string) => void;
}

export type JobOutcome = 'done' | 'retry' | 'needs_person' | 'back_to_approval' | 'blocked' | 'lost_lease';

class Transient extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs = 0) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

class Permanent extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads a deal and works out what would be sent today. */
export async function readDealPayload(hubspot: HubSpotClient, dealId: string, itemName: string, wonStage: string): Promise<{ won: boolean; result: PayloadResult }> {
  const deal = await hubspot.getDeal(dealId, DEAL_PROPERTIES_READ);
  if (!deal) return { won: false, result: { ok: false, problem: 'deal no longer exists' } };
  const contactId = contactIdOf(deal);
  const contact = contactId ? await hubspot.getContact(contactId, CONTACT_PROPERTIES_READ) : null;
  return { won: deal.properties.dealstage === wonStage, result: buildPayload(deal, contact, itemName) };
}

function readFailure(failure: QbFailure): Error {
  if (failure.kind === 'forbidden' || failure.kind === 'validation') return new Permanent(`${failure.code ?? failure.status}: ${failure.message}`);
  return new Transient(failure.message, failure.retryAfterMs);
}

function must<T>(result: QbResult<T>): T {
  if (!result.ok) throw readFailure(result);
  return result.body;
}

function hubspotFailure(error: unknown): Error {
  if (error instanceof HubSpotError) {
    if (error.retryable) return new Transient(error.message);
    return new Permanent(`HubSpot ${error.status ?? ''} ${error.category ?? ''}`.trim());
  }
  return error as Error;
}

export async function processJob(deps: WorkerDeps, job: ClaimedJob): Promise<JobOutcome> {
  const { db, hubspot, qb, settings, checkpoint } = deps;
  const { payload } = job;

  async function step<T>(name: string, work: () => Promise<T>): Promise<T> {
    await renewLease(db, job, settings.leaseSeconds);
    checkpoint(`before:${name}`);
    const out = await work();
    checkpoint(`after:${name}`);
    return out;
  }

  /** A previous attempt may have written. Give it time to land before looking. */
  async function settleAfter(lastAttempt: Date): Promise<void> {
    const wait = lastAttempt.getTime() + settings.settleMs - Date.now();
    if (wait > 0) await sleep(wait);
    await renewLease(db, job, settings.leaseSeconds);
  }

  async function ensureRecord(options: {
    call: string;
    key: string;
    label: string;
    lookup: () => Promise<QbEntity | null>;
    create: () => Promise<QbResult<QbEntity>>;
  }): Promise<string> {
    const { call, key, label, lookup, create } = options;
    const prior = await getCall(db, job.id, call);
    if (prior?.status === 'confirmed' && prior.response_id) return prior.response_id;
    if (prior) {
      await recordEvent(db, job.id, 'unknown_outcome_resolving', { call, attempts: prior.attempts });
      await settleAfter(prior.last_attempt_at);
    }

    const found = await lookup();
    if (found) {
      await confirmCall(db, job.id, call, key, found.Id, 'lookup');
      await recordEvent(db, job.id, 'found_existing', { call, id: found.Id });
      return found.Id;
    }

    await markIntent(db, job.id, call, key);
    const res = await step(`qb.create_${label}`, create);
    if (res.ok) {
      await confirmCall(db, job.id, call, key, res.body.Id, 'response');
      await recordEvent(db, job.id, 'created', { call, id: res.body.Id });
      return res.body.Id;
    }

    switch (res.kind) {
      case 'unknown_outcome':
        throw new Transient(`${label} create: ${res.message}`);
      case 'throttled':
      case 'auth':
        throw new Transient(`${label} create: ${res.message}`, res.retryAfterMs);
      case 'duplicate_name':
      case 'duplicate_doc':
      case 'duplicate_request': {
        // QuickBooks says it already has this. Find it, or stop and ask.
        await settleAfter(new Date());
        const existing = await lookup();
        if (existing) {
          await confirmCall(db, job.id, call, key, existing.Id, 'lookup');
          await recordEvent(db, job.id, 'found_existing', { call, id: existing.Id, after: res.kind });
          return existing.Id;
        }
        throw new Permanent(`${label} create answered ${res.kind}, but no matching record could be found`);
      }
      default:
        throw new Permanent(`${label} create refused: ${res.code ?? res.status} ${res.message}`);
    }
  }

  try {
    if (!job.qb_invoice_id) {
      const current = await step('hubspot.get_deal', () => readDealPayload(hubspot, job.deal_id, settings.itemName, settings.wonStage).catch((error) => { throw hubspotFailure(error); }));
      if (!current.won) {
        await backToApproval(db, job, 'The deal is no longer closed won.');
        return 'back_to_approval';
      }
      if (!current.result.ok) {
        await sendToPerson(db, job, `deal: ${current.result.problem}`);
        return 'needs_person';
      }
      const digest = digestOf(current.result.payload);
      if (digest !== job.digest) {
        await backToApproval(db, job, 'The deal changed after it was approved, so it needs approving again.', { payload: current.result.payload, digest });
        return 'back_to_approval';
      }
    }

    const item = must(await step('qb.query_item', () => qb.findItemByName(payload.invoice.item_name)))[0];
    if (!item && !job.qb_invoice_id) throw new Permanent(`QuickBooks has no item named ${payload.invoice.item_name}`);

    let customerId = job.qb_customer_id;
    if (!customerId) {
      const { DisplayName } = payload.customer;
      customerId = await ensureRecord({
        call: 'qb.create_customer',
        key: customerRequestId(payload.contact_id),
        label: 'customer',
        lookup: async () => must(await step('qb.query_customer', () => qb.findCustomerByDisplayName(DisplayName)))[0] ?? null,
        create: () => qb.createCustomer({ ...payload.customer, Notes: 'Synthetic test data.' }, customerRequestId(payload.contact_id)),
      });
      await saveCustomerId(db, job, customerId);
    }

    const docNumber = payload.invoice.doc_number;
    let invoiceId = job.qb_invoice_id;
    if (!invoiceId) {
      const body = invoiceBody(payload, customerId, item.Id, payload.invoice.item_name);
      invoiceId = await ensureRecord({
        call: 'qb.create_invoice',
        key: invoiceRequestId(job.deal_id),
        label: 'invoice',
        lookup: async () => {
          const rows = must(await step('qb.query_invoice', () => qb.findInvoicesByDocNumber(docNumber)));
          if (rows.length > 1) throw new Permanent(`duplicate invoices found for ${docNumber}: ${rows.map((r) => r.Id).join(', ')}`);
          return rows[0] ?? null;
        },
        create: () => qb.createInvoice(body, invoiceRequestId(job.deal_id)),
      });
      await saveInvoiceId(db, job, invoiceId);
    }

    // Read it back and count. This is how a duplicate gets noticed instead of assumed away.
    const rows = must(await step('qb.verify_invoice', () => qb.findInvoicesByDocNumber(docNumber)));
    if (rows.length > 1) {
      await raiseJobAlert(db, 'duplicate_detected', job.id, `${rows.length} invoices carry ${docNumber}: ${rows.map((r) => r.Id).join(', ')}`);
      throw new Permanent(`duplicate invoices found for ${docNumber}`);
    }
    if (rows.length === 0) {
      must(await qb.getInvoice(invoiceId));
      await raiseJobAlert(db, 'doc_number_not_searchable', job.id, `Invoice ${invoiceId} exists but a search for ${docNumber} did not find it, so a retry could not have found it either.`);
    } else if (Math.abs(Number(rows[0].TotalAmt) - payload.invoice.amount) > 0.005) {
      throw new Permanent(`invoice ${rows[0].Id} total ${rows[0].TotalAmt} doesn't match the approved ${payload.invoice.amount}`);
    }

    if (!job.written_back_at) {
      await step('hubspot.patch_deal', () =>
        hubspot.writeDealLedgerFields(job.deal_id, { ltl_qb_invoice_id: invoiceId, ltl_qb_doc_number: docNumber }).catch((error) => { throw hubspotFailure(error); }),
      );
      await markWrittenBack(db, job);
    }

    await finishJob(db, job);
    return 'done';
  } catch (error) {
    if (error instanceof LostLease) return 'lost_lease';
    try {
      if (error instanceof ReconnectNeeded) {
        const open = await db.query("select 1 from alerts where kind = 'quickbooks_reconnect_needed' and acknowledged_at is null");
        if (open.rowCount === 0) await raiseJobAlert(db, 'quickbooks_reconnect_needed', job.id, error.message);
        await releaseForRetry(db, job, settings.reconnectDelayMs, 'waiting for QuickBooks reconnect', { countAttempt: false });
        return 'blocked';
      }
      if (error instanceof Permanent) {
        await sendToPerson(db, job, error.message);
        return 'needs_person';
      }
      if (error instanceof Transient || error instanceof TokenRefreshFailed) {
        if (job.attempts >= settings.maxAttempts) {
          await sendToPerson(db, job, `gave up after ${job.attempts} attempts: ${error.message}`);
          return 'needs_person';
        }
        const retryAfter = error instanceof Transient ? error.retryAfterMs : 0;
        await releaseForRetry(db, job, Math.max(retryAfter, settings.retryDelayMs * 2 ** Math.min(job.attempts - 1, 5)), error.message);
        return 'retry';
      }
      await sendToPerson(db, job, `unexpected: ${(error as Error).message}`);
      return 'needs_person';
    } catch (nested) {
      if (nested instanceof LostLease) return 'lost_lease';
      throw nested;
    }
  }
}
