// Route handlers: hardware rig, phone/test-bench captures, edge sensors.
// Shapes follow API-CONTRACT.md. Note the auth: sensor-readings and edge
// routes are PUBLIC in the original (no JWT, only optional shared secrets
// via env) — the phone PWA and edge devices have no login.
//
// Deliberate deviation from the original, documented here: the original
// rejects edge readings with 503 when its Python ML server is down. The
// serverless backend classifies in-process with the DSP engine (the same
// fallback the original simulator used), so the classifier is never down
// and edge readings are always accepted with a real DSP verdict.

import {
  buildEvidence,
  classifyDSP,
  cwruFallback,
  defectFrequencies,
  healthFromVerdict,
  kurtosisOf,
  signalStats,
  temperatureFromStats,
  type FaultLabel,
} from './dsp.js';
import { computeFFTBins, fftMagnitudeSpectrum } from './fft.js';
import { checkIngestKey, fail, ok, okRaw, requireRoles, type HandlerCtx } from './http.js';
import { createAlert, ensureIncidentForAlert } from './alerts.js';
import { findMachine } from './store.js';
import {
  hardwareFrames,
  hardwareStream,
  liveReading,
  tickBucket,
  SPINDLES_PER_MACHINE,
  type HardwareFrame,
} from './sim.js';
import { clamp, rngFor, round, uid } from './util.js';
import type { Role } from './auth.js';

const HW_MANUAL_ROLES: Role[] = ['maintenance_engineer', 'admin', 'factory_manager', 'worker', 'operator'];
const ENG_ADMIN: Role[] = ['maintenance_engineer', 'admin'];

// ---------------------------------------------------------------------------
// Hardware
// ---------------------------------------------------------------------------

export function getHardwareStream(c: HandlerCtx): void {
  ok(c.res, hardwareStream(c.store, c.rctx.now));
}

/** Heuristic verdict for a manual/arduino sample — the original's rules. */
function heuristicVerdict(
  rpm: number,
  temperature: number | null,
): { verdict: string; colour: string; health_index: number } {
  if (temperature !== null && temperature > 75) return { verdict: 'BEARING FAULT / SEVERE', colour: 'red', health_index: 0.25 };
  if (temperature !== null && temperature > 60) return { verdict: 'BEARING FAULT / SEVERE', colour: 'red', health_index: 0.5 };
  if (rpm <= 0) return { verdict: 'STALLED', colour: 'red', health_index: 0.4 };
  return { verdict: 'HEALTHY', colour: 'green', health_index: 0.9 };
}

function verdictLabel(verdict: string): FaultLabel {
  if (verdict.includes('SEVERE')) return 'Outer Race';
  if (verdict.includes('WARNING')) return 'Imbalance';
  if (verdict.includes('STALLED')) return 'Misalignment';
  return 'Healthy';
}

/** Persist a manual/arduino frame as a rig reading on M001/RIG01 and raise
 *  an alert when the verdict is bad — the original's persistAndPropagate. */
function persistRigReading(c: HandlerCtx, frame: HardwareFrame, source: string): void {
  const healthScore = Math.round(frame.health_index * 100);
  const reading = {
    id: uid('rig'),
    machineId: 'M001',
    nodeId: 'RIG01',
    spindleId: 'RIG01',
    rpm: frame.rpm,
    temperature: frame.temperature,
    vibrationRMS: +round((1 - frame.health_index) * 2).toFixed(3),
    anomalyScore: +round(1 - frame.health_index, 3).toFixed(3),
    healthScore,
    mlLabel: verdictLabel(frame.verdict),
    mlConfidence: frame.health_index,
    captureMethod: source,
    source,
    timestamp: frame.timestamp,
  };
  c.store.rigReadings.unshift(reading);
  if (c.store.rigReadings.length > 200) c.store.rigReadings.length = 200;

  if (healthScore < 70) {
    const severity = healthScore < 40 ? 'critical' : 'warning';
    const label = verdictLabel(frame.verdict);
    const { alert, created } = createAlert(
      c.store,
      {
        machineId: 'M001',
        spindleId: 'RIG01',
        severity,
        label,
        confidence: clamp(1 - frame.health_index, 0.6, 0.97),
        anomalyScore: 1 - frame.health_index,
        evidence: {
          label,
          confidence: clamp(1 - frame.health_index, 0.6, 0.97),
          dominantFreq: 0,
          rpm: frame.rpm,
          peaks: [],
          features: { rms: reading.vibrationRMS, kurtosis: 3, crestFactor: 2 },
          defectFrequencies: defectFrequencies(frame.rpm),
        },
        technicianSummary: `${label} fault indicated by the ${source} rig reading on M001/RIG01 (health ${healthScore}).`,
      },
      c.rctx.now,
    );
    if (created) ensureIncidentForAlert(c.store, alert, c.rctx.now);
  }
}

