// Turns a won deal and its contact into exactly what will be sent to QuickBooks, and a
// hash of that. The approval is tied to the hash, so anything that changes what would be
// sent also voids the approval.

import { createHash } from 'node:crypto';

export interface CrmDeal {
  id: string;
  properties: Record<string, string | null | undefined>;
  associations?: Record<string, { results: Array<{ id: string; type: string }> }>;
}

export interface CrmContact {
  id: string;
  properties: Record<string, string | null | undefined>;
}

export interface InvoicePayload {
  deal_id: string;
  contact_id: string;
  customer: {
    DisplayName: string;
    CompanyName?: string;
    GivenName?: string;
    FamilyName?: string;
    PrimaryEmailAddr?: { Address: string };
  };
  invoice: {
    doc_number: string;
    amount: number;
    description: string;
    txn_date?: string;
    item_name: string;
  };
}

export const DEAL_PROPERTIES_READ = ['dealname', 'amount', 'closedate', 'dealstage', 'pipeline', 'hs_lastmodifieddate'];
export const CONTACT_PROPERTIES_READ = ['email', 'firstname', 'lastname', 'company'];

/** A stable, findable number. QuickBooks allows 21 characters. */
export function docNumberFor(dealId: string): string {
  return `LTL-${dealId}`.slice(0, 21);
}

/** QuickBooks refuses a colon, tab or newline in a name. */
function cleanName(value: string): string {
  return value.replace(/[:\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The contact ID goes in the name because QuickBooks requires names to be unique, and two
 * contacts can share a company. It also makes the customer findable after a lost response.
 */
export function displayNameFor(contact: CrmContact): string {
  const p = contact.properties;
  const person = cleanName(`${p.firstname ?? ''} ${p.lastname ?? ''}`);
  const base = cleanName(p.company ?? '') || person || cleanName(p.email ?? '') || 'Customer';
  return `${base.slice(0, 200)} [HS ${contact.id}]`;
}

export function contactIdOf(deal: CrmDeal): string | null {
  const ids = (deal.associations?.contacts?.results ?? []).map((r) => r.id);
  if (ids.length === 0) return null;
  return [...ids].sort((a, b) => Number(a) - Number(b))[0];
}

export type PayloadResult = { ok: true; payload: InvoicePayload } | { ok: false; problem: string };

export function buildPayload(deal: CrmDeal, contact: CrmContact | null, itemName: string): PayloadResult {
  if (!contact) return { ok: false, problem: 'deal has no contact' };
  const amount = Number(deal.properties.amount);
  if (!deal.properties.amount || Number.isNaN(amount) || amount <= 0) return { ok: false, problem: 'deal has no amount' };

  const p = contact.properties;
  const customer: InvoicePayload['customer'] = { DisplayName: displayNameFor(contact) };
  if (p.company) customer.CompanyName = cleanName(p.company).slice(0, 100);
  if (p.firstname) customer.GivenName = cleanName(p.firstname).slice(0, 100);
  if (p.lastname) customer.FamilyName = cleanName(p.lastname).slice(0, 100);
  if (p.email) customer.PrimaryEmailAddr = { Address: p.email };

  const invoice: InvoicePayload['invoice'] = {
    doc_number: docNumberFor(deal.id),
    amount: Math.round(amount * 100) / 100,
    description: cleanName(deal.properties.dealname ?? `Deal ${deal.id}`).slice(0, 200),
    item_name: itemName,
  };
  if (deal.properties.closedate) invoice.txn_date = deal.properties.closedate.slice(0, 10);

  return { ok: true, payload: { deal_id: deal.id, contact_id: contact.id, customer, invoice } };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

export function digestOf(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}

/** One key per record. A retry must carry the same one, so nothing here varies by attempt. */
export const customerRequestId = (contactId: string) => `ltl-customer-${contactId}`.slice(0, 50);
export const invoiceRequestId = (dealId: string) => `ltl-invoice-${dealId}`.slice(0, 50);

export function invoiceBody(payload: InvoicePayload, customerId: string, itemId: string, itemName: string): Record<string, unknown> {
  const { invoice } = payload;
  return {
    CustomerRef: { value: customerId },
    DocNumber: invoice.doc_number,
    ...(invoice.txn_date ? { TxnDate: invoice.txn_date } : {}),
    PrivateNote: `From CRM deal ${payload.deal_id}. Synthetic test data.`,
    Line: [
      {
        DetailType: 'SalesItemLineDetail',
        Amount: invoice.amount,
        Description: invoice.description,
        SalesItemLineDetail: { ItemRef: { value: itemId, name: itemName } },
      },
    ],
  };
}
