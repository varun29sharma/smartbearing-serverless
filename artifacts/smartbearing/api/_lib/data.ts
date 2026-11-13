// Seed data for the serverless backend — the same fleet, users, alerts and
// operations records the original api-server's seed script (src/scripts/seed.ts)
// loads into MongoDB, recreated here in memory.
//
// Timestamps are relative to module initialisation (cold start), so the
// active alerts always land on "today" (alertsToday and the trends charts
// work on any day the demo runs) and the resolved alerts land a few days
// back (so the ROI card shows real prevented-cost figures).

import { hashPassword, type AuthUser } from './auth.js';
import {
  buildEvidence,
  getPreventionTips,
  signalStats,
  synthesizeSignal,
  type FaultLabel,
} from './dsp.js';
import { rngFor } from './util.js';
import { computeFFTBins as fftBins } from './fft.js';

export interface MachineDoc {
  id: string;
  _id: string;
  machineId: string;
  name: string;
  location: string;
  section: string;
  totalSpindles: number;
  status: 'healthy' | 'warning' | 'critical' | 'degrading';
  faultProfile: FaultLabel | null;
  factoryUnit: string;
  installedAt: string;
  lastMaintenance: string;
}

export interface AlertDoc {
  id: string;
  _id: string;
  machineId: string;
  spindleId: string;
  severity: 'critical' | 'warning';
  status: 'active' | 'acknowledged' | 'resolved';
  message: string;
  technicianSummary: string;
  prevention: string[];
  anomalyScore: number;
  evidence: Record<string, any>;
  detectedAt: string;
  acknowledgedAt?: string | null;
  resolvedAt?: string | null;
}

export interface MaintenanceDoc {
  id: string;
  _id: string;
  machineId: string;
  type: string;
  performedAt: string;
  technicianName: string;
  notes: string;
  bearingReplaced: boolean;
  cost: number;
}

export interface SeedData {
  users: AuthUser[];
  units: Record<string, any>[];
  machines: MachineDoc[];
  profile: Record<string, any>;
  alerts: AlertDoc[];
  maintenance: MaintenanceDoc[];
  orders: Record<string, any>[];
  runs: Record<string, any>[];
  materials: Record<string, any>[];
  quality: Record<string, any>[];
  workforce: Record<string, any>[];
  demand: Record<string, any>[];
  incidents: Record<string, any>[];
  impacts: Record<string, any>[];
  actions: Record<string, any>[];
  comments: Record<string, any>[];
  evidence: Record<string, any>[];
}

const ISO = (d: Date) => d.toISOString();
const hoursAgo = (now: number, h: number) => new Date(now - h * 3600_000);
const daysAgo = (now: number, d: number) => new Date(now - d * 86400_000);
const hoursFromNow = (now: number, h: number) => new Date(now + h * 3600_000);

function makeEvidence(
  label: FaultLabel,
  confidence: number,
  machineId: string,
  spindleId: string,
  rpm = 14200,
): Record<string, any> {
  const rng = rngFor('alert-evidence', machineId, spindleId);
  const signal = synthesizeSignal(label, label === 'Healthy' ? 'healthy' : 'warning', rpm, rng);
  const stats = signalStats(signal);
  const fft = fftBins(signal, 4000, 128);
  return buildEvidence(label, confidence, fft, rpm, stats.rms, stats.kurtosis, stats.peak);
}

function makeAlert(
  id: string,
  machineId: string,
  spindleId: string,
  severity: 'critical' | 'warning',
  label: FaultLabel,
  confidence: number,
  anomalyScore: number,
  detectedAt: Date,
  status: AlertDoc['status'],
  resolvedAt?: Date,
): AlertDoc {
  const message = `${label} detected with ${(confidence * 100).toFixed(1)}% confidence.`;
  return {
    id,
    _id: id,
    machineId,
    spindleId,
    severity,
    status,
    message,
    technicianSummary: `${label} fault on ${machineId}/${spindleId} — ${message} Vibration and temperature are elevated above baseline; inspect the bearing and schedule replacement.`,
    prevention: getPreventionTips(label),
    anomalyScore,
    evidence: makeEvidence(label, confidence, machineId, spindleId),
    detectedAt: ISO(detectedAt),
    acknowledgedAt: status === 'active' ? null : ISO(detectedAt),
    resolvedAt: resolvedAt ? ISO(resolvedAt) : null,
  };
}

