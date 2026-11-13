// Route handlers: operations, factory profile/units, simulator.
// Shapes follow API-CONTRACT.md.

import { buildEvidence, type FaultLabel } from './dsp.js';
import { canSeeUnit, isGlobalRole, type Role } from './auth.js';
import { fail, ok, okRaw, requireRoles, type HandlerCtx } from './http.js';
import { createAlert, ensureIncidentForAlert } from './alerts.js';
import { effectiveMachine, findMachine } from './store.js';
import { liveReading, tickBucket } from './sim.js';
import { clamp, round, uid } from './util.js';

const ENG_ADMIN: Role[] = ['maintenance_engineer', 'admin'];
const ENG_ADMIN_MGR: Role[] = ['maintenance_engineer', 'admin', 'factory_manager'];
const OPS_WRITE: Role[] = ['maintenance_engineer', 'admin', 'factory_manager', 'worker', 'operator'];

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function scopeFilter(c: HandlerCtx): (unit: string) => boolean {
  if (!c.user) return () => true;
  if (isGlobalRole(c.user.role)) return () => true;
  const units = c.user.factoryUnits ?? [];
  return (unit: string) => units.includes(unit);
}

function isCustomer(c: HandlerCtx): boolean {
  return c.user?.role === 'customer';
}

/** Orders a customer may see (their own only); everyone else sees scoped orders. */
function visibleOrders(c: HandlerCtx): Record<string, any>[] {
  const inScope = scopeFilter(c);
  let orders = c.store.seed.orders.filter((o) => inScope(o.factoryUnit));
  if (isCustomer(c)) orders = orders.filter((o) => o.customerName === c.user!.customerName);
  return orders;
}

/** Lazy overdue escalation — the original ran this on a 60 s timer; here it
 *  runs on overview/incident reads (at most one level per hour per incident). */
function applyOverdueEscalations(c: HandlerCtx): void {
  const now = c.rctx.now.getTime();
  for (const inc of c.store.seed.incidents) {
    if (inc.status === 'resolved' || inc.status === 'closed') continue;
    if (inc.escalationLevel >= 3) continue;
    if (new Date(inc.dueAt).getTime() > now) continue;
    const last = c.store.escalations
      .filter((e) => e.incidentId === inc.id)
      .sort((a, b) => b.escalatedAt.localeCompare(a.escalatedAt))[0];
    if (last && now - new Date(last.escalatedAt).getTime() < 3600_000) continue;
    inc.escalationLevel += 1;
    c.store.escalations.push({
      id: uid('esc'),
      incidentId: inc.id,
      level: inc.escalationLevel,
      reason: 'SLA overdue — auto-escalated',
      escalatedBy: 'system',
      escalatedAt: c.rctx.now.toISOString(),
    });
  }
}

export function operationsOverview(c: HandlerCtx): void {
  applyOverdueEscalations(c);
  const inScope = scopeFilter(c);
  const orders = visibleOrders(c).slice(0, 50);
  const orderIds = new Set(orders.map((o) => o.orderId));
  const runs = c.store.seed.runs
    .filter((r) => inScope(r.factoryUnit) && (!isCustomer(c) || orderIds.has(r.orderId)))
    .slice(0, 50);
  const materials = c.store.seed.materials.filter((m) => inScope(m.factoryUnit)).slice(0, 50);
  const quality = c.store.seed.quality.filter((q) => inScope(q.factoryUnit)).slice(0, 50);
  const workforce = c.store.seed.workforce.filter((w) => inScope(w.factoryUnit)).slice(0, 50);
  const incidents = c.store.seed.incidents
    .filter(
      (i) =>
        inScope(i.factoryUnit) &&
        i.status !== 'resolved' &&
        i.status !== 'closed' &&
        (!isCustomer(c) || (i.orderId && orderIds.has(i.orderId))),
    )
    .slice(0, 50);
  const incidentIds = new Set(incidents.map((i) => i.id));
  const impacts = c.store.seed.impacts.filter((im) => incidentIds.has(im.incidentId)).slice(0, 50);

  const plannedOutput = runs.reduce((a, r) => a + (r.plannedQty ?? 0), 0);
  const goodOutput = runs.reduce((a, r) => a + (r.goodQty ?? 0), 0);
  const downtimeHours = runs.reduce((a, r) => a + (r.downtimeHours ?? 0), 0);
  const scrapQuantity = quality.reduce((a, q) => a + (q.defects ?? 0), 0);
  const avgAvailability = runs.length > 0 ? runs.reduce((a, r) => a + (r.availability ?? 0), 0) / runs.length : 0;
  const avgQuality = runs.length > 0 ? runs.reduce((a, r) => a + (r.qualityRate ?? 0), 0) / runs.length : 0;
  const scheduleAdherence = plannedOutput > 0 ? goodOutput / plannedOutput : 0;
  const oee = avgAvailability * avgQuality * Math.min(1, scheduleAdherence);

  ok(c.res, {
    orders,
    runs,
    materials,
    quality,
    workforce,
    incidents,
    impacts,
    kpis: {
      plannedOutput,
      goodOutput,
      scheduleAdherence: +round(scheduleAdherence, 3).toFixed(3),
      downtimeHours: +round(downtimeHours, 1).toFixed(1),
      scrapQuantity,
      outputLoss: plannedOutput - goodOutput,
      overtimeCost: Math.round(downtimeHours * 1200),
      oee: +round(oee, 3).toFixed(3),
      estimatedLoss: impacts.reduce((a, im) => a + (im.estimatedLoss ?? 0), 0),
      activeIncidentCount: incidents.length,
    },
  });
}

