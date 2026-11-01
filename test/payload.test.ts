import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildPayload, contactIdOf, customerRequestId, digestOf, displayNameFor, docNumberFor, invoiceBody, invoiceRequestId } from '../src/worker/payload.ts';
import type { CrmContact, CrmDeal } from '../src/worker/payload.ts';

const deal = (over: Record<string, string | null> = {}): CrmDeal => ({
  id: '10002',
  properties: { dealname: 'Rooftop units', amount: '12500', closedate: '2026-10-30T14:00:00Z', dealstage: 'closedwon', ...over },
  associations: { contacts: { results: [{ id: '10001', type: 'deal_to_contact' }] } },
});
const contact = (over: Record<string, string | null> = {}): CrmContact => ({
  id: '10001',
  properties: { email: 'pat@cedar.example.com', firstname: 'Pat', lastname: 'Lee', company: 'Cedar Square', ...over },
});

describe('the invoice payload', () => {
  test('carries what QuickBooks needs and a stable, findable number', () => {
    const out = buildPayload(deal(), contact(), 'Services');
    assert.ok(out.ok);
    assert.equal(out.payload.invoice.doc_number, 'LTL-10002');
    assert.equal(out.payload.invoice.amount, 12500);
    assert.equal(out.payload.invoice.txn_date, '2026-10-30');
    assert.equal(out.payload.customer.DisplayName, 'Cedar Square [HS 10001]');
    assert.equal(out.payload.customer.PrimaryEmailAddr?.Address, 'pat@cedar.example.com');
  });

  test('a deal with no contact or no amount is a problem, not a guess', () => {
    assert.deepEqual(buildPayload(deal(), null, 'Services'), { ok: false, problem: 'deal has no contact' });
    assert.deepEqual(buildPayload(deal({ amount: null }), contact(), 'Services'), { ok: false, problem: 'deal has no amount' });
    assert.deepEqual(buildPayload(deal({ amount: '0' }), contact(), 'Services'), { ok: false, problem: 'deal has no amount' });
    assert.deepEqual(buildPayload(deal({ amount: 'lots' }), contact(), 'Services'), { ok: false, problem: 'deal has no amount' });
  });

  test('amounts round to cents', () => {
    const out = buildPayload(deal({ amount: '99.999' }), contact(), 'Services');
    assert.ok(out.ok && out.payload.invoice.amount === 100);
  });

  test('the display name is unique per contact, and free of what QuickBooks refuses', () => {
    assert.equal(displayNameFor(contact({ company: 'A: B\tC\nD' })), 'A B C D [HS 10001]');
    assert.equal(displayNameFor(contact({ company: null })), 'Pat Lee [HS 10001]');
    assert.equal(displayNameFor(contact({ company: null, firstname: null, lastname: null })), 'pat@cedar.example.com [HS 10001]');
    assert.equal(displayNameFor({ id: '7', properties: {} }), 'Customer [HS 7]');
    assert.notEqual(displayNameFor({ id: '7', properties: { company: 'Same' } }), displayNameFor({ id: '8', properties: { company: 'Same' } }));
  });

  test('the doc number and keys stay inside Intuit limits', () => {
    assert.ok(docNumberFor('1'.repeat(40)).length <= 21);
    assert.ok(customerRequestId('1'.repeat(60)).length <= 50);
    assert.ok(invoiceRequestId('1'.repeat(60)).length <= 50);
  });

  test('keys depend only on the record, so every retry carries the same one', () => {
    assert.equal(invoiceRequestId('10002'), invoiceRequestId('10002'));
    assert.notEqual(invoiceRequestId('10002'), invoiceRequestId('10003'));
    assert.notEqual(customerRequestId('10002'), invoiceRequestId('10002'));
  });

  test('the contact is the lowest associated ID, so the choice is stable', () => {
    const d = deal();
    d.associations = { contacts: { results: [{ id: '30', type: 'x' }, { id: '4', type: 'x' }] } };
    assert.equal(contactIdOf(d), '4');
    assert.equal(contactIdOf({ id: '1', properties: {} }), null);
  });

  test('the digest ignores key order and changes with content', () => {
    assert.equal(digestOf({ a: 1, b: { c: 2, d: 3 } }), digestOf({ b: { d: 3, c: 2 }, a: 1 }));
    const a = buildPayload(deal(), contact(), 'Services');
    const b = buildPayload(deal({ amount: '12501' }), contact(), 'Services');
    assert.ok(a.ok && b.ok);
    assert.notEqual(digestOf(a.payload), digestOf(b.payload));
    assert.equal(digestOf(a.payload), digestOf(structuredClone(a.payload)));
  });

  test('fields the invoice doesn\'t use can change without voiding an approval', () => {
    const a = buildPayload(deal(), contact(), 'Services');
    const b = buildPayload(deal({ dealstage: 'something', hs_lastmodifieddate: 'later', ltl_qb_invoice_id: '9' }), contact(), 'Services');
    assert.ok(a.ok && b.ok);
    assert.equal(digestOf(a.payload), digestOf(b.payload));
  });

  test('the invoice body has the documented shape', () => {
    const out = buildPayload(deal(), contact(), 'Services');
    assert.ok(out.ok);
    const body = invoiceBody(out.payload, '55', '1', 'Services') as { CustomerRef: { value: string }; DocNumber: string; TxnDate: string; Line: Array<{ Amount: number; SalesItemLineDetail: { ItemRef: { value: string } } }> };
    assert.equal(body.CustomerRef.value, '55');
    assert.equal(body.DocNumber, 'LTL-10002');
    assert.equal(body.TxnDate, '2026-10-30');
    assert.equal(body.Line[0].Amount, 12500);
    assert.equal(body.Line[0].SalesItemLineDetail.ItemRef.value, '1');
  });
});