/** Rolling 30-frame features for a new manual/arduino sample. */
function frameWithFeatures(c: HandlerCtx, rpm: number, temperature: number | null, source: string): HardwareFrame {
  const prev = hardwareFrames(c.store, c.rctx.now).slice(-29);
  const rpms = [...prev.map((f) => f.rpm), rpm];
  const temps = [...prev.map((f) => f.temperature).filter((t) => t !== null), ...(temperature !== null ? [temperature] : [])];
  const rpmMean = rpms.reduce((a, b) => a + b, 0) / rpms.length;
  const rpmStd = Math.sqrt(rpms.reduce((a, b) => a + (b - rpmMean) ** 2, 0) / rpms.length);
  const tempMean = temps.length > 0 ? temps.reduce((a, b) => a + b, 0) / temps.length : temperature ?? 0;
  const tempRate = prev.length > 0 && temperature !== null && prev[prev.length - 1].temperature !== null
    ? temperature - (prev[prev.length - 1].temperature as number)
    : 0;
  const v = heuristicVerdict(rpm, temperature);
  return {
    rpm,
    temperature: temperature ?? (prev.length > 0 ? prev[prev.length - 1].temperature : null),
    motorSpeed: rpm,
    rpm_mean: +rpmMean.toFixed(1),
    rpm_std: +rpmStd.toFixed(2),
    temp_mean: +tempMean.toFixed(1),
    temp_rate_of_change: +tempRate.toFixed(3),
    rpm_temp_ratio: temperature ? +(rpm / temperature).toFixed(2) : 0,
    health_index: v.health_index,
    verdict: v.verdict,
    colour: v.colour,
    source,
    timestamp: c.rctx.now.toISOString(),
  };
}

function appendHardwareFrame(c: HandlerCtx, frame: HardwareFrame): void {
  c.store.hardwareFrames.push(frame);
  if (c.store.hardwareFrames.length > 300) c.store.hardwareFrames.splice(0, c.store.hardwareFrames.length - 300);
  c.store.hardwareIngestCount += 1;
  c.store.lastIngestAt = frame.timestamp;
}

export function postHardwareManual(c: HandlerCtx): void {
  if (!requireRoles(c, HW_MANUAL_ROLES)) return;
  if (!checkIngestKey(c, 'HARDWARE_INGEST_KEY', 'x-ingest-key')) return;
  const rpm = Number(c.body.rpm);
  if (!Number.isFinite(rpm)) {
    fail(c.res, 400, 'rpm is required');
    return;
  }
  const temperature = c.body.temperature !== undefined && c.body.temperature !== null ? Number(c.body.temperature) : null;
  const frame = frameWithFeatures(c, rpm, temperature, 'manual');
  if (c.body.motorSpeed !== undefined) frame.motorSpeed = Number(c.body.motorSpeed);
  appendHardwareFrame(c, frame);
  persistRigReading(c, frame, 'manual');
  ok(c.res, frame);
}

export function postHardwareIngest(c: HandlerCtx): void {
  if (!checkIngestKey(c, 'HARDWARE_INGEST_KEY', 'x-ingest-key')) return;
  const rpm = Number(c.body.rpm ?? c.body.rpm_mean);
  if (!Number.isFinite(rpm)) {
    fail(c.res, 400, 'rpm is required');
    return;
  }
  const temperature = c.body.temperature !== undefined && c.body.temperature !== null ? Number(c.body.temperature) : null;
  // When the rig sends its own rolling features, trust them; otherwise
  // compute them from the ring buffer.
  let frame: HardwareFrame;
  if (typeof c.body.rpm_mean === 'number') {
    const v = heuristicVerdict(rpm, temperature);
    frame = {
      rpm,
      temperature,
      motorSpeed: Number(c.body.motorSpeed ?? rpm),
      rpm_mean: Number(c.body.rpm_mean),
      rpm_std: Number(c.body.rpm_std ?? 0),
      temp_mean: Number(c.body.temp_mean ?? temperature ?? 0),
      temp_rate_of_change: Number(c.body.temp_rate_of_change ?? 0),
      rpm_temp_ratio: Number(c.body.rpm_temp_ratio ?? (temperature ? rpm / temperature : 0)),
      health_index: typeof c.body.health_index === 'number' ? c.body.health_index : v.health_index,
      verdict: c.body.verdict ? String(c.body.verdict) : v.verdict,
      colour: c.body.colour ? String(c.body.colour) : v.colour,
      source: 'arduino',
      timestamp: c.rctx.now.toISOString(),
    };
  } else {
    frame = frameWithFeatures(c, rpm, temperature, 'arduino');
  }
  appendHardwareFrame(c, frame);
  persistRigReading(c, frame, 'arduino');
  ok(c.res, frame);
}