function findIncident(c: HandlerCtx, id: string): Record<string, any> | null {
  const inc = c.store.seed.incidents.find((i) => i.id === id || i.incidentNo === id);
  if (!inc) return null;
  if (!scopeFilter(c)(inc.factoryUnit)) return null;
  if (isCustomer(c) && (!inc.orderId || !visibleOrders(c).some((o) => o.orderId === inc.orderId))) return null;
  return inc;
}

export function listIncidents(c: HandlerCtx): void {
  applyOverdueEscalations(c);
  const inScope = scopeFilter(c);
  const orderIds = new Set(visibleOrders(c).map((o) => o.orderId));
  let list = c.store.seed.incidents.filter(
    (i) => inScope(i.factoryUnit) && (!isCustomer(c) || (i.orderId && orderIds.has(i.orderId))),
  );
  if (c.query.status) list = list.filter((i) => i.status === c.query.status);
  if (c.query.category) list = list.filter((i) => i.category === c.query.category);
  if (c.query.factoryUnit) list = list.filter((i) => i.factoryUnit === c.query.factoryUnit);
  ok(c.res, list.slice(0, 50));
}

export function createIncident(c: HandlerCtx): void {
  if (!requireRoles(c, OPS_WRITE)) return;
  const { title, description, category, severity, factoryUnit, machineId, orderId, dueAt } = c.body;
  if (!title || !category) {
    fail(c.res, 400, 'title and category are required');
    return;
  }
  const unit = factoryUnit ? String(factoryUnit) : 'unit-a';
  if (!scopeFilter(c)(unit)) {
    fail(c.res, 403, 'Forbidden');
    return;
  }
  const sev = severity ? String(severity) : 'medium';
  const baseScore = sev === 'critical' ? 85 : sev === 'high' ? 70 : sev === 'medium' ? 55 : 35;
  const n = 1000 + c.store.seed.incidents.length + 1;
  const id = uid('inc');
  const incident = {
    id,
    _id: id,
    incidentNo: `INC-${n}`,
    alertId: null,
    title: String(title),
    category: String(category),
    severity: sev,
    status: 'new',
    stage: 'detect',
    machineId: machineId ? String(machineId) : null,
    orderId: orderId ? String(orderId) : null,
    factoryUnit: unit,
    description: description ? String(description) : '',
    ownerUserId: null,
    ownerName: null,
    ownerTeam: null,
    dueAt: dueAt ? new Date(dueAt).toISOString() : new Date(c.rctx.now.getTime() + 24 * 3600_000).toISOString(),
    responseSlaMinutes: 60,
    resolutionSlaMinutes: 480,
    firstResponseAt: null,
    rootCause: '',
    recoveryVerified: false,
    escalationLevel: 0,
    impactScore: baseScore,
    createdBy: c.user?.id ?? 'unknown',
    createdAt: c.rctx.now.toISOString(),
  };
  c.store.seed.incidents.unshift(incident);
  ok(c.res, incident, 201);
}

