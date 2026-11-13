// In-memory store for the serverless backend.
//
// Vercel functions are stateless across cold starts, so this store is
// deliberately split into two layers:
//   1. Deterministic state — derived from the seed + the current time by the
//      simulation engine (sim.ts). Identical on every instance, so reads
//      always agree even after a cold start.
//   2. Ephemeral writes — alert ack/resolve, fault injection, captures,
//      incidents, manual readings. These live in this module singleton and
//      survive while the instance is warm (the dashboard polls every few
//      seconds, which keeps one instance warm through a demo).
//
// Demo writes also travel in request headers (x-sb-faults, x-sb-alerts),
// set by the frontend from localStorage, so a fault injection or an
// ack/resolve still shows up on a cold instance for the browser that made
// the change. The headers are the source of truth for that browser; the
// in-memory overrides cover every other reader of the same warm instance.

import { createSeedData, type AlertDoc, type MachineDoc, type SeedData } from './data.js';
import type { FaultLabel } from './dsp.js';
import type { TokenPayload } from './auth.js';

export interface Store {
  seed: SeedData;
  /** Phone/edge captures (POST /api/sensor-readings, POST /api/sensors/reading). */
  captures: Record<string, any>[];
  /** Manual/arduino rig readings persisted as M001/RIG01 readings. */
  rigReadings: Record<string, any>[];
  /** Per-machine calibration offsets (POST /api/sensor-readings/calibrate). */
  calibrations: Record<string, Record<string, any>>;
  /** machineId -> fault label injected via POST /api/simulator/inject-fault. */
  faultOverrides: Record<string, string>;
  /** alertId -> status set via ack/resolve on this instance. */
  alertStatusOverrides: Record<string, string>;
  /** Manual/arduino hardware frames appended to the ring buffer. */
  hardwareFrames: Record<string, any>[];
  hardwareSimRunning: boolean;
  hardwareIngestCount: number;
  lastIngestAt: string | null;
  /** Sensor simulator on/off (POST /api/simulator/start|stop). */
  simRunning: boolean;
  /** When stopped, live readings freeze at this tick bucket. */
  frozenBucket: number | null;
  /** Incident escalations created at runtime (seed has none). */
  escalations: Record<string, any>[];
}

let store: Store | null = null;

export function getStore(): Store {
  if (!store) {
    store = {
      seed: createSeedData(),
      captures: [],
      rigReadings: [],
      calibrations: {},
      faultOverrides: {},
      alertStatusOverrides: {},
      hardwareFrames: [],
      hardwareSimRunning: true,
      hardwareIngestCount: 0,
      lastIngestAt: null,
      simRunning: true,
      frozenBucket: null,
      escalations: [],
    };
  }
  return store;
}

/** Per-request context: who is calling, what overrides their browser carries. */
export interface RequestContext {
  user: TokenPayload | null;
  /** machineId -> fault label ('Healthy' clears), from x-sb-faults. */
  faultHeaders: Record<string, string>;
  /** alertId -> status, from x-sb-alerts. */
  alertHeaders: Record<string, string>;
  now: Date;
}

export function parseOverrides(header: string | string[] | undefined): Record<string, string> {
  if (!header || typeof header !== 'string') return {};
  try {
    const parsed = JSON.parse(header);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, string>;
  } catch {
    // Ignore malformed override headers.
  }
  return {};
}

/** Machine with fault injection applied (header wins, then in-memory, then seed). */
export function effectiveMachine(store: Store, machine: MachineDoc, ctx: RequestContext): MachineDoc {
  const headerFault = ctx.faultHeaders[machine.machineId];
  const memoryFault = store.faultOverrides[machine.machineId];
  const fault = headerFault ?? memoryFault;
  if (fault === undefined) return machine;
  if (fault === 'Healthy') {
    return { ...machine, status: 'healthy', faultProfile: null };
  }
  return { ...machine, status: 'critical', faultProfile: fault as FaultLabel };
}

/** Alert with its effective status (header wins, then in-memory, then stored). */
export function effectiveAlert(store: Store, alert: AlertDoc, ctx: RequestContext): AlertDoc {
  const status = ctx.alertHeaders[alert.id] ?? store.alertStatusOverrides[alert.id] ?? alert.status;
  if (status === alert.status) return alert;
  return { ...alert, status: status as AlertDoc['status'] };
}

export function findMachine(store: Store, machineId: string): MachineDoc | undefined {
  return store.seed.machines.find((m) => m.machineId === machineId);
}

export function findUserByEmail(store: Store, email: string) {
  return store.seed.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
}

export function findUserById(store: Store, id: string) {
  return store.seed.users.find((u) => u.id === id);
}
