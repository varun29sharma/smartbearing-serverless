// Core route handlers: auth, health, machines, alerts, analytics,
// maintenance, ML. Shapes follow API-CONTRACT.md exactly.

import { buildEvidence, getPreventionTips, type FaultLabel } from './dsp.js';
import {
  checkPassword,
  hashPassword,
  isGlobalRole,
  publicUser,
  signToken,
  canSeeUnit,
  type Role,
} from './auth.js';
import { fail, ok, okCsv, requireRoles, type HandlerCtx } from './http.js';
import {
  effectiveAlert,
  effectiveMachine,
  findMachine,
  findUserByEmail,
  findUserById,
} from './store.js';
import {
  fleetSummary,
  historySeries,
  liveReading,
  liveSpindles,
  machineHealth,
  rulSeries,
  tickBucket,
  visibleMachines,
  SPINDLES_PER_MACHINE,
} from './sim.js';
import { fmtTimestamp, round, seededRand, startOfDay, uid } from './util.js';
import type { AlertDoc, MachineDoc } from './data.js';
// @ts-ignore — JSON import; esbuild/Vercel and tsx both resolve it.
import mlAnalysis from './ml-analysis.json';

const ENG_ADMIN: Role[] = ['maintenance_engineer', 'admin'];
const ENG_ADMIN_MGR: Role[] = ['maintenance_engineer', 'admin', 'factory_manager'];

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function login(c: HandlerCtx): void {
  const { email, password } = c.body;
  if (!email || !password) {
    fail(c.res, 400, 'Email and password are required');
    return;
  }
  const user = findUserByEmail(c.store, String(email));
  if (!user || !checkPassword(String(password), user.passwordSha)) {
    fail(c.res, 401, 'Invalid credentials');
    return;
  }
  ok(c.res, { token: signToken(user), user: publicUser(user) });
}

export function register(c: HandlerCtx): void {
  const { name, email, password, alertEmail } = c.body;
  if (!name || !email || !password) {
    fail(c.res, 400, 'Name, email and password are required');
    return;
  }
  if (findUserByEmail(c.store, String(email))) {
    fail(c.res, 400, 'User already exists');
    return;
  }
  const id = uid('user');
  const user = {
    id,
    _id: id,
    name: String(name),
    email: String(email),
    role: 'worker' as Role,
    factoryUnits: [] as string[],
    alertEmail: alertEmail ? String(alertEmail) : '',
    alertWhatsapp: '',
    passwordSha: hashPassword(String(password)),
  };
  c.store.seed.users.push(user);
  ok(c.res, { token: signToken(user), user: publicUser(user) }, 201);
}

export function me(c: HandlerCtx): void {
  const user = c.user && findUserById(c.store, c.user.id);
  if (!user) {
    fail(c.res, 404, 'User not found');
    return;
  }
  ok(c.res, publicUser(user));
}

export function patchMe(c: HandlerCtx): void {
  const user = c.user && findUserById(c.store, c.user.id);
  if (!user) {
    fail(c.res, 404, 'User not found');
    return;
  }
  // Whitelisted fields only (same as the original).
  if (typeof c.body.alertEmail === 'string') user.alertEmail = c.body.alertEmail;
  if (typeof c.body.alertWhatsapp === 'string') user.alertWhatsapp = c.body.alertWhatsapp;
  ok(c.res, publicUser(user));
}

export function listUsers(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN)) return;
  ok(c.res, c.store.seed.users.map((u) => publicUser(u)));
}

export function patchUserRole(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN)) return;
  const user = findUserById(c.store, c.params.id);
  if (!user) {
    fail(c.res, 404, 'User not found');
    return;
  }
  const validRoles: Role[] = ['maintenance_engineer', 'admin', 'factory_manager', 'worker', 'customer', 'operator'];
  if (c.body.role && validRoles.includes(c.body.role)) user.role = c.body.role;
  if (Array.isArray(c.body.factoryUnits)) user.factoryUnits = c.body.factoryUnits.map(String);
  if (typeof c.body.customerName === 'string') user.customerName = c.body.customerName;
  ok(c.res, publicUser(user));
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export function healthz(c: HandlerCtx): void {
  // No envelope — matches the original exactly.
  c.res.statusCode = 200;
  c.res.setHeader('Content-Type', 'application/json');
  c.res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
}