export function updateIncident(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN_MGR)) return;
  const inc = findIncident(c, c.params.id);
  if (!inc) {
    fail(c.res, 404, 'Incident not found');
    return;
  }
  const allowed = ['title', 'description', 'category', 'severity', 'status', 'stage', 'machineId', 'orderId', 'factoryUnit', 'dueAt', 'impactScore'] as const;
  for (const key of allowed) {
    if (c.body[key] !== undefined) inc[key] = c.body[key];
  }
  ok(c.res, inc);
}

export function assignIncident(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN_MGR)) return;
  const inc = findIncident(c, c.params.id);
  if (!inc) {
    fail(c.res, 404, 'Incident not found');
    return;
  }
  inc.ownerUserId = c.body.ownerUserId ?? inc.ownerUserId;
  inc.ownerName = c.body.ownerName ?? inc.ownerName;
  inc.ownerTeam = c.body.ownerTeam ?? inc.ownerTeam;
  inc.status = 'triaged';
  inc.stage = 'triage';
  if (!inc.firstResponseAt) inc.firstResponseAt = c.rctx.now.toISOString();
  ok(c.res, inc);
}

export function addIncidentAction(c: HandlerCtx): void {
  if (!requireRoles(c, OPS_WRITE)) return;
  const inc = findIncident(c, c.params.id);
  if (!inc) {
    fail(c.res, 404, 'Incident not found');
    return;
  }
  const id = uid('act');
  const action = {
    id,
    _id: id,
    incidentId: inc.id,
    action: String(c.body.action ?? c.body.description ?? ''),
    status: c.body.status ? String(c.body.status) : 'open',
    createdBy: c.user?.email ?? 'unknown',
    createdAt: c.rctx.now.toISOString(),
  };
  c.store.seed.actions.push(action);
  ok(c.res, action, 201);
}

export function getIncidentActivity(c: HandlerCtx): void {
  const inc = findIncident(c, c.params.id);
  if (!inc) {
    fail(c.res, 404, 'Incident not found');
    return;
  }
  const actions = c.store.seed.actions.filter((a) => a.incidentId === inc.id);
  let comments = c.store.seed.comments.filter((cm) => cm.incidentId === inc.id);
  if (isCustomer(c)) comments = comments.filter((cm) => cm.visibility === 'customer');
  const evidence = c.store.seed.evidence.filter((e) => e.incidentId === inc.id);
  const escalations = c.store.escalations.filter((e) => e.incidentId === inc.id);
  const impact = c.store.seed.impacts.find((im) => im.incidentId === inc.id) ?? null;
  ok(c.res, { incident: inc, actions, comments, evidence, escalations, impact });
}

export function addIncidentComment(c: HandlerCtx): void {
  const inc = findIncident(c, c.params.id);
  if (!inc) {
    fail(c.res, 404, 'Incident not found');
    return;
  }
  const id = uid('cmt');
  const comment = {
    id,
    _id: id,
    incidentId: inc.id,
    author: c.user?.email ?? 'unknown',
    body: String(c.body.body ?? c.body.text ?? ''),
    visibility: isCustomer(c) ? 'customer' : c.body.visibility === 'customer' ? 'customer' : 'internal',
    createdAt: c.rctx.now.toISOString(),
  };
  c.store.seed.comments.push(comment);
  ok(c.res, comment, 201);
}

export function addIncidentEvidence(c: HandlerCtx): void {
  if (!requireRoles(c, OPS_WRITE)) return;
  const inc = findIncident(c, c.params.id);
  if (!inc) {
    fail(c.res, 404, 'Incident not found');
    return;
  }
  const id = uid('ev');
  const ev = {
    id,
    _id: id,
    incidentId: inc.id,
    type: c.body.type ? String(c.body.type) : 'note',
    url: c.body.url ? String(c.body.url) : '',
    description: c.body.description ? String(c.body.description) : '',
    createdAt: c.rctx.now.toISOString(),
  };
  c.store.seed.evidence.push(ev);
  ok(c.res, ev, 201);
}

export function escalateIncident(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN_MGR)) return;
  const inc = findIncident(c, c.params.id);
  if (!inc) {
    fail(c.res, 404, 'Incident not found');
    return;
  }
  inc.escalationLevel = (inc.escalationLevel ?? 0) + 1;
  const escalation = {
    id: uid('esc'),
    incidentId: inc.id,
    level: inc.escalationLevel,
    reason: c.body.reason ? String(c.body.reason) : 'Manual escalation',
    escalatedBy: c.user?.email ?? 'unknown',
    escalatedAt: c.rctx.now.toISOString(),
  };
  c.store.escalations.push(escalation);
  ok(c.res, { incident: inc, escalation }, 201);
}

