// Looks for duplicate invoices after the fact. It catches the one case the worker can't
// see at write time: a first attempt that committed after the worker looked. It finds and
// reports them. It never deletes or voids anything, because that's a person's decision.

import type { Db } from '../db.ts';
import type { QuickBooksClient } from '../quickbooks/client.ts';
import { raiseJobAlert, recordEvent } from './jobs.ts';

export interface DuplicateReport {
  docNumber: string;
  invoiceIds: string[];
}

export async function findDuplicates(db: Db, qb: QuickBooksClient, prefix = 'LTL-'): Promise<DuplicateReport[]> {
  const res = await qb.findInvoicesByDocPrefix(prefix);
  if (!res.ok) throw new Error(`reconcile query failed: ${res.kind}`);
  const byNumber = new Map<string, string[]>();
  for (const invoice of res.body) {
    if (!invoice.DocNumber) continue;
    byNumber.set(invoice.DocNumber, [...(byNumber.get(invoice.DocNumber) ?? []), invoice.Id]);
  }
  const duplicates: DuplicateReport[] = [];
  for (const [docNumber, invoiceIds] of byNumber) {
    if (invoiceIds.length < 2) continue;
    duplicates.push({ docNumber, invoiceIds });
    const dealId = docNumber.slice(prefix.length);
    const job = await db.query<{ id: string; status: string }>('select id, status from invoice_jobs where deal_id = $1', [dealId]);
    const jobId = job.rows[0]?.id ?? null;
    if (!jobId) continue;
    const seen = await db.query("select 1 from job_events where job_id = $1 and event = 'duplicate_found_by_reconcile'", [jobId]);
    if (seen.rowCount === 0) {
      await recordEvent(db, jobId, 'duplicate_found_by_reconcile', { docNumber, invoiceIds });
      await raiseJobAlert(db, 'duplicate_detected', jobId, `${invoiceIds.length} invoices carry ${docNumber}: ${invoiceIds.join(', ')}. A person should void the extra.`);
      await db.query("update invoice_jobs set status = 'needs_person', problem = $2, updated_at = now() where id = $1 and status = 'done'", [jobId, `duplicate invoices: ${invoiceIds.join(', ')}`]);
    }
  }
  return duplicates;
}
