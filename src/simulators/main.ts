// Starts both simulators. Bound to localhost by default; the Docker image sets
// SIM_BIND_HOST=0.0.0.0 and docker-compose.yml publishes the ports on 127.0.0.1 only.

import { createSimServer } from './harness.ts';
import { createHubSpotSim } from './hubspot.ts';
import { createQuickBooksSim } from './quickbooks.ts';

const host = process.env.SIM_BIND_HOST ?? '127.0.0.1';
const hubspotPort = Number(process.env.SIM_HUBSPOT_PORT ?? 4010);
const quickbooksPort = Number(process.env.SIM_QUICKBOOKS_PORT ?? 4020);

const hubspot = createSimServer(createHubSpotSim());
const quickbooks = createSimServer(createQuickBooksSim());

await hubspot.listen(hubspotPort, host);
await quickbooks.listen(quickbooksPort, host);

console.log(`hubspot simulator on ${host}:${hubspotPort}`);
console.log(`quickbooks simulator on ${host}:${quickbooksPort}`);

async function stop(): Promise<void> {
  await Promise.all([hubspot.close(), quickbooks.close()]);
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
