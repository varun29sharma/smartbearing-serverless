// Shared alert + incident creation — used by the simulator (fault
// injection), phone captures, edge ingest and manual/arduino hardware
// frames. The dedup policy mirrors the original SensorSimulator:
// same machine + spindle + severity already active -> skip; a different
// severity active -> resolve the old one, create the new one.

import { getPreventionTips, type FaultLabel } from './dsp.js';
import { findMachine, type Store } from './store.js';
import { uid } from './util.js';
import type { AlertDoc } from './data.js';

export interface NewAlertInput {
  machineId: string;
  spindleId: string;
  severity: 'critical' | 'warning';
  label: FaultLabel;
  confidence: number;
  anomalyScore: number;
  evidence: Record<string, any>;
  message?: string;
  technicianSummary?: string;
}

/** Create an alert (or return the existing active one). */
export function createAlert(
  store: Store,
  input: NewAlertInput,
  now: Date,
): { alert: AlertDoc; created: boolean } {
  const existing = store.seed.alerts.find(
    (a) =>
      a.machineId === input.machineId &&
      a.spindleId === input.spindleId &&
      (a.status === 'active' || a.status === 'acknowledged'),
  );
  if (existing) {
    if (existing.severity === input.severity) return { alert: existing, created: false };
    // Severity changed: resolve the old alert, create the new one.
    existing.status = 'resolved';
    existing.resolvedAt = now.toISOString();
    store.alertStatusOverrides[existing.id] = 'resolved';
  }
  const id = uid('alert');
  const alert: AlertDoc = {
    id,
    _id: id,
    machineId: input.machineId,
    spindleId: input.spindleId,
    severity: input.severity,
    status: 'active',
    message: input.message ?? `${input.label} detected with ${(input.confidence * 100).toFixed(1)}% confidence.`,
    technicianSummary:
      input.technicianSummary ??
      `${input.label} fault on ${input.machineId}/${input.spindleId} — vibration and temperature are elevated above baseline; inspect the bearing and schedule replacement.`,
    prevention: getPreventionTips(input.label),
    anomalyScore: input.anomalyScore,
    evidence: input.evidence,
    detectedAt: now.toISOString(),
  };
  store.seed.alerts.unshift(alert);
  return { alert, created: true };
}

/** Auto-create an operations incident for a pipeline alert (the original's
 *  ensureIncidentForAlert). Skipped when an active incident already links
 *  to the alert. */
export function ensureIncidentForAlert(store: Store, alert: AlertDoc, now: Date): Record<string, any> | null {
  const existing = store.seed.incidents.find(
    (i) => i.alertId === alert.id && i.status !== 'resolved' && i.status !== 'closed',
  );
  if (existing) return null;
  const machine = findMachine(store, alert.machineId);
  const n = 1000 + store.seed.incidents.length + 1;
  const id = uid('inc');
  const incident = {
    id,
    _id: id,
    incidentNo: `INC-${n}`,
    alertId: alert.id,
    title: `Alert on ${alert.machineId}: ${alert.message}`,
    category: 'machine_downtime',
    severity: alert.severity === 'critical' ? 'critical' : 'high',
    status: 'new',
    stage: 'detect',
    machineId: alert.machineId,
    orderId: null,
    factoryUnit: machine?.factoryUnit ?? 'unit-a',
    description: alert.technicianSummary,
    ownerUserId: null,
    ownerName: null,
    ownerTeam: null,
    dueAt: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    responseSlaMinutes: 60,
    resolutionSlaMinutes: 480,
    firstResponseAt: null,
    rootCause: '',
    recoveryVerified: false,
    escalationLevel: 0,
    impactScore: alert.severity === 'critical' ? 87 : 64,
    createdBy: 'system',
    createdAt: now.toISOString(),
  };
  store.seed.incidents.unshift(incident);
  return incident;
}
