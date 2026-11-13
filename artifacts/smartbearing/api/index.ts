// SmartBearing serverless backend — single catch-all function.
//
// The original backend was a long-lived Express + Socket.io + MongoDB
// server. This file (plus ./_lib) re-implements its whole REST surface as
// one Vercel function, with live data computed deterministically from the
// current time (see ./_lib/sim.ts) instead of a database. There is no
// Socket.io server — the frontend polls these endpoints instead (see
// src/lib/socket.ts, which returns a no-op stub in serverless mode).
//
// Routing: vercel.json rewrites /api/:path* -> /api/index?__path=:path*,
// so the original path arrives in the __path query param. Direct calls
// (/api/machines/...) also work — the handler strips the /api/ prefix.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getStore, parseOverrides, type RequestContext } from './_lib/store.js';
import { fail, ok, okRaw, readBody, requireAuth, type HandlerCtx } from './_lib/http.js';
import * as core from './_lib/handlers-core.js';
import * as ops from './_lib/handlers-ops.js';
import * as ingest from './_lib/handlers-ingest.js';

type Handler = (c: HandlerCtx) => void;

interface Route {
  method: string;
  /** Segments; ':name' captures one segment. Order matters — more specific
   *  patterns must come before the parametric ones they could shadow. */
  pattern: string;
  auth: boolean;
  handler: Handler;
}

