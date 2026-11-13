// Serverless-mode helpers.
//
// The Vercel deployment runs the backend as stateless serverless functions:
// there is no Socket.io server and no shared database. The frontend adapts:
//   * live feeds poll the REST API instead of listening on sockets
//     (see useRealSensors, useLiveSensors, useHardwareStream,
//     LiveReadingsChart), and getSocket() returns a no-op stub.
//   * demo writes (fault injection, alert ack/resolve) are ALSO stored in
//     localStorage and sent back as x-sb-faults / x-sb-alerts headers, so
//     they still show up after a function cold start for this browser.
//
// Enabled with VITE_SERVERLESS_MODE=true (see .env.production). Local dev
// against the Express backend keeps the old socket behaviour.

export const SERVERLESS_MODE = import.meta.env.VITE_SERVERLESS_MODE === 'true';

const FAULTS_KEY = 'sb-faults';
const ALERTS_KEY = 'sb-alerts';

function readMap(key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getFaultOverrides(): Record<string, string> {
  return readMap(FAULTS_KEY);
}

/** Record a fault injection ('Healthy' clears the override). */
export function setFaultOverride(machineId: string, faultType: string): void {
  const cur = getFaultOverrides();
  if (faultType === 'Healthy') delete cur[machineId];
  else cur[machineId] = faultType;
  localStorage.setItem(FAULTS_KEY, JSON.stringify(cur));
}

export function getAlertOverrides(): Record<string, string> {
  return readMap(ALERTS_KEY);
}

/** Record an alert ack/resolve so it survives cold starts. */
export function setAlertOverride(alertId: string, status: string): void {
  const cur = getAlertOverrides();
  cur[alertId] = status;
  localStorage.setItem(ALERTS_KEY, JSON.stringify(cur));
}