export function healthMl(c: HandlerCtx): void {
  // Classification runs in-process via the DSP engine (the same fallback the
  // original used when its Python server was down), so it is always online.
  ok(c.res, { online: true, timestamp: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------

function machineView(c: HandlerCtx, machine: MachineDoc, bucket: number): Record<string, any> {
  const eff = effectiveMachine(c.store, machine, c.rctx);
  const health = machineHealth(c.store, c.rctx, machine, bucket);
  return {
    ...eff,
    id: machine.machineId,
    healthScore: health.healthScore,
    activeSensors: SPINDLES_PER_MACHINE,
    mlLabel: health.mlLabel,
    mlConfidence: health.mlConfidence,
    rpm: health.rpm,
  };
}

function scopedMachine(c: HandlerCtx, machineId: string): MachineDoc | null {
  const machine = findMachine(c.store, machineId);
  if (!machine) return null;
  if (c.user && !canSeeUnit(c.user, machine.factoryUnit)) return null;
  return machine;
}

export function listMachines(c: HandlerCtx): void {
  const bucket = tickBucket(c.store, c.rctx.now);
  let machines = visibleMachines(c.store, c.rctx);
  const unit = c.query.factoryUnit;
  if (unit) {
    if (c.user && !isGlobalRole(c.user.role) && !canSeeUnit(c.user, unit)) {
      fail(c.res, 403, 'Forbidden');
      return;
    }
    machines = machines.filter((m) => m.factoryUnit === unit);
  }
  ok(c.res, machines.map((m) => machineView(c, m, bucket)));
}

export function getMachine(c: HandlerCtx): void {
  const machine = scopedMachine(c, c.params.id);
  if (!machine) {
    fail(c.res, 404, 'Machine not found');
    return;
  }
  ok(c.res, machineView(c, machine, tickBucket(c.store, c.rctx.now)));
}

export function updateMachine(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN)) return;
  const machine = scopedMachine(c, c.params.id);
  if (!machine) {
    fail(c.res, 404, 'Machine not found');
    return;
  }
  const allowed = ['name', 'location', 'section', 'totalSpindles', 'status', 'faultProfile', 'factoryUnit', 'lastMaintenance'] as const;
  for (const key of allowed) {
    if (c.body[key] !== undefined) (machine as any)[key] = c.body[key];
  }
  ok(c.res, machineView(c, machine, tickBucket(c.store, c.rctx.now)));
}

export function getSpindles(c: HandlerCtx): void {
  const machine = scopedMachine(c, c.params.id);
  if (!machine) {
    fail(c.res, 404, 'Machine not found');
    return;
  }
  const bucket = tickBucket(c.store, c.rctx.now);
  const spindles = liveSpindles(c.store, c.rctx, machine, bucket).map((r) => ({
    id: `${machine.machineId}-${r.spindleId}`,
    spindleId: r.spindleId,
    nodeId: r.spindleId,
    machineId: r.machineId,
    location: r.location,
    healthScore: r.healthScore,
    anomalyScore: r.anomalyScore,
    accel_x: r.accel_x,
    accel_y: r.accel_y,
    accel_z: r.accel_z,
    rpm: r.rpm,
    temperature: r.temperature,
    voltage: r.voltage,
    acousticLevel: r.acousticLevel,
    // Extra fields beyond the original shape: the serverless frontend polls
    // this endpoint instead of the socket feed, and the Fault Injector's
    // verdict strip reads the ML label from here.
    mlLabel: r.mlLabel,
    mlConfidence: r.mlConfidence,
    status: r.anomalyFlag ? 'critical' : r.accel_z > 1.5 ? 'warning' : 'healthy',
    vibDelta: 0,
    tempDelta: 0,
  }));
  ok(c.res, spindles);
}

export function getHistory(c: HandlerCtx): void {
  const machine = scopedMachine(c, c.params.id);
  if (!machine) {
    fail(c.res, 404, 'Machine not found');
    return;
  }
  const hours = Math.min(168, Math.max(1, parseInt(c.query.hours ?? '24', 10) || 24));
  const points = historySeries(c.store, c.rctx, machine, hours, c.rctx.now);
  // Both keys hold the identical array (original behaviour).
  ok(c.res, { vibration: points, temperature: points });
}

export function getFft(c: HandlerCtx): void {
  const machine = scopedMachine(c, c.params.id);
  if (!machine) {
    fail(c.res, 404, 'Machine not found');
    return;
  }
  const r = liveReading(c.store, c.rctx, machine, SPINDLES_PER_MACHINE, tickBucket(c.store, c.rctx.now));
  ok(c.res, r.fft);
}

export function getWaveform(c: HandlerCtx): void {
  const machine = scopedMachine(c, c.params.id);
  if (!machine) {
    fail(c.res, 404, 'Machine not found');
    return;
  }
  const r = liveReading(c.store, c.rctx, machine, SPINDLES_PER_MACHINE, tickBucket(c.store, c.rctx.now));
  ok(c.res, r.waveform.map((value, t) => ({ t, value })));
}

export function getRul(c: HandlerCtx): void {
  const machine = scopedMachine(c, c.params.id);
  if (!machine) {
    fail(c.res, 404, 'Machine not found');
    return;
  }
  ok(c.res, rulSeries(c.store, c.rctx, machine, tickBucket(c.store, c.rctx.now)));
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export function formatAlert(alert: AlertDoc, machineName: string): Record<string, any> {
  return {
    id: alert.id,
    nodeId: alert.spindleId,
    machineId: alert.machineId,
    machineName,
    type: alert.severity.toUpperCase(),
    message: alert.message,
    technicianSummary: alert.technicianSummary,
    prevention: alert.prevention,
    anomalyScore: alert.anomalyScore,
    evidence: alert.evidence,
    timestamp: fmtTimestamp(new Date(alert.detectedAt)),
    status: alert.status,
    estimatedTimeToFailure:
      alert.severity === 'critical' ? '6-18 hours' : alert.severity === 'warning' ? '3-7 days' : null,
  };
}

function machineName(store: HandlerCtx['store'], machineId: string): string {
  return findMachine(store, machineId)?.name ?? machineId;
}

/** Alerts visible to the caller, with effective statuses applied, plus a
 *  derived alert for any machine whose fault was injected (via header or
 *  in-memory override) and which has no stored active alert — so an
 *  injected fault still shows an alert even on a cold instance. */
export function visibleAlerts(c: HandlerCtx): AlertDoc[] {
  const out: AlertDoc[] = [];
  for (const a of c.store.seed.alerts) {
    const eff = effectiveAlert(c.store, a, c.rctx);
    const machine = findMachine(c.store, a.machineId);
    if (machine && c.user && !canSeeUnit(c.user, machine.factoryUnit)) continue;
    out.push(eff);
  }
  // Derived alerts for injected faults without a stored active alert.
  // Only machines whose fault comes from an override (the x-sb-faults
  // header or an in-memory injection) get one: seed warning/critical
  // machines already have stored alerts, and deriving for them would
  // resurrect an alert the user just resolved.
  const bucket = tickBucket(c.store, c.rctx.now);
  for (const m of visibleMachines(c.store, c.rctx)) {
    const override = c.rctx.faultHeaders[m.machineId] ?? c.store.faultOverrides[m.machineId];
    if (!override || override === 'Healthy') continue;
    const eff = effectiveMachine(c.store, m, c.rctx);
    if (eff.status !== 'critical' && eff.status !== 'warning') continue;
    const hasActive = out.some(
      (a) => a.machineId === m.machineId && (a.status === 'active' || a.status === 'acknowledged'),
    );
    if (hasActive) continue;
    const derivedId = `derived-${m.machineId}`;
    const status = (c.rctx.alertHeaders[derivedId] ??
      c.store.alertStatusOverrides[derivedId] ??
      'active') as AlertDoc['status'];
    const r = liveReading(c.store, c.rctx, m, 1, bucket);
    const label = r.mlLabel as FaultLabel;
    out.push({
      id: derivedId,
      _id: derivedId,
      machineId: m.machineId,
      spindleId: 'SN001',
      severity: eff.status === 'critical' ? 'critical' : 'warning',
      status,
      message: `${label} detected with ${(r.mlConfidence * 100).toFixed(1)}% confidence.`,
      technicianSummary: `${label} fault on ${m.machineId}/SN001 — injected during the demo. Inspect the bearing and schedule replacement.`,
      prevention: getPreventionTips(label),
      anomalyScore: r.anomalyScore,
      evidence: buildEvidence(label, r.mlConfidence, r.fft, r.rpm, r.accel_z, 3.4, r.accel_z * 2.1),
      detectedAt: c.rctx.now.toISOString(),
    });
  }
  return out.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
}

export function listAlerts(c: HandlerCtx): void {
  let alerts = visibleAlerts(c);
  if (c.query.status) alerts = alerts.filter((a) => a.status === c.query.status);
  if (c.query.machineId) alerts = alerts.filter((a) => a.machineId === c.query.machineId);
  ok(c.res, alerts.map((a) => formatAlert(a, machineName(c.store, a.machineId))));
}

export function getAlert(c: HandlerCtx): void {
  const alert = visibleAlerts(c).find((a) => a.id === c.params.id);
  if (!alert) {
    fail(c.res, 404, 'Alert not found');
    return;
  }
  ok(c.res, alert);
}

export function exportAlertsCsv(c: HandlerCtx): void {
  const alerts = visibleAlerts(c);
  const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = alerts.map((a) =>
    [
      a.machineId,
      a.spindleId,
      a.severity,
      a.severity.toUpperCase(),
      a.message,
      a.status,
      a.detectedAt,
    ]
      .map(esc)
      .join(','),
  );
  okCsv(c.res, `machineId,spindleId,severity,type,message,status,detectedAt\n${rows.join('\n')}`);
}

function setAlertStatus(c: HandlerCtx, status: 'acknowledged' | 'resolved'): void {
  if (!requireRoles(c, ENG_ADMIN_MGR)) return;
  const stored = c.store.seed.alerts.find((a) => a.id === c.params.id);
  const nowIso = c.rctx.now.toISOString();
  if (stored) {
    stored.status = status;
    if (status === 'acknowledged') stored.acknowledgedAt = nowIso;
    if (status === 'resolved') stored.resolvedAt = nowIso;
    c.store.alertStatusOverrides[stored.id] = status;
    ok(c.res, stored);
    return;
  }
  // Derived alert (injected fault): record the override; the frontend's
  // x-sb-alerts header keeps it consistent across instances.
  const derived = visibleAlerts(c).find((a) => a.id === c.params.id);
  if (!derived) {
    fail(c.res, 404, 'Alert not found');
    return;
  }
  c.store.alertStatusOverrides[derived.id] = status;
  ok(c.res, {
    ...derived,
    status,
    acknowledgedAt: status === 'acknowledged' ? nowIso : derived.acknowledgedAt,
    resolvedAt: status === 'resolved' ? nowIso : derived.resolvedAt,
  });
}

export function acknowledgeAlert(c: HandlerCtx): void {
  setAlertStatus(c, 'acknowledged');
}

export function resolveAlert(c: HandlerCtx): void {
  setAlertStatus(c, 'resolved');
}

export function testEmail(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN_MGR)) return;
  // SMTP is not configured in the serverless deployment, so (exactly like
  // the original without SMTP env vars) this creates a real critical test
  // alert on M004 and reports the simulation.
  const bucket = tickBucket(c.store, c.rctx.now);
  const machine = findMachine(c.store, 'M004')!;
  const r = liveReading(c.store, c.rctx, machine, 4, bucket);
  const alertId = uid('test-alert');
  const alert: AlertDoc = {
    id: alertId,
    _id: alertId,
    machineId: 'M004',
    spindleId: 'SN004',
    severity: 'critical',
    status: 'active',
    message: 'Test alert: Outer Race detected with 90.0% confidence.',
    technicianSummary: 'Test alert created from the Settings page (SMTP not configured, so the email was simulated).',
    prevention: getPreventionTips('Outer Race'),
    anomalyScore: 0.8,
    evidence: buildEvidence('Outer Race', 0.9, r.fft, r.rpm, r.accel_z, 3.4, r.accel_z * 2.1),
    detectedAt: c.rctx.now.toISOString(),
  };
  c.store.seed.alerts.unshift(alert);
  const user = c.user && findUserById(c.store, c.user.id);
  const to = user?.alertEmail || 'no alert email saved';
  ok(c.res, {
    message: `Test email simulated (SMTP not configured). A test alert was created on M004 — it would have been sent to ${to}.`,
    simulated: true,
  });
}