export function createSeedData(now = new Date()): SeedData {
  const t = now.getTime();

  const users: AuthUser[] = [
    {
      id: 'user-admin', _id: 'user-admin', name: 'Admin User', email: 'admin@smartbearing.com',
      role: 'admin', factoryUnits: ['unit-a', 'unit-b'],
      alertEmail: '', alertWhatsapp: '', passwordSha: hashPassword('Admin@123'),
    },
    {
      id: 'user-maintenance', _id: 'user-maintenance', name: 'Maintenance Engineer', email: 'maintenance@smartbearing.com',
      role: 'maintenance_engineer', factoryUnits: ['unit-a', 'unit-b'],
      alertEmail: '', alertWhatsapp: '', passwordSha: hashPassword('Maintenance@123'),
    },
    {
      id: 'user-manager', _id: 'user-manager', name: 'Factory Manager', email: 'manager@smartbearing.com',
      role: 'factory_manager', factoryUnits: ['unit-a'],
      alertEmail: '', alertWhatsapp: '', passwordSha: hashPassword('Manager@123'),
    },
    {
      id: 'user-worker', _id: 'user-worker', name: 'Line Worker', email: 'worker@smartbearing.com',
      role: 'worker', factoryUnits: ['unit-a'],
      alertEmail: '', alertWhatsapp: '', passwordSha: hashPassword('Worker@123'),
    },
    {
      id: 'user-customer', _id: 'user-customer', name: 'Mangalya Narayana', email: 'customer@mangalyanarayana.com',
      role: 'customer', factoryUnits: ['unit-a'], customerName: 'Mangalya Narayana',
      alertEmail: '', alertWhatsapp: '', passwordSha: hashPassword('Customer@123'),
    },
    {
      id: 'user-operator', _id: 'user-operator', name: 'Operator User', email: 'operator@smartbearing.com',
      role: 'operator', factoryUnits: ['unit-a'],
      alertEmail: '', alertWhatsapp: '', passwordSha: hashPassword('Operator@123'),
    },
  ];

  const units = [
    { unitId: 'unit-a', _id: 'unit-a', name: 'Factory Unit A', location: 'Sircilla, Telangana', description: 'Main spinning unit — ring frames and winding.', machineIds: ['M001', 'M002', 'M003', 'M004', 'M005'], isActive: true, createdAt: ISO(daysAgo(t, 400)) },
    { unitId: 'unit-b', _id: 'unit-b', name: 'Factory Unit B', location: 'Warangal, Telangana', description: 'Second spinning unit.', machineIds: ['M006'], isActive: true, createdAt: ISO(daysAgo(t, 400)) },
  ];

  const machines: MachineDoc[] = [
    { id: 'machine-M001', _id: 'machine-M001', machineId: 'M001', name: 'Ring Frame #1', location: 'Sircilla, Telangana', section: 'Main', totalSpindles: 400, status: 'healthy', faultProfile: null, factoryUnit: 'unit-a', installedAt: '2023-03-15', lastMaintenance: ISO(daysAgo(t, 21)) },
    { id: 'machine-M002', _id: 'machine-M002', machineId: 'M002', name: 'Ring Frame #2', location: 'Sircilla, Telangana', section: 'Main', totalSpindles: 400, status: 'warning', faultProfile: 'Imbalance', factoryUnit: 'unit-a', installedAt: '2023-03-15', lastMaintenance: ISO(daysAgo(t, 35)) },
    { id: 'machine-M003', _id: 'machine-M003', machineId: 'M003', name: 'Ring Frame #3', location: 'Sircilla, Telangana', section: 'Main', totalSpindles: 320, status: 'critical', faultProfile: 'Outer Race', factoryUnit: 'unit-a', installedAt: '2022-11-02', lastMaintenance: ISO(daysAgo(t, 48)) },
    { id: 'machine-M004', _id: 'machine-M004', machineId: 'M004', name: 'Ring Frame #4', location: 'Sircilla, Telangana', section: 'Main', totalSpindles: 400, status: 'healthy', faultProfile: null, factoryUnit: 'unit-a', installedAt: '2023-06-20', lastMaintenance: ISO(daysAgo(t, 12)) },
    { id: 'machine-M005', _id: 'machine-M005', machineId: 'M005', name: 'Winding Machine #1', location: 'Sircilla, Telangana', section: 'Winding', totalSpindles: 120, status: 'warning', faultProfile: 'Ball', factoryUnit: 'unit-a', installedAt: '2023-01-10', lastMaintenance: ISO(daysAgo(t, 28)) },
    { id: 'machine-M006', _id: 'machine-M006', machineId: 'M006', name: 'Ring Frame #5', location: 'Warangal, Telangana', section: 'Main', totalSpindles: 400, status: 'warning', faultProfile: 'Misalignment', factoryUnit: 'unit-b', installedAt: '2023-08-05', lastMaintenance: ISO(daysAgo(t, 30)) },
  ];

  const profile = {
    id: 'factory-profile',
    unitName: 'Factory Unit A',
    location: 'Sircilla, Telangana',
    shiftTimings: '24x7 (3 Shifts)',
    description: 'Textile MSME running ring frames and winding machines across two units in Telangana.',
    updatedAt: ISO(now),
  };

  // 4 active alerts, detected today (staggered) — one for each warning /
  // critical machine, which is what the live simulator produces within its
  // first tick (the original seed lists 3, but M005 is warning too, so the
  // running system alerts on it as well).
  // 4 resolved alerts (2 critical + 2 warning) from the last few days — these
  // drive the ROI card: 2 x Rs 18,000 + 2 x Rs 9,000 = Rs 54,000 saved,
  // 36 h downtime prevented, 4 breakdowns prevented.
  const alerts: AlertDoc[] = [
    makeAlert('seed-alert-m003', 'M003', 'SN001', 'critical', 'Outer Race', 0.9, 0.8, hoursAgo(t, 2), 'active'),
    makeAlert('seed-alert-m002', 'M002', 'SN002', 'warning', 'Imbalance', 0.85, 0.4, hoursAgo(t, 5), 'active'),
    makeAlert('seed-alert-m005', 'M005', 'SN002', 'warning', 'Ball', 0.84, 0.38, hoursAgo(t, 6), 'active'),
    makeAlert('seed-alert-m006', 'M006', 'SN003', 'warning', 'Misalignment', 0.82, 0.42, hoursAgo(t, 8), 'active'),
    makeAlert('seed-alert-res-1', 'M003', 'SN004', 'critical', 'Outer Race', 0.88, 0.76, daysAgo(t, 2), 'resolved', daysAgo(t, 1)),
    makeAlert('seed-alert-res-2', 'M002', 'SN001', 'critical', 'Inner Race', 0.91, 0.81, daysAgo(t, 3), 'resolved', daysAgo(t, 2)),
    makeAlert('seed-alert-res-3', 'M005', 'SN002', 'warning', 'Ball', 0.84, 0.38, daysAgo(t, 3), 'resolved', daysAgo(t, 2)),
    makeAlert('seed-alert-res-4', 'M006', 'SN005', 'warning', 'Misalignment', 0.8, 0.35, daysAgo(t, 4), 'resolved', daysAgo(t, 3)),
  ];

  const maintenance: MaintenanceDoc[] = [
    { id: 'maint-1', _id: 'maint-1', machineId: 'M001', type: 'Routine', performedAt: ISO(daysAgo(t, 7)), technicianName: 'John Doe', notes: 'All clear', bearingReplaced: false, cost: 50 },
    { id: 'maint-2', _id: 'maint-2', machineId: 'M002', type: 'Inspection', performedAt: ISO(daysAgo(t, 5)), technicianName: 'Jane Smith', notes: 'Vibration elevated on SN002; monitor closely.', bearingReplaced: false, cost: 100 },
    { id: 'maint-3', _id: 'maint-3', machineId: 'M003', type: 'Emergency', performedAt: ISO(daysAgo(t, 1)), technicianName: 'John Doe', notes: 'Bearing replaced on spindle SN004 after outer race fault.', bearingReplaced: true, cost: 450 },
    { id: 'maint-4', _id: 'maint-4', machineId: 'M004', type: 'Routine', performedAt: ISO(daysAgo(t, 12)), technicianName: 'Jane Smith', notes: 'Scheduled lubrication and baseline check.', bearingReplaced: false, cost: 40 },
    { id: 'maint-5', _id: 'maint-5', machineId: 'M006', type: 'Inspection', performedAt: ISO(daysAgo(t, 3)), technicianName: 'John Doe', notes: 'Coupling misalignment noted on SN005.', bearingReplaced: false, cost: 120 },
  ];

  const orders = [
    { id: 'order-1', orderId: 'ORD-MN-2401', customerName: 'Mangalya Narayana', product: 'Premium cotton yarn 40s', quantity: 1200, unitPrice: 520, totalValue: 624000, status: 'at_risk', priority: 'high', dueDate: ISO(daysAgo(t, -6)), factoryUnit: 'unit-a', progress: 52 },
    { id: 'order-2', orderId: 'ORD-MN-2402', customerName: 'Mangalya Narayana', product: 'Core cotton yarn 30s', quantity: 1800, unitPrice: 390, totalValue: 702000, status: 'in_progress', priority: 'medium', dueDate: ISO(daysAgo(t, -12)), factoryUnit: 'unit-a', progress: 38 },
    { id: 'order-3', orderId: 'ORD-AR-2403', customerName: 'Aruna Apparel Co.', product: 'Ring-spun 24s', quantity: 900, unitPrice: 310, totalValue: 279000, status: 'in_progress', priority: 'medium', dueDate: ISO(daysAgo(t, -18)), factoryUnit: 'unit-b', progress: 24 },
  ];

  const runs = [
    { id: 'run-1', runId: 'RUN-A-M003', orderId: 'ORD-MN-2401', machineId: 'M003', product: 'Premium cotton yarn 40s', plannedQty: 1200, producedQty: 620, goodQty: 610, downtimeHours: 4.2, status: 'at_risk', availability: 0.72, qualityRate: 0.98, startTime: ISO(hoursAgo(t, 26)), factoryUnit: 'unit-a' },
    { id: 'run-2', runId: 'RUN-A-M002', orderId: 'ORD-MN-2401', machineId: 'M002', product: 'Premium cotton yarn 40s', plannedQty: 1200, producedQty: 1080, goodQty: 1040, downtimeHours: 1.1, status: 'running', availability: 0.88, qualityRate: 0.96, startTime: ISO(hoursAgo(t, 26)), factoryUnit: 'unit-a' },
    { id: 'run-3', runId: 'RUN-B-M006', orderId: 'ORD-AR-2403', machineId: 'M006', product: 'Ring-spun 24s', plannedQty: 900, producedQty: 720, goodQty: 700, downtimeHours: 0.8, status: 'running', availability: 0.9, qualityRate: 0.97, startTime: ISO(hoursAgo(t, 20)), factoryUnit: 'unit-b' },
  ];

  const materials = [
    { id: 'mat-1', sku: 'BRG-6205', name: 'Bearing 6205 kit', onHand: 2, required: 3, stock: 2, reorderLevel: 3, unit: 'pcs', factoryUnit: 'unit-a', status: 'shortage' },
    { id: 'mat-2', sku: 'COT-BALE-1', name: 'Cotton bale', onHand: 120, required: 100, stock: 120, reorderLevel: 50, unit: 'bales', factoryUnit: 'unit-a', status: 'reserved' },
    { id: 'mat-3', sku: 'BRG-6205', name: 'Bearing 6205 kit', onHand: 14, required: 3, stock: 14, reorderLevel: 3, unit: 'pcs', factoryUnit: 'unit-b', status: 'available' },
  ];

  const quality = [
    { id: 'qc-1', checkId: 'QI-2408-01', machineId: 'M003', batch: 'B-2401-A', result: 'fail', disposition: 'on_hold', defectRate: 0.018, passRate: 0.982, defects: 11, inspectedAt: ISO(hoursAgo(t, 3)), factoryUnit: 'unit-a' },
    { id: 'qc-2', checkId: 'QI-2408-02', machineId: 'M002', batch: 'B-2401-B', result: 'watch', disposition: 'rework', defectRate: 0.009, passRate: 0.991, defects: 6, inspectedAt: ISO(hoursAgo(t, 3)), factoryUnit: 'unit-a' },
    { id: 'qc-3', checkId: 'QI-2408-03', machineId: 'M006', batch: 'B-2403-A', result: 'pass', disposition: 'released', defectRate: 0.004, passRate: 0.996, defects: 3, inspectedAt: ISO(hoursAgo(t, 5)), factoryUnit: 'unit-b' },
  ];

  const workforce = [
    { id: 'wf-1', name: 'Maintenance Engineer', role: 'Maintenance Engineer', shift: 'Day', factoryUnit: 'unit-a', status: 'on_duty' },
    { id: 'wf-2', name: 'Line Worker', role: 'Machine Operator', shift: 'Day', factoryUnit: 'unit-a', status: 'on_duty' },
    { id: 'wf-3', name: 'Operator User', role: 'Machine Operator', shift: 'Night', factoryUnit: 'unit-a', status: 'off_duty' },
  ];

  const demand = [
    { id: 'dem-1', product: 'Premium cotton yarn 40s', forecastQty: 9000, month: '2026-12', factoryUnit: 'unit-a' },
    { id: 'dem-2', product: 'Ring-spun 24s', forecastQty: 12000, month: '2026-12', factoryUnit: 'unit-b' },
  ];

  const incidents = [
    {
      id: 'inc-1001', _id: 'inc-1001', incidentNo: 'INC-1001', alertId: 'seed-alert-m003',
      title: 'Ring Frame #3 bearing failure — production halted',
      category: 'machine_downtime', severity: 'critical', status: 'action_required', stage: 'correct',
      machineId: 'M003', orderId: 'ORD-MN-2401', factoryUnit: 'unit-a',
      description: 'Outer race fault detected on M003/SN001 with 90% confidence. Machine stopped to prevent catastrophic bearing failure.',
      ownerUserId: 'user-maintenance', ownerName: 'Maintenance Engineer', ownerTeam: 'Maintenance',
      dueAt: ISO(hoursFromNow(t, 10)), responseSlaMinutes: 60, resolutionSlaMinutes: 480,
      firstResponseAt: ISO(hoursAgo(t, 1)), rootCause: '', recoveryVerified: false,
      escalationLevel: 0, impactScore: 87, createdBy: 'system', createdAt: ISO(hoursAgo(t, 2)),
    },
    {
      id: 'inc-1002', _id: 'inc-1002', incidentNo: 'INC-1002',
      title: 'Bearing 6205 stock below reorder level',
      category: 'material_delay', severity: 'high', status: 'investigating', stage: 'investigate',
      machineId: null, orderId: 'ORD-MN-2401', factoryUnit: 'unit-a',
      description: 'Only 2 units of BRG-6205 left in Unit A stores; reorder placed but supplier delivery is 4 days out.',
      ownerUserId: 'user-manager', ownerName: 'Factory Manager', ownerTeam: 'Procurement',
      dueAt: ISO(hoursFromNow(t, 48)), responseSlaMinutes: 240, resolutionSlaMinutes: 2880,
      firstResponseAt: ISO(hoursAgo(t, 24)), rootCause: '', recoveryVerified: false,
      escalationLevel: 0, impactScore: 72, createdBy: 'user-manager', createdAt: ISO(hoursAgo(t, 26)),
    },
    {
      id: 'inc-1003', _id: 'inc-1003', incidentNo: 'INC-1003',
      title: 'Yarn quality deviation on Ring Frame #2',
      category: 'quality_deviation', severity: 'medium', status: 'new', stage: 'detect',
      machineId: 'M002', orderId: 'ORD-MN-2401', factoryUnit: 'unit-a',
      description: 'Pass rate on batch B-2401-B dropped after the imbalance warning on M002.',
      ownerUserId: null, ownerName: null, ownerTeam: null,
      dueAt: ISO(hoursFromNow(t, 30)), responseSlaMinutes: 120, resolutionSlaMinutes: 1440,
      firstResponseAt: null, rootCause: '', recoveryVerified: false,
      escalationLevel: 0, impactScore: 64, createdBy: 'user-worker', createdAt: ISO(hoursAgo(t, 5)),
    },
  ];

  const impacts = [
    { id: 'impact-1', incidentId: 'inc-1001', incidentNo: 'INC-1001', productionValueAtRisk: 58000, estimatedLoss: 46465, deliveryRisk: 87, downtimeHours: 18, confidence: 0.85, calculationVersion: 'v1-live-inputs', affectedOrders: ['ORD-MN-2401'], createdAt: ISO(hoursAgo(t, 2)) },
    { id: 'impact-2', incidentId: 'inc-1002', incidentNo: 'INC-1002', productionValueAtRisk: 15000, estimatedLoss: 12000, deliveryRisk: 58, downtimeHours: 0, confidence: 0.7, calculationVersion: 'v1-live-inputs', affectedOrders: ['ORD-MN-2401', 'ORD-MN-2402'], createdAt: ISO(hoursAgo(t, 26)) },
  ];

  const actions = [
    { id: 'act-1', _id: 'act-1', incidentId: 'inc-1001', action: 'Isolate M003 and lock out the spindle drive.', status: 'done', createdBy: 'Maintenance Engineer', createdAt: ISO(hoursAgo(t, 2)) },
    { id: 'act-2', _id: 'act-2', incidentId: 'inc-1001', action: 'Source replacement bearing 6205 from Unit B stores.', status: 'in_progress', createdBy: 'Maintenance Engineer', createdAt: ISO(hoursAgo(t, 1)) },
  ];

  const comments = [
    { id: 'cmt-1', _id: 'cmt-1', incidentId: 'inc-1001', author: 'Maintenance Engineer', body: 'Bearing shows visible spalling on the outer race. Replacement is the only fix.', visibility: 'internal', createdAt: ISO(hoursAgo(t, 1)) },
    { id: 'cmt-2', _id: 'cmt-2', incidentId: 'inc-1001', author: 'Factory Manager', body: 'Customer informed about the 1-day slip on ORD-MN-2401.', visibility: 'customer', createdAt: ISO(hoursAgo(t, 1)) },
  ];

  const evidence = [
    { id: 'ev-1', _id: 'ev-1', incidentId: 'inc-1001', type: 'fft_snapshot', url: '', description: 'FFT snapshot showing BPFO peak at ~847 Hz on M003/SN001.', createdAt: ISO(hoursAgo(t, 2)) },
  ];

  return {
    users, units, machines, profile, alerts, maintenance,
    orders, runs, materials, quality, workforce, demand,
    incidents, impacts, actions, comments, evidence,
  };
}
