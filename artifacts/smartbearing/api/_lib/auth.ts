// Auth for the serverless backend — same contract as the original
// api-server (routes/auth.ts + middleware/auth.ts):
//   * JWT in `Authorization: Bearer <token>` (or `?token=` for the CSV
//     export, which the frontend opens as a plain navigation)
//   * payload { id, email, role, factoryUnits, customerName }, 7-day expiry
//   * missing token -> 401 { success:false, error:'Unauthorized' }
//   * invalid/expired token -> 403 { success:false, error:'Forbidden' }
//
// Differences (documented, demo-grade): the original used bcryptjs +
// MongoDB; here passwords are checked with SHA-256 + a salt, and users live
// in the in-memory store. The demo credentials are already public in the
// repo's Login page, so this is not a security downgrade for a hackathon
// demo — but it must not be used for real production accounts.

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const JWT_SECRET =
  process.env.JWT_SECRET ?? 'smartbearing_jwt_secret_change_in_production';

export type Role =
  | 'maintenance_engineer'
  | 'admin'
  | 'factory_manager'
  | 'worker'
  | 'customer'
  | 'operator';

export interface AuthUser {
  id: string;
  _id: string;
  name: string;
  email: string;
  role: Role;
  factoryUnits: string[];
  customerName?: string;
  alertEmail?: string;
  alertWhatsapp?: string;
  /** sha256 hex of `${SALT}:${password}` — demo-grade, see header. */
  passwordSha: string;
}

const PASSWORD_SALT = 'sb-demo-salt-v1';

export function hashPassword(password: string): string {
  return createHash('sha256').update(`${PASSWORD_SALT}:${password}`).digest('hex');
}

export function checkPassword(password: string, hash: string): boolean {
  const a = Buffer.from(hashPassword(password));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function signToken(user: AuthUser): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      id: user.id,
      email: user.email,
      role: user.role,
      factoryUnits: user.factoryUnits,
      customerName: user.customerName,
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    }),
  );
  const sig = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export interface TokenPayload {
  id: string;
  email: string;
  role: Role;
  factoryUnits: string[];
  customerName?: string;
  exp: number;
}

export function verifyToken(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof data.exp !== 'number' || data.exp < Date.now() / 1000) return null;
    return data;
  } catch {
    return null;
  }
}

/** Roles with global (all-unit) access — the original's access rule. */
export function isGlobalRole(role: Role): boolean {
  return role === 'admin' || role === 'maintenance_engineer';
}

/** Factory-unit ids a user may see; null = all units (global role). */
export function visibleUnits(user: TokenPayload): string[] | null {
  if (isGlobalRole(user.role)) return null;
  return user.factoryUnits ?? [];
}

/** Factory-unit ids a user may see; null = all units (global role). */
export function canSeeUnit(user: TokenPayload, unitId: string): boolean {
  const units = visibleUnits(user);
  return units === null || units.includes(unitId);
}

export function publicUser(user: AuthUser): Record<string, any> {
  const { passwordSha: _ignored, ...rest } = user;
  return rest;
}