export function testWhatsapp(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN_MGR)) return;
  const user = c.user && findUserById(c.store, c.user.id);
  if (!user?.alertWhatsapp) {
    fail(c.res, 400, 'No WhatsApp number saved');
    return;
  }
  // WhatsApp is not configured in the serverless deployment.
  fail(c.res, 503, 'WhatsApp not configured');
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export function analyticsSummary(c: HandlerCtx): void {
  ok(c.res, fleetSummary(c.store, c.rctx, tickBucket(c.store, c.rctx.now)));
}

function alertsByDay(c: HandlerCtx): Map<string, AlertDoc[]> {
  const byDay = new Map<string, AlertDoc[]>();
  for (const a of visibleAlerts(c)) {
    const day = a.detectedAt.slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push(a);
    byDay.set(day, list);
  }
  return byDay;
}

export function analyticsTrends(c: HandlerCtx): void {
  const byDay = alertsByDay(c);
  const fleetAvg = fleetSummary(c.store, c.rctx, tickBucket(c.store, c.rctx.now)).avgHealthScore;
  const today = startOfDay(c.rctx.now);
  const points = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(today.getTime() - (29 - i) * 86400_000);
    const key = d.toISOString().slice(0, 10);
    const dayAlerts = byDay.get(key) ?? [];
    const isToday = i === 29;
    const real = isToday || dayAlerts.length > 0;
    const critical = dayAlerts.filter((a) => a.severity === 'critical').length;
    const warning = dayAlerts.filter((a) => a.severity === 'warning').length;
    if (real) {
      points.push({
        day: i + 1,
        alerts: dayAlerts.length,
        critical,
        warning,
        avgHealth: isToday ? fleetAvg : Math.max(55, 100 - critical * 10 - warning * 5),
        projected: false,
      });
    } else {
      const alerts = Math.floor(seededRand(7, i) * 4);
      const crit = alerts > 0 ? Math.floor(seededRand(13, i) * 2) : 0;
      points.push({
        day: i + 1,
        alerts,
        critical: crit,
        warning: alerts - crit,
        avgHealth: Math.round(78 + seededRand(21, i) * 18),
        projected: true,
      });
    }
  }
  ok(c.res, points);
}

