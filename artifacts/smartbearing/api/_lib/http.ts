// HTTP plumbing shared by every handler: the response envelope, body
// parsing, and the JWT auth gate. Response shapes follow the original
// api-server exactly:
//   * success: { success: true, data }  (two documented exceptions —
//     GET /sensor-readings returns a bare array, POST /sensor-readings
//     returns its fields at the top level, GET /healthz has no envelope)
//   * failure: { success: false, error: '<msg>' }
//   * missing token -> 401 'Unauthorized'; bad/expired token -> 403 'Forbidden'

import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyToken, type Role, type TokenPayload } from './auth.js';
import type { RequestContext, Store } from './store.js';

export interface HandlerCtx {
  req: IncomingMessage;
  res: ServerResponse;
  /** Route params, e.g. { id: 'M001' } for /machines/:id. */
  params: Record<string, string>;
  /** Query params (single-valued). */
  query: Record<string, string>;
  /** Parsed JSON body ({} when absent/unparseable). */
  body: Record<string, any>;
  store: Store;
  /** Per-request context (user, override headers, now). */
  rctx: RequestContext;
  /** The authenticated user (set when the route requires auth). */
  user: TokenPayload | null;
}

export function ok(res: ServerResponse, data: any, status = 200): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ success: true, data }));
}

export function fail(res: ServerResponse, status: number, error: string, extra?: Record<string, any>): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ success: false, error, ...(extra ?? {}) }));
}

export function okRaw(res: ServerResponse, payload: any, status = 200): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

export function okCsv(res: ServerResponse, csv: string): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="alerts.csv"');
  res.end(csv);
}

export async function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Extract the bearer token from the Authorization header or ?token=.
 *  The query fallback exists for the CSV export, which the frontend opens
 *  as a plain browser navigation (no Authorization header). */
export function bearerToken(req: IncomingMessage, query: Record<string, string>): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  if (query.token) return query.token;
  return null;
}

/** Authenticate the request. Returns the token payload, or null after
 *  sending the 401/403 response. */
export function requireAuth(c: HandlerCtx): TokenPayload | null {
  const token = bearerToken(c.req, c.query);
  if (!token) {
    fail(c.res, 401, 'Unauthorized');
    return null;
  }
  const payload = verifyToken(token);
  if (!payload) {
    fail(c.res, 403, 'Forbidden');
    return null;
  }
  c.user = payload;
  c.rctx.user = payload;
  return payload;
}

/** Role gate — call after requireAuth. Sends 403 and returns false on failure. */
export function requireRoles(c: HandlerCtx, roles: Role[]): boolean {
  if (!c.user || !roles.includes(c.user.role)) {
    fail(c.res, 403, 'Forbidden');
    return false;
  }
  return true;
}

/** Optional shared-secret gate for ingest endpoints (open when unset). */
export function checkIngestKey(c: HandlerCtx, envName: string, headerName: string): boolean {
  const expected = process.env[envName];
  if (!expected) return true;
  const got = c.req.headers[headerName.toLowerCase()];
  if (got !== expected) {
    fail(c.res, 403, 'Forbidden');
    return false;
  }
  return true;
}