const ROUTES: Route[] = [
  // Health (public)
  { method: 'GET', pattern: 'healthz', auth: false, handler: core.healthz },
  { method: 'GET', pattern: 'health/ml', auth: false, handler: core.healthMl },

  // Auth
  { method: 'POST', pattern: 'auth/login', auth: false, handler: core.login },
  { method: 'POST', pattern: 'auth/register', auth: false, handler: core.register },
  { method: 'GET', pattern: 'auth/me', auth: true, handler: core.me },
  { method: 'PATCH', pattern: 'auth/me', auth: true, handler: core.patchMe },
  { method: 'GET', pattern: 'auth/users', auth: true, handler: core.listUsers },
  { method: 'PATCH', pattern: 'auth/users/:id/role', auth: true, handler: core.patchUserRole },

  // Machines
  { method: 'GET', pattern: 'machines', auth: true, handler: core.listMachines },
  { method: 'GET', pattern: 'machines/:id', auth: true, handler: core.getMachine },
  { method: 'PUT', pattern: 'machines/:id', auth: true, handler: core.updateMachine },
  { method: 'GET', pattern: 'machines/:id/spindles', auth: true, handler: core.getSpindles },
  { method: 'GET', pattern: 'machines/:id/history', auth: true, handler: core.getHistory },
  { method: 'GET', pattern: 'machines/:id/fft', auth: true, handler: core.getFft },
  { method: 'GET', pattern: 'machines/:id/waveform', auth: true, handler: core.getWaveform },
  { method: 'GET', pattern: 'machines/:id/rul', auth: true, handler: core.getRul },

  // Alerts (export/csv must precede the :id patterns)
  { method: 'GET', pattern: 'alerts', auth: true, handler: core.listAlerts },
  { method: 'GET', pattern: 'alerts/export/csv', auth: true, handler: core.exportAlertsCsv },
  { method: 'GET', pattern: 'alerts/:id', auth: true, handler: core.getAlert },
  { method: 'PATCH', pattern: 'alerts/:id/acknowledge', auth: true, handler: core.acknowledgeAlert },
  { method: 'PATCH', pattern: 'alerts/:id/resolve', auth: true, handler: core.resolveAlert },
  { method: 'POST', pattern: 'alerts/test-email', auth: true, handler: core.testEmail },
  { method: 'POST', pattern: 'alerts/test-whatsapp', auth: true, handler: core.testWhatsapp },

  // Analytics
  { method: 'GET', pattern: 'analytics/summary', auth: true, handler: core.analyticsSummary },
  { method: 'GET', pattern: 'analytics/trends', auth: true, handler: core.analyticsTrends },
  { method: 'GET', pattern: 'analytics/roi', auth: true, handler: core.analyticsRoi },
  { method: 'GET', pattern: 'analytics/heatmap', auth: true, handler: core.analyticsHeatmap },
  { method: 'GET', pattern: 'analytics/monthly', auth: true, handler: core.analyticsMonthly },
  { method: 'GET', pattern: 'analytics/bearing-trend', auth: true, handler: core.analyticsBearingTrend },

  // Maintenance
  { method: 'GET', pattern: 'maintenance', auth: true, handler: core.listMaintenance },
  { method: 'POST', pattern: 'maintenance', auth: true, handler: core.createMaintenance },

  // ML
  { method: 'GET', pattern: 'ml/analysis', auth: true, handler: core.mlAnalysisHandler },

  // Hardware
  { method: 'GET', pattern: 'hardware/stream', auth: true, handler: ingest.getHardwareStream },
  { method: 'POST', pattern: 'hardware/manual', auth: true, handler: ingest.postHardwareManual },
  { method: 'POST', pattern: 'hardware/ingest', auth: false, handler: ingest.postHardwareIngest },
  { method: 'POST', pattern: 'hardware/simulator/start', auth: true, handler: ingest.hardwareSimulatorStart },
  { method: 'POST', pattern: 'hardware/simulator/stop', auth: true, handler: ingest.hardwareSimulatorStop },

  // Simulator
  { method: 'POST', pattern: 'simulator/start', auth: true, handler: ops.simulatorStart },
  { method: 'POST', pattern: 'simulator/stop', auth: true, handler: ops.simulatorStop },
  { method: 'POST', pattern: 'simulator/inject-fault', auth: true, handler: ops.injectFault },

  // Factory profile & units
  { method: 'GET', pattern: 'factory-profile', auth: true, handler: ops.getFactoryProfile },
  { method: 'PUT', pattern: 'factory-profile', auth: true, handler: ops.putFactoryProfile },
  { method: 'GET', pattern: 'factory-units', auth: true, handler: ops.listFactoryUnits },
  { method: 'GET', pattern: 'factory-units/:unitId', auth: true, handler: ops.getFactoryUnit },
  { method: 'POST', pattern: 'factory-units', auth: true, handler: ops.createFactoryUnit },
  { method: 'PUT', pattern: 'factory-units/:unitId', auth: true, handler: ops.updateFactoryUnit },
  { method: 'DELETE', pattern: 'factory-units/:unitId', auth: true, handler: ops.deleteFactoryUnit },
  { method: 'POST', pattern: 'factory-units/:unitId/machines', auth: true, handler: ops.assignUnitMachines },

  // Sensor readings — all public (phone PWA / test bench have no login)
  { method: 'GET', pattern: 'sensor-readings', auth: false, handler: ingest.listSensorReadings },
  { method: 'POST', pattern: 'sensor-readings', auth: false, handler: ingest.postSensorReading },
  { method: 'POST', pattern: 'sensor-readings/whatsapp-alert', auth: false, handler: ingest.postWhatsappAlert },
  { method: 'GET', pattern: 'sensor-readings/calibrate/:machineId', auth: false, handler: ingest.getCalibrate },
  { method: 'POST', pattern: 'sensor-readings/calibrate/:machineId', auth: false, handler: ingest.postCalibrate },
  { method: 'GET', pattern: 'sensor-readings/:machineId', auth: false, handler: ingest.getMachineReadings },
  { method: 'GET', pattern: 'sensor-readings/:machineId/fft', auth: false, handler: ingest.getMachineReadingFft },

  // Edge sensors (public, optional shared key)
  { method: 'POST', pattern: 'sensors/reading', auth: false, handler: ingest.postEdgeReading },

  // Operations (specific routes before the :collection catch-all)
  { method: 'GET', pattern: 'operations/overview', auth: true, handler: ops.operationsOverview },
  { method: 'GET', pattern: 'operations/incidents', auth: true, handler: ops.listIncidents },
  { method: 'POST', pattern: 'operations/incidents', auth: true, handler: ops.createIncident },
  { method: 'PATCH', pattern: 'operations/incidents/:id', auth: true, handler: ops.updateIncident },
  { method: 'POST', pattern: 'operations/incidents/:id/assign', auth: true, handler: ops.assignIncident },
  { method: 'POST', pattern: 'operations/incidents/:id/actions', auth: true, handler: ops.addIncidentAction },
  { method: 'GET', pattern: 'operations/incidents/:id/activity', auth: true, handler: ops.getIncidentActivity },
  { method: 'POST', pattern: 'operations/incidents/:id/comments', auth: true, handler: ops.addIncidentComment },
  { method: 'POST', pattern: 'operations/incidents/:id/evidence', auth: true, handler: ops.addIncidentEvidence },
  { method: 'POST', pattern: 'operations/incidents/:id/escalate', auth: true, handler: ops.escalateIncident },
  { method: 'POST', pattern: 'operations/incidents/:id/resolve', auth: true, handler: ops.resolveIncident },
  { method: 'POST', pattern: 'operations/incidents/:id/verify-recovery', auth: true, handler: ops.verifyRecovery },
  { method: 'POST', pattern: 'operations/incidents/:id/impact', auth: true, handler: ops.computeImpact },
  { method: 'GET', pattern: 'operations/business-impact', auth: true, handler: ops.listBusinessImpact },
  { method: 'GET', pattern: 'operations/slas/breaches', auth: true, handler: ops.listSlaBreaches },
  { method: 'GET', pattern: 'operations/:collection', auth: true, handler: ops.listOpsCollection },
  { method: 'POST', pattern: 'operations/:collection', auth: true, handler: ops.createOpsCollection },
];