export function hardwareSimulatorStart(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN)) return;
  c.store.hardwareSimRunning = true;
  ok(c.res, { running: true });
}

export function hardwareSimulatorStop(c: HandlerCtx): void {
  if (!requireRoles(c, ENG_ADMIN)) return;
  c.store.hardwareSimRunning = false;
  ok(c.res, { running: false });
}

// ---------------------------------------------------------------------------
// Sensor readings (phone capture / test bench) — all public
// ---------------------------------------------------------------------------

function liveReadingAsCapture(c: HandlerCtx, machineId: string, spindleIdx: number, bucket: number): Record<string, any> {
  const machine = findMachine(c.store, machineId)!;
  const r = liveReading(c.store, c.rctx, machine, spindleIdx, bucket);
  return {
    id: `${machineId}-${r.spindleId}-${bucket}`,
    machineId,
    nodeId: r.spindleId,
    rpm: r.rpm,
    temperature: r.temperature,
    vibrationRMS: r.accel_z,
    anomalyScore: r.anomalyScore,
    healthScore: r.healthScore,
    mlLabel: r.mlLabel,
    mlConfidence: r.mlConfidence,
    captureMethod: 'simulator',
    source: 'simulator',
    timestamp: r.timestamp,
  };
}

export function listSensorReadings(c: HandlerCtx): void {
  const limit = Math.min(200, Math.max(1, parseInt(c.query.limit ?? '50', 10) || 50));
  const bucket = tickBucket(c.store, c.rctx.now);
  const all: Record<string, any>[] = [...c.store.captures, ...c.store.rigReadings];
  for (const m of c.store.seed.machines) {
    for (let i = 1; i <= SPINDLES_PER_MACHINE; i++) {
      all.push(liveReadingAsCapture(c, m.machineId, i, bucket));
    }
  }
  all.sort((a, b) => {
    const d = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    if (d !== 0) return d;
    return `${a.machineId}${a.nodeId}`.localeCompare(`${b.machineId}${b.nodeId}`);
  });
  // Bare array — the ONLY non-enveloped list endpoint (the Dashboard
  // captures card checks Array.isArray(res.data)).
  okRaw(c.res, all.slice(0, limit));
}