export function resolveIncident(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN_MGR)) return;
  const inc = findIncident(c, c.params.id);
  if (!inc) {
    fail(c.res, 404, 'Incident not found');
    return;
  }
  if (!c.body.rootCause) {
    fail(c.res, 400, 'rootCause is required');
    return;
  }
  inc.rootCause = String(c.body.rootCause);
  if (c.body.recoveryEvidence) inc.recoveryEvidence = c.body.recoveryEvidence;
  inc.status = 'resolved';
  inc.stage = 'verify';
  ok(c.res, inc);
}

export function verifyRecovery(c: HandlerCtx): void {
  if (!requireRoles(c, OPS_WRITE)) return;
  const inc = findIncident(c, c.params.id);
  if (!inc) {
    fail(c.res, 404, 'Incident not found');
    return;
  }
  if (c.body.recovered) {
    inc.status = 'closed';
    inc.stage = 'closed';
    inc.recoveryVerified = true;
  } else {
    inc.status = 'action_required';
    inc.stage = 'correct';
    inc.recoveryVerified = false;
  }
  if (c.body.evidence) inc.recoveryEvidence = c.body.evidence;
  ok(c.res, inc);
}

/** Business-impact calculator — the original's impactFromInputs: delivery
 *  risk is a weighted sum of five 0–1 inputs (urgency 28, deadline 25,
 *  material 22, quality 15, downtime 10). */
export function computeImpact(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN_MGR)) return;
  const inc = findIncident(c, c.params.id);
  if (!inc) {
    fail(c.res, 404, 'Incident not found');
    return;
  }
  const n = (v: any, d = 0.5) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : d);
  const urgency = n(c.body.urgency);
  const deadline = n(c.body.deadline ?? c.body.deadlinePressure);
  const material = n(c.body.material ?? c.body.materialShortage);
  const quality = n(c.body.quality ?? c.body.qualityImpact);
  const downtime = n(c.body.downtime ?? c.body.downtimeImpact);
  const deliveryRisk = Math.round(urgency * 28 + deadline * 25 + material * 22 + quality * 15 + downtime * 10);
  const productionValueAtRisk =
    typeof c.body.productionValue === 'number'
      ? c.body.productionValue
      : typeof c.body.ordersAtRisk === 'number'
        ? c.body.ordersAtRisk * 10000
        : 50000;
  const estimatedLoss = Math.round(productionValueAtRisk * (deliveryRisk / 100));
  const id = uid('impact');
  const impact = {
    id,
    _id: id,
    incidentId: inc.id,
    incidentNo: inc.incidentNo,
    productionValueAtRisk,
    estimatedLoss,
    deliveryRisk,
    downtimeHours: typeof c.body.downtimeHours === 'number' ? c.body.downtimeHours : 0,
    confidence: 0.75,
    calculationVersion: 'v1-live-inputs',
    affectedOrders: Array.isArray(c.body.affectedOrders) ? c.body.affectedOrders : inc.orderId ? [inc.orderId] : [],
    createdAt: c.rctx.now.toISOString(),
  };
  const idx = c.store.seed.impacts.findIndex((im) => im.incidentId === inc.id);
  if (idx >= 0) c.store.seed.impacts[idx] = impact;
  else c.store.seed.impacts.push(impact);
  inc.impactScore = deliveryRisk;
  ok(c.res, impact);
}

export function listBusinessImpact(c: HandlerCtx): void {
  const inScope = scopeFilter(c);
  const orderIds = new Set(visibleOrders(c).map((o) => o.orderId));
  const incidents = c.store.seed.incidents.filter(
    (i) => inScope(i.factoryUnit) && (!isCustomer(c) || (i.orderId && orderIds.has(i.orderId))),
  );
  const ids = new Set(incidents.map((i) => i.id));
  ok(c.res, c.store.seed.impacts.filter((im) => ids.has(im.incidentId)).slice(0, 50));
}

