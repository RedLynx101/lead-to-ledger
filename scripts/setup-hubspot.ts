// Creates the ai_ property group and properties. Safe to run again: existing ones are
// left alone. Uses HUBSPOT_BASE_URL and HUBSPOT_TOKEN, which default to the simulator.

import { hubspotSettings } from '../src/config.ts';
import { HubSpotClient } from '../src/hubspot/client.ts';
import { ensureProperties } from '../src/hubspot/properties.ts';

const results = await ensureProperties(new HubSpotClient(hubspotSettings()));
console.log(JSON.stringify(results, null, 1));