export function postSensorReading(c: HandlerCtx): void {
  const { machineId } = c.body;
  if (!machineId) {
    fail(c.res, 400, 'machineId is required');
    return;
  }
  const machine = findMachine(c.store, String(machineId));
  if (!machine) {
    fail(c.res, 404, 'Machine not found');
    return;
  }
  const nodeId = c.body.nodeId ? String(c.body.nodeId) : 'SN001';
  const rpm = typeof c.body.rpm === 'number' ? c.body.rpm : 14200;
  const now = c.rctx.now;
  const rng = rngFor(machineId, nodeId, now.getTime());

  let mlLabel: FaultLabel | null = null;
  let mlConfidence: number | null = null;
  let fftSnapshot = c.body.fftSnapshot ?? null;
  let evidence: Record<string, any> | null = null;

  const signal = Array.isArray(c.body.signal) && c.body.signal.length === 2048 ? (c.body.signal as number[]) : null;
  if (signal) {
    // Real classification, in-process via the DSP engine.
    const sampleRate = typeof c.body.sampleRate === 'number' ? c.body.sampleRate : 44100;
    const verdict = classifyDSP(signal, rpm, sampleRate);
    mlLabel = verdict.label;
    mlConfidence = +verdict.confidence.toFixed(3);
    const stats = signalStats(signal);
    const fft = computeFFTBins(signal, sampleRate, 128);
    fftSnapshot = fft;
    evidence = buildEvidence(verdict.label, verdict.confidence, fft, rpm, stats.rms, stats.kurtosis, stats.peak);
  }

  const anomalyScore =
    typeof c.body.anomalyScore === 'number'
      ? c.body.anomalyScore
      : typeof c.body.bpfoScore === 'number'
        ? c.body.bpfoScore
        : mlLabel !== null
          ? mlLabel === 'Healthy'
            ? 1 - (mlConfidence ?? 0.95)
            : (mlConfidence ?? 0.6)
          : 0;

  let healthScore: number;
  if (typeof c.body.healthScore === 'number') {
    healthScore = c.body.healthScore;
  } else if (mlLabel !== null && mlConfidence !== null) {
    healthScore = healthFromVerdict({ label: mlLabel, confidence: mlConfidence, anomaly: mlLabel !== 'Healthy', scores: {}, ratios: {} });
  } else {
    healthScore = clamp(Math.round(100 - anomalyScore * 100), 10, 100);
  }

  // Temperature/voltage fall back to the CWRU table when the capture
  // doesn't carry them (same as the original).
  let temperature = c.body.temperature;
  let voltage = c.body.voltage;
  if (temperature === undefined || voltage === undefined) {
    const fb = cwruFallback(mlLabel ?? 'Healthy', c.body.severity, rng);
    if (temperature === undefined) temperature = fb.temperature;
    if (voltage === undefined) voltage = fb.voltage;
  }

  const technicianSummary =
    mlLabel !== null
      ? `${mlLabel} fault signature detected on ${machineId}/${nodeId} (${((mlConfidence ?? 0) * 100).toFixed(0)}% confidence).`
      : null;

  const capture = {
    id: uid('cap'),
    machineId: String(machineId),
    nodeId,
    rpm,
    temperature,
    voltage,
    vibrationRMS: typeof c.body.vibrationRMS === 'number' ? c.body.vibrationRMS : typeof c.body.accel_z === 'number' ? c.body.accel_z : 0,
    acousticLevel: c.body.acousticLevel ?? null,
    bpfoScore: c.body.bpfoScore ?? null,
    anomalyScore: +round(anomalyScore, 3).toFixed(3),
    healthScore,
    mlLabel,
    mlConfidence,
    captureMethod: c.body.captureMethod ? String(c.body.captureMethod) : 'smartphone',
    capturedBy: c.body.capturedBy ? String(c.body.capturedBy) : null,
    technicianSummary,
    source: 'smartphone',
    fftSnapshot,
    evidence,
    timestamp: c.body.timestamp ? new Date(c.body.timestamp).toISOString() : now.toISOString(),
  };
  c.store.captures.unshift(capture);
  if (c.store.captures.length > 1000) c.store.captures.length = 1000;

  let alertCreated = false;
  if (healthScore < 70) {
    const severity = healthScore < 40 ? 'critical' : 'warning';
    const label = mlLabel ?? (severity === 'critical' ? 'Outer Race' : 'Imbalance');
    const { alert, created } = createAlert(
      c.store,
      {
        machineId: String(machineId),
        spindleId: nodeId,
        severity,
        label,
        confidence: mlConfidence ?? 0.85,
        anomalyScore,
        evidence: evidence ?? {
          label,
          confidence: mlConfidence ?? 0.85,
          dominantFreq: 0,
          rpm,
          peaks: [],
          features: { rms: capture.vibrationRMS, kurtosis: 3, crestFactor: 2 },
          defectFrequencies: defectFrequencies(rpm),
        },
        technicianSummary: technicianSummary ?? undefined,
      },
      now,
    );
    alertCreated = created;
    if (created) ensureIncidentForAlert(c.store, alert, now);
  }

  // Top-level fields, NOT wrapped in `data` (TestBench reads res.data.mlLabel).
  okRaw(c.res, {
    success: true,
    healthScore,
    alertCreated,
    mlLabel,
    mlConfidence,
    technicianSummary,
    probabilities: null,
    defectFrequencies: defectFrequencies(rpm),
  });
}

export function getMachineReadings(c: HandlerCtx): void {
  const machineId = c.params.machineId;
  const items = [...c.store.captures, ...c.store.rigReadings]
    .filter((r) => r.machineId === machineId)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 100);
  ok(c.res, items);
}

export function getMachineReadingFft(c: HandlerCtx): void {
  const machineId = c.params.machineId;
  const latest = [...c.store.captures, ...c.store.rigReadings]
    .filter((r) => r.machineId === machineId && Array.isArray(r.fftSnapshot))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
  if (latest) {
    ok(c.res, latest.fftSnapshot);
    return;
  }
  const machine = findMachine(c.store, machineId);
  if (!machine) {
    fail(c.res, 404, 'Machine not found');
    return;
  }
  const r = liveReading(c.store, c.rctx, machine, SPINDLES_PER_MACHINE, tickBucket(c.store, c.rctx.now));
  ok(c.res, r.fft);
}