export function listSlaBreaches(c: HandlerCtx): void {
  const inScope = scopeFilter(c);
  const now = c.rctx.now.getTime();
  const breaches = c.store.seed.incidents
    .filter(
      (i) =>
        inScope(i.factoryUnit) &&
        i.status !== 'resolved' &&
        i.status !== 'closed' &&
        new Date(i.dueAt).getTime() < now,
    )
    .map((i) => ({
      incidentId: i.id,
      incidentNo: i.incidentNo,
      title: i.title,
      severity: i.severity,
      dueAt: i.dueAt,
      hoursOverdue: +round((now - new Date(i.dueAt).getTime()) / 3600_000, 1).toFixed(1),
      escalationLevel: i.escalationLevel,
    }));
  ok(c.res, breaches);
}

const OPS_COLLECTIONS: Record<string, keyof import('./data.js').SeedData> = {
  orders: 'orders',
  production: 'runs',
  materials: 'materials',
  quality: 'quality',
  workforce: 'workforce',
  demand: 'demand',
};

export function listOpsCollection(c: HandlerCtx): void {
  const key = OPS_COLLECTIONS[c.params.collection];
  if (!key) {
    fail(c.res, 404, 'Collection not found');
    return;
  }
  const inScope = scopeFilter(c);
  let items = (c.store.seed[key] as Record<string, any>[]).filter((it) => !it.factoryUnit || inScope(it.factoryUnit));
  if (isCustomer(c) && key === 'orders') {
    items = items.filter((o) => o.customerName === c.user!.customerName);
  }
  ok(c.res, items.slice(0, 50));
}

export function createOpsCollection(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN_MGR)) return;
  const key = OPS_COLLECTIONS[c.params.collection];
  if (!key) {
    fail(c.res, 404, 'Collection not found');
    return;
  }
  if (c.body.factoryUnit && !scopeFilter(c)(String(c.body.factoryUnit))) {
    fail(c.res, 403, 'Forbidden');
    return;
  }
  const id = uid(c.params.collection);
  const item = { id, _id: id, ...c.body, createdAt: c.rctx.now.toISOString() };
  (c.store.seed[key] as Record<string, any>[]).unshift(item);
  ok(c.res, item, 201);
}

// ---------------------------------------------------------------------------
// Factory profile & units
// ---------------------------------------------------------------------------

export function getFactoryProfile(c: HandlerCtx): void {
  ok(c.res, c.store.seed.profile);
}

export function putFactoryProfile(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN_MGR)) return;
  const profile = c.store.seed.profile;
  for (const key of ['unitName', 'location', 'shiftTimings', 'description'] as const) {
    if (c.body[key] !== undefined) profile[key] = c.body[key];
  }
  profile.updatedAt = c.rctx.now.toISOString();
  ok(c.res, profile);
}

function unitView(c: HandlerCtx, unit: Record<string, any>): Record<string, any> {
  return { ...unit, machineCount: (unit.machineIds ?? []).length };
}

export function listFactoryUnits(c: HandlerCtx): void {
  const inScope = scopeFilter(c);
  ok(c.res, c.store.seed.units.filter((u) => inScope(u.unitId)).map((u) => unitView(c, u)));
}

export function getFactoryUnit(c: HandlerCtx): void {
  const unit = c.store.seed.units.find((u) => u.unitId === c.params.unitId);
  if (!unit || !scopeFilter(c)(unit.unitId)) {
    fail(c.res, 404, 'Factory unit not found');
    return;
  }
  const machines = c.store.seed.machines.filter((m) => (unit.machineIds ?? []).includes(m.machineId));
  ok(c.res, { ...unitView(c, unit), machines });
}

export function createFactoryUnit(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN)) return;
  const { unitId, name, location, description, machineIds } = c.body;
  if (!name) {
    fail(c.res, 400, 'name is required');
    return;
  }
  const id = unitId ? String(unitId) : uid('unit');
  if (c.store.seed.units.some((u) => u.unitId === id)) {
    fail(c.res, 400, 'Factory unit already exists');
    return;
  }
  const unit = {
    unitId: id,
    _id: id,
    name: String(name),
    location: location ? String(location) : '',
    description: description ? String(description) : '',
    machineIds: Array.isArray(machineIds) ? machineIds.map(String) : [],
    isActive: true,
    createdAt: c.rctx.now.toISOString(),
  };
  c.store.seed.units.push(unit);
  ok(c.res, unitView(c, unit), 201);
}