export function analyticsRoi(c: HandlerCtx): void {
  const resolved = visibleAlerts(c).filter((a) => a.status === 'resolved');
  const crit = resolved.filter((a) => a.severity === 'critical').length;
  const warn = resolved.filter((a) => a.severity === 'warning').length;
  ok(c.res, {
    preventedFailures: resolved.length,
    estimatedSavings: crit * 18000 + warn * 9000,
    downtimePrevented: crit * 18,
  });
}

export function analyticsHeatmap(c: HandlerCtx): void {
  const byDay = alertsByDay(c);
  const today = startOfDay(c.rctx.now);
  const points = [];
  for (let i = 0; i < 28; i++) {
    const d = new Date(today.getTime() - (27 - i) * 86400_000);
    const key = d.toISOString().slice(0, 10);
    const dayAlerts = byDay.get(key) ?? [];
    const isToday = i === 27;
    const real = isToday || dayAlerts.length > 0;
    points.push({
      day: i,
      intensity: real ? Math.min(4, dayAlerts.length) : Math.floor(seededRand(13, i) * 3),
      projected: !real,
    });
  }
  ok(c.res, points);
}

export function analyticsMonthly(c: HandlerCtx): void {
  const alerts = visibleAlerts(c);
  const now = c.rctx.now;
  const points = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const isCurrent = i === 11;
    const monthAlerts = alerts.filter((a) => a.detectedAt.slice(0, 7) === monthKey);
    const resolved = monthAlerts.filter((a) => a.status === 'resolved');
    points.push({
      month: d.toLocaleString('en', { month: 'short' }),
      Critical: isCurrent
        ? monthAlerts.filter((a) => a.severity === 'critical').length
        : Math.floor(seededRand(7, i) * 3),
      Warning: isCurrent
        ? monthAlerts.filter((a) => a.severity === 'warning').length
        : Math.floor(seededRand(13, i) * 4),
      Prevented: isCurrent ? resolved.length : Math.floor(seededRand(21, i) * 3),
      projected: !isCurrent,
    });
  }
  ok(c.res, points);
}