export function postCalibrate(c: HandlerCtx): void {
  const machineId = c.params.machineId;
  c.store.calibrations[machineId] = {
    bpfoBaseline: c.body.bpfoBaseline ?? null,
    acousticBaseline: c.body.acousticBaseline ?? null,
    capturedAt: c.rctx.now.toISOString(),
  };
  okRaw(c.res, { success: true });
}

export function getCalibrate(c: HandlerCtx): void {
  const cal = c.store.calibrations[c.params.machineId];
  if (!cal) {
    fail(c.res, 404, 'No calibration found');
    return;
  }
  ok(c.res, { bpfoFloor: cal.bpfoBaseline, acousticFloor: cal.acousticBaseline, capturedAt: cal.capturedAt });
}

export function postWhatsappAlert(c: HandlerCtx): void {
  // Acknowledgement only — no real delivery (same as the original).
  okRaw(c.res, { success: true });
}

// ---------------------------------------------------------------------------
// Edge sensors
// ---------------------------------------------------------------------------

export function postEdgeReading(c: HandlerCtx): void {
  const key = process.env.EDGE_DEVICE_KEY;
  if (key) {
    const got = c.req.headers['x-device-key'] ?? c.req.headers['x-api-key'];
    if (got !== key) {
      fail(c.res, 403, 'Forbidden');
      return;
    }
  }
  const { machineId, signal } = c.body;
  if (!machineId || !Array.isArray(signal) || signal.length !== 2048) {
    fail(c.res, 400, 'machineId and a 2048-sample signal are required');
    return;
  }
  const machine = findMachine(c.store, String(machineId));
  if (!machine) {
    fail(c.res, 404, 'Machine not found');
    return;
  }
  const spindleId = c.body.spindleId ? String(c.body.spindleId) : 'SN001';
  const rpm = typeof c.body.rpm === 'number' ? c.body.rpm : 14400;
  const sampleRateHz = typeof c.body.sampleRateHz === 'number' ? c.body.sampleRateHz : 1000;
  const now = c.rctx.now;

  const verdict = classifyDSP(signal, rpm, sampleRateHz);
  const stats = signalStats(signal);
  const fft = computeFFTBins(signal, sampleRateHz, 128);
  // The original edge ingest scores the fixed 130–180 Hz band (not the
  // machine's BPFO) — ported as-is.
  const mags = fftMagnitudeSpectrum(signal);
  const binHz = sampleRateHz / 2 / mags.length;
  let total = 0;
  let band = 0;
  for (let i = 0; i < mags.length; i++) {
    const e = mags[i] * mags[i];
    total += e;
    const f = i * binHz;
    if (f >= 130 && f <= 180) band += e;
  }
  const bpfoScore = total > 0 ? band / total : 0;
  const healthScore = healthFromVerdict(verdict);
  const temperature = temperatureFromStats(stats.rms, stats.kurtosis, verdict.anomaly && healthScore < 40);
  const kurt = kurtosisOf(signal);

  const readingId = uid('edge');
  const capture = {
    id: readingId,
    machineId: String(machineId),
    nodeId: spindleId,
    rpm,
    temperature: +round(temperature, 1).toFixed(1),
    vibrationRMS: +round(stats.rms).toFixed(3),
    anomalyScore: +round(bpfoScore, 3).toFixed(3),
    healthScore,
    mlLabel: verdict.label,
    mlConfidence: +verdict.confidence.toFixed(3),
    captureMethod: 'edge',
    source: 'edge',
    fftSnapshot: fft,
    evidence: buildEvidence(verdict.label, verdict.confidence, fft, rpm, stats.rms, kurt, stats.peak),
    timestamp: now.toISOString(),
  };
  c.store.captures.unshift(capture);
  if (c.store.captures.length > 1000) c.store.captures.length = 1000;

  if (healthScore < 70) {
    const severity = healthScore < 40 ? 'critical' : 'warning';
    const { alert, created } = createAlert(
      c.store,
      {
        machineId: String(machineId),
        spindleId,
        severity,
        label: verdict.label,
        confidence: verdict.confidence,
        anomalyScore: bpfoScore,
        evidence: capture.evidence,
      },
      now,
    );
    if (created) ensureIncidentForAlert(c.store, alert, now);
  }

  ok(c.res, {
    readingId,
    machineId: String(machineId),
    spindleId,
    timestamp: now.toISOString(),
    healthScore,
    label: verdict.label,
    confidence: +verdict.confidence.toFixed(3),
    anomalyFlag: verdict.anomaly,
    bpfoScore: +round(bpfoScore, 3).toFixed(3),
    temperature: +round(temperature, 1).toFixed(1),
    rpm,
  });
}