export function updateFactoryUnit(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN)) return;
  const unit = c.store.seed.units.find((u) => u.unitId === c.params.unitId);
  if (!unit) {
    fail(c.res, 404, 'Factory unit not found');
    return;
  }
  for (const key of ['name', 'location', 'description', 'isActive'] as const) {
    if (c.body[key] !== undefined) unit[key] = c.body[key];
  }
  if (Array.isArray(c.body.machineIds)) unit.machineIds = c.body.machineIds.map(String);
  ok(c.res, unitView(c, unit));
}

export function deleteFactoryUnit(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN)) return;
  const idx = c.store.seed.units.findIndex((u) => u.unitId === c.params.unitId);
  if (idx < 0) {
    fail(c.res, 404, 'Factory unit not found');
    return;
  }
  const unit = c.store.seed.units[idx];
  // Unlink machines (don't delete them).
  for (const m of c.store.seed.machines) {
    if (m.factoryUnit === unit.unitId) m.factoryUnit = '';
  }
  c.store.seed.units.splice(idx, 1);
  okRaw(c.res, { success: true, message: 'Factory unit deleted' });
}

export function assignUnitMachines(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN)) return;
  const unit = c.store.seed.units.find((u) => u.unitId === c.params.unitId);
  if (!unit) {
    fail(c.res, 404, 'Factory unit not found');
    return;
  }
  if (!Array.isArray(c.body.machineIds)) {
    fail(c.res, 400, 'machineIds array is required');
    return;
  }
  const ids = c.body.machineIds.map(String);
  for (const machineId of ids) {
    const m = findMachine(c.store, machineId);
    if (m) m.factoryUnit = unit.unitId;
  }
  unit.machineIds = [...new Set([...(unit.machineIds ?? []), ...ids])];
  ok(c.res, unitView(c, unit));
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

export function simulatorStart(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN)) return;
  c.store.simRunning = true;
  c.store.frozenBucket = null;
  ok(c.res, { status: 'Simulator started' });
}

export function simulatorStop(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN)) return;
  c.store.simRunning = false;
  c.store.frozenBucket = tickBucket(c.store, c.rctx.now);
  ok(c.res, { status: 'Simulator stopped' });
}

const FAULT_TYPES: FaultLabel[] = ['Healthy', 'Imbalance', 'Misalignment', 'Outer Race', 'Inner Race', 'Ball'];

export function injectFault(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN)) return;
  const { machineId, faultType } = c.body;
  if (!machineId || !faultType) {
    fail(c.res, 400, 'machineId and faultType are required');
    return;
  }
  if (!FAULT_TYPES.includes(faultType)) {
    fail(c.res, 400, `faultType must be one of: ${FAULT_TYPES.join(', ')}`);
    return;
  }
  const machine = findMachine(c.store, String(machineId));
  if (!machine) {
    fail(c.res, 404, 'Machine not found');
    return;
  }
  // Record the override (the frontend also sends it as an x-sb-faults header,
  // so the fault survives cold starts for the demoing browser).
  c.store.faultOverrides[machine.machineId] = faultType;
  if (faultType === 'Healthy') {
    machine.status = 'healthy';
    machine.faultProfile = null;
    // Clear active alerts on this machine.
    for (const a of c.store.seed.alerts) {
      if (a.machineId === machine.machineId && a.status === 'active') {
        a.status = 'resolved';
        a.resolvedAt = c.rctx.now.toISOString();
        c.store.alertStatusOverrides[a.id] = 'resolved';
      }
    }
  } else {
    machine.status = 'critical';
    machine.faultProfile = faultType as FaultLabel;
    // Create the matching alert (deduped per machine+spindle+severity).
    const bucket = tickBucket(c.store, c.rctx.now);
    const eff = effectiveMachine(c.store, machine, c.rctx);
    const r = liveReading(c.store, c.rctx, eff, 1, bucket);
    const { alert, created } = createAlert(
      c.store,
      {
        machineId: machine.machineId,
        spindleId: 'SN001',
        severity: 'critical',
        label: faultType as FaultLabel,
        confidence: 0.9,
        anomalyScore: r.anomalyScore,
        evidence: buildEvidence(faultType as FaultLabel, 0.9, r.fft, r.rpm, r.accel_z, 3.4, r.accel_z * 2.1),
      },
      c.rctx.now,
    );
    if (created) ensureIncidentForAlert(c.store, alert, c.rctx.now);
  }
  ok(c.res, { status: `Fault injected on ${machine.machineId} (${faultType})` });
}