function matchRoute(method: string, path: string): { route: Route; params: Record<string, string> } | null {
  const segments = path.split('/').filter((s) => s.length > 0);
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const patternSegments = route.pattern.split('/').filter((s) => s.length > 0);
    if (patternSegments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < patternSegments.length; i++) {
      const p = patternSegments[i];
      if (p.startsWith(':')) {
        params[p.slice(1)] = decodeURIComponent(segments[i]);
      } else if (p !== segments[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // CORS — the original used cors() wide open.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, x-sb-faults, x-sb-alerts, x-ingest-key, x-device-key, x-api-key',
  );
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    // Path: prefer the __path query param set by the vercel.json rewrite,
    // else strip the /api/ prefix from the request path.
    let path = query.__path ?? '';
    if (!path) {
      path = url.pathname.replace(/^\/?api\/?/, '').replace(/^\/?index\/?$/, '');
    }
    path = path.replace(/^\/+|\/+$/g, '');
    delete query.__path;

    // GET /api itself — a small info payload.
    if (path === '' && req.method === 'GET') {
      okRaw(res, {
        success: true,
        data: { name: 'SmartBearing API (serverless)', version: '1.0.0', mode: 'serverless' },
      });
      return;
    }

    const matched = matchRoute(req.method ?? 'GET', path);
    if (!matched) {
      fail(res, 404, `Not found: ${req.method} /api/${path}`);
      return;
    }

    const body =
      req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' ? await readBody(req) : {};
    const store = getStore();
    const rctx: RequestContext = {
      user: null,
      faultHeaders: parseOverrides(req.headers['x-sb-faults']),
      alertHeaders: parseOverrides(req.headers['x-sb-alerts']),
      now: new Date(),
    };
    const ctx: HandlerCtx = { req, res, params: matched.params, query, body, store, rctx, user: null };

    if (matched.route.auth) {
      const user = requireAuth(ctx);
      if (!user) return;
    }
    matched.route.handler(ctx);
  } catch (err) {
    console.error('SmartBearing API error:', err);
    if (!res.writableEnded) {
      fail(res, 500, err instanceof Error ? err.message : 'Internal server error');
    }
  }
}
