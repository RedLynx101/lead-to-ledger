// Finds won deals by polling, so nothing here needs a public URL. Search lags writes, so
// the cursor overlaps by a margin. A deal seen twice is harmless: there's one job per deal.

import type { Db } from '../db.ts';
import type { HubSpotClient } from '../hubspot/client.ts';
import { advanceCursor, readCursor, upsertJobFromDeal } from './jobs.ts';
import { buildPayload, CONTACT_PROPERTIES_READ, contactIdOf, DEAL_PROPERTIES_READ } from './payload.ts';

const CURSOR = 'won_deals';
const MAX_PAGES = 20;

export async function pollWonDeals(
  deps: { db: Db; hubspot: HubSpotClient },
  options: { wonStage: string; itemName: string; overlapMs?: number },
): Promise<{ seen: number; created: number; updated: number; flagged: number }> {
  const { db, hubspot } = deps;
  const overlapMs = options.overlapMs ?? 10 * 60_000;
  const since = Math.max(0, (await readCursor(db, CURSOR)) - overlapMs);
  const tally = { seen: 0, created: 0, updated: 0, flagged: 0 };
  let newest = 0;
  let after: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { results, next } = await hubspot.searchDealsInStage(options.wonStage, since, ['hs_lastmodifieddate'], after);
    for (const hit of results) {
      tally.seen += 1;
      const deal = await hubspot.getDeal(hit.id, DEAL_PROPERTIES_READ);
      if (!deal) continue;
      const contactId = contactIdOf(deal);
      const contact = contactId ? await hubspot.getContact(contactId, CONTACT_PROPERTIES_READ) : null;
      const outcome = await upsertJobFromDeal(db, deal.id, buildPayload(deal, contact, options.itemName));
      if (outcome === 'created') tally.created += 1;
      if (outcome === 'updated') tally.updated += 1;
      if (outcome === 'flagged') tally.flagged += 1;
      const modified = Date.parse(deal.properties.hs_lastmodifieddate ?? '');
      if (!Number.isNaN(modified)) newest = Math.max(newest, modified);
    }
    if (!next) break;
    after = next;
  }
  if (newest > 0) await advanceCursor(db, CURSOR, newest);
  return tally;
}
