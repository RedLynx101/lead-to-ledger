import { createSimServer } from '../src/simulators/harness.ts';
import type { FaultSpec, SimServer, Vendor } from '../src/simulators/harness.ts';

export async function startSim(vendor: Vendor): Promise<SimServer> {
  const sim = createSimServer(vendor);
  await sim.listen(0);
  return sim;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function addFault(sim: SimServer, spec: FaultSpec): Promise<string> {
  const res = await fetch(`${sim.url()}/__sim/faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  });
  return ((await res.json()) as { id: string }).id;
}

export async function simLog(sim: SimServer): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${sim.url()}/__sim/log`);
  return ((await res.json()) as { entries: Array<Record<string, unknown>> }).entries;
}

export async function simState<T = Record<string, unknown>>(sim: SimServer): Promise<T> {
  const res = await fetch(`${sim.url()}/__sim/state`);
  return (await res.json()) as T;
}