export function analyticsBearingTrend(c: HandlerCtx): void {
  const range = c.query.range ?? '1y';
  const days = range === '1m' ? 30 : range === '6m' ? 180 : 365;
  const bucket = tickBucket(c.store, c.rctx.now);

  let anchorVib = 0.45;
  let anchorTemp = 39;
  let anchorHealth = 92;
  const machineId = c.query.machineId;
  const machines = machineId
    ? visibleMachines(c.store, c.rctx).filter((m) => m.machineId === machineId)
    : visibleMachines(c.store, c.rctx);
  if (machines.length > 0) {
    let vib = 0;
    let temp = 0;
    let health = 0;
    let n = 0;
    for (const m of machines) {
      const r = liveReading(c.store, c.rctx, m, SPINDLES_PER_MACHINE, bucket);
      vib += r.accel_z;
      temp += r.temperature;
      health += r.healthScore;
      n += 1;
    }
    anchorVib = vib / n;
    anchorTemp = temp / n;
    anchorHealth = health / n;
  }

  // Deterministic wear model: vibration follows a t^4 ramp from the healthy
  // baseline to today's anchored value; health degrades on the same curve.
  const points = [];
  const start = c.rctx.now.getTime() - (days - 1) * 86400_000;
  for (let i = 0; i < days; i++) {
    const t = days > 1 ? i / (days - 1) : 1;
    const wear = t ** 4;
    const noise = (seededRand(31, i) - 0.5) * 0.05;
    const vibration = Math.max(0.1, 0.42 + (anchorVib - 0.42) * wear + noise);
    const temperature = 38 + (anchorTemp - 38) * wear + (seededRand(37, i) - 0.5) * 1.5;
    const health = Math.max(10, Math.round(98 - (98 - anchorHealth) * wear));
    points.push({
      date: new Date(start + i * 86400_000).toISOString().slice(0, 10),
      t: +t.toFixed(4),
      vibration: +round(vibration).toFixed(3),
      temperature: +round(temperature, 1).toFixed(1),
      health,
    });
  }

  const vibs = points.map((p) => p.vibration);
  const temps = points.map((p) => p.temperature);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanVib = mean(vibs);
  const variance = mean(vibs.map((v) => (v - meanVib) ** 2));
  const std = Math.sqrt(variance);
  const m4 = mean(vibs.map((v) => (v - meanVib) ** 4));
  const kurtosis = std > 0 ? m4 / std ** 4 : 3;
  const peakVib = Math.max(...vibs);
  const minVib = Math.min(...vibs);
  const last30 = points.slice(-30);
  const movingAverage30d = mean(last30.map((p) => p.vibration));
  const rulDecayRate = (points[0].health - points[points.length - 1].health) / days;
  const degradationIndex = (peakVib - vibs[0]) / Math.max(vibs[0], 0.01);

  const phases = [
    { key: 'healthy', name: 'Healthy', from: 0, to: Math.floor(days * 0.55), description: 'Vibration within baseline; routine monitoring only.' },
    { key: 'degrading', name: 'Degrading', from: Math.floor(days * 0.55), to: Math.floor(days * 0.8), description: 'Early wear signatures appear; increase inspection frequency.' },
    { key: 'fault', name: 'Fault developing', from: Math.floor(days * 0.8), to: days - 1, description: 'Defect frequencies dominate; plan bearing replacement.' },
  ];

  const summary = `Vibration has risen from ${vibs[0].toFixed(2)} to ${vibs[vibs.length - 1].toFixed(2)} g over the last ${days} days (degradation index ${degradationIndex.toFixed(2)}), while health fell from ${points[0].health} to ${points[points.length - 1].health}. Mean temperature is ${mean(temps).toFixed(1)} C. At the current decay rate of ${rulDecayRate.toFixed(2)} health points per day, plan the next bearing inspection within the current maintenance window.`;

  ok(c.res, {
    range,
    days,
    points,
    phases,
    stats: {
      peakVibration: +round(peakVib).toFixed(3),
      meanVibration: +round(meanVib).toFixed(3),
      meanTemperature: +round(mean(temps), 1).toFixed(1),
      stdDeviation: +round(std).toFixed(3),
      kurtosis: +round(kurtosis, 2).toFixed(2),
      peakToPeak: +round(peakVib - minVib).toFixed(3),
      movingAverage30d: +round(movingAverage30d).toFixed(3),
      rulDecayRate: +round(rulDecayRate, 3).toFixed(3),
      degradationIndex: +round(degradationIndex, 2).toFixed(2),
    },
    summary,
  });
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export function listMaintenance(c: HandlerCtx): void {
  const logs = c.store.seed.maintenance.filter((log) => {
    const machine = findMachine(c.store, log.machineId);
    return !machine || !c.user || canSeeUnit(c.user, machine.factoryUnit);
  });
  ok(c.res, logs);
}

export function createMaintenance(c: HandlerCtx): void {
  if (!requireRoles(c, ['maintenance_engineer', 'factory_manager', 'worker', 'operator'])) return;
  const { machineId, type, technicianName, notes, bearingReplaced, cost } = c.body;
  if (!machineId || !type) {
    fail(c.res, 400, 'machineId and type are required');
    return;
  }
  const machine = scopedMachine(c, String(machineId));
  if (!machine) {
    fail(c.res, 404, 'Machine not found');
    return;
  }
  const id = uid('maint');
  const log = {
    id,
    _id: id,
    machineId: String(machineId),
    type: String(type),
    performedAt: c.rctx.now.toISOString(),
    technicianName: technicianName ? String(technicianName) : (c.user?.email ?? 'Unknown'),
    notes: notes ? String(notes) : '',
    bearingReplaced: Boolean(bearingReplaced),
    cost: typeof cost === 'number' ? cost : 0,
  };
  c.store.seed.maintenance.unshift(log);
  ok(c.res, log, 201);
}

// ---------------------------------------------------------------------------
// ML
// ---------------------------------------------------------------------------

export function mlAnalysisHandler(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN_MGR)) return;
  // Real metrics, precomputed from the trained GradientBoosting model
  // (smartline_final.pkl) — see ml-analysis-PROVENANCE.md in the repo root.
  ok(c.res, mlAnalysis);
}
