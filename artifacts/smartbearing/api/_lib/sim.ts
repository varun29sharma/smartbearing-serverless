// Deterministic live engine — the serverless replacement for the original
// api-server's SensorSimulator (3.5 s tick) and HardwareSimulator (1 s tick).
//
// The original simulators ran in a long-lived process and wrote readings to
// MongoDB. Here every reading is computed on demand from (machine, spindle,
// time-bucket) with a seeded PRNG, so:
//   * consecutive polls inside one 3.5 s bucket return identical values
//     (the dashboard's charts don't flicker between requests);
//   * values move between buckets (the feed looks live);
//   * every function instance computes the same values (no shared DB needed).
// Machine health is taken from the SN005 reading, mirroring the original's
// last-write-wins behaviour (the simulator wrote SN001..SN005 in order).

import {
  bpfoScoreFromFft,
  classifyDSP,
  faultForMachine,
  healthFromRms,
  severityForStatus,
  signalStats,
  synthesizeSignal,
  temperatureFromStats,
  HEALTHY_RMS_MAX,
  SIGNAL_LENGTH,
  SPINDLE_RPM,
} from './dsp.js';
import { computeFFTBins } from './fft.js';
import { clamp, gaussian, rngFor, round, startOfDay } from './util.js';
import {
  effectiveAlert,
  effectiveMachine,
  type RequestContext,
  type Store,
} from './store.js';
import type { MachineDoc } from './data.js';
import { canSeeUnit } from './auth.js';

export const TICK_MS = 3500;
export const SPINDLES_PER_MACHINE = 5;

/** Current 3.5 s tick bucket — frozen while the simulator is stopped. */
export function tickBucket(store: Store, now: Date): number {
  if (!store.simRunning && store.frozenBucket !== null) return store.frozenBucket;
  return Math.floor(now.getTime() / TICK_MS);
}

export function spindleId(idx: number): string {
  return `SN${String(idx).padStart(3, '0')}`;
}

export interface LiveReading {
  machineId: string;
  spindleId: string;
  nodeId: string;
  location: string;
  healthScore: number;
  anomalyScore: number;
  anomalyFlag: boolean;
  accel_x: number;
  accel_y: number;
  accel_z: number;
  rpm: number;
  temperature: number;
  voltage: number;
  acousticLevel: number;
  mlLabel: string;
  mlConfidence: number;
  fft: { freq: number; amplitude: number }[];
  waveform: number[];
  timestamp: string;
  createdAt: string;
}

// Small cache so one request's repeated reads (fleet summary + spindles +
// FFT) don't recompute the same signal. Keyed by bucket, pruned to the
// current and previous bucket.
const readingCache = new Map<string, LiveReading>();

function cacheKey(machineId: string, spindle: string, bucket: number): string {
  return `${machineId}|${spindle}|${bucket}`;
}

export function liveReading(
  store: Store,
  ctx: RequestContext,
  machine: MachineDoc,
  spindleIdx: number,
  bucket: number,
): LiveReading {
  const sid = spindleId(spindleIdx);
  const key = cacheKey(machine.machineId, sid, bucket);
  const hit = readingCache.get(key);
  if (hit) return hit;

  const eff = effectiveMachine(store, machine, ctx);
  const fault = faultForMachine(eff);
  const severity = severityForStatus(eff.status);
  const rng = rngFor(machine.machineId, sid, bucket);

  const signal = synthesizeSignal(fault, severity, SPINDLE_RPM, rng);
  let verdict = classifyDSP(signal, SPINDLE_RPM);
  const stats = signalStats(signal);
  // Amplitude gate: a quiet signal is healthy even when the 1x band
  // dominates (see HEALTHY_RMS_MAX in dsp.ts).
  if (stats.rms < HEALTHY_RMS_MAX) {
    verdict = {
      ...verdict,
      label: 'Healthy',
      anomaly: false,
      confidence: clamp(0.92 + (HEALTHY_RMS_MAX - stats.rms) * 0.1, 0.92, 0.99),
    };
  }
  const isCritical = eff.status === 'critical';
  const temperature = temperatureFromStats(stats.rms, stats.kurtosis, isCritical);
  const health = healthFromRms(stats.rms);
  const fft = computeFFTBins(signal, 4000, 128);
  const bpfo = bpfoScoreFromFft(fft, SPINDLE_RPM);
  const waveform: number[] = [];
  for (let i = 0; i < SIGNAL_LENGTH; i += 8) waveform.push(+signal[i].toFixed(4));

  const timestamp = new Date(bucket * TICK_MS).toISOString();
  const reading: LiveReading = {
    machineId: machine.machineId,
    spindleId: sid,
    nodeId: sid,
    location: machine.location,
    healthScore: health,
    anomalyScore: +bpfo.toFixed(3),
    anomalyFlag: verdict.anomaly,
    accel_x: +round(stats.rms * 0.75).toFixed(3),
    accel_y: +round(stats.rms * 0.85).toFixed(3),
    accel_z: +round(stats.rms).toFixed(3),
    rpm: SPINDLE_RPM,
    temperature: +round(temperature, 1).toFixed(1),
    // voltageNormalized — the seed readings sit at 220 V (mains).
    voltage: +round(220 + (rng() - 0.5) * 6 - bpfo * 8, 1).toFixed(1),
    acousticLevel: +round(stats.rms * 0.5 + 0.1).toFixed(3),
    mlLabel: verdict.label,
    mlConfidence: +verdict.confidence.toFixed(3),
    fft,
    waveform,
    timestamp,
    createdAt: timestamp,
  };

  // Prune stale buckets, then cache.
  if (readingCache.size > 400) {
    for (const k of [...readingCache.keys()]) {
      const b = Number(k.split('|')[2]);
      if (b < bucket - 1) readingCache.delete(k);
    }
  }
  readingCache.set(key, reading);
  return reading;
}

/** All 5 live spindle readings for a machine. */
export function liveSpindles(
  store: Store,
  ctx: RequestContext,
  machine: MachineDoc,
  bucket: number,
): LiveReading[] {
  const out: LiveReading[] = [];
  for (let i = 1; i <= SPINDLES_PER_MACHINE; i++) out.push(liveReading(store, ctx, machine, i, bucket));
  return out;
}

/** Machine health from the SN005 reading (last-write-wins, as original). */
export function machineHealth(
  store: Store,
  ctx: RequestContext,
  machine: MachineDoc,
  bucket: number,
): { healthScore: number; mlLabel: string; mlConfidence: number; rpm: number } {
  const r = liveReading(store, ctx, machine, SPINDLES_PER_MACHINE, bucket);
  return { healthScore: r.healthScore, mlLabel: r.mlLabel, mlConfidence: r.mlConfidence, rpm: r.rpm };
}

/** Machines visible to the caller (factory scoping, as the original). */
export function visibleMachines(store: Store, ctx: RequestContext): MachineDoc[] {
  if (!ctx.user) return store.seed.machines;
  return store.seed.machines.filter((m) => canSeeUnit(ctx.user!, m.factoryUnit));
}

export interface FleetSummary {
  totalMachines: number;
  criticalCount: number;
  avgHealthScore: number;
  alertsToday: number;
  sensorUptime: number;
}

/** Fleet summary — same shape as the original analytics route. Readings are
 *  always "fresh" (computed on demand), so sensor uptime is 100% whenever
 *  the simulator is running. */
export function fleetSummary(store: Store, ctx: RequestContext, bucket: number): FleetSummary {
  const machines = visibleMachines(store, ctx);
  let healthSum = 0;
  let healthCount = 0;
  let criticalCount = 0;
  for (const m of machines) {
    const eff = effectiveMachine(store, m, ctx);
    if (eff.status === 'critical') criticalCount += 1;
    for (const r of liveSpindles(store, ctx, m, bucket)) {
      healthSum += r.healthScore;
      healthCount += 1;
    }
  }
  const dayStart = startOfDay(ctx.now).getTime();
  const alertsToday = store.seed.alerts.filter((a) => {
    const eff = effectiveAlert(store, a, ctx);
    if (eff.status !== 'active' && eff.status !== 'acknowledged') return false;
    const machine = store.seed.machines.find((mm) => mm.machineId === a.machineId);
    if (machine && ctx.user && !canSeeUnit(ctx.user, machine.factoryUnit)) return false;
    return new Date(a.detectedAt).getTime() >= dayStart;
  }).length;

  return {
    totalMachines: machines.length,
    criticalCount,
    avgHealthScore: healthCount > 0 ? Math.round(healthSum / healthCount) : 0,
    alertsToday,
    sensorUptime: store.simRunning ? 100 : 0,
  };
}

/** Light history: synthesize + stats only (no FFT/classify) on a 10-minute
 *  grid. The grid is aligned to wall-clock 10-minute boundaries, so every
 *  machine's series shares the same timestamps and the dashboard's
 *  index-merge aligns. */
export function historySeries(
  store: Store,
  ctx: RequestContext,
  machine: MachineDoc,
  hours: number,
  now: Date,
): { time: string; value: number; temperature: number }[] {
  const eff = effectiveMachine(store, machine, ctx);
  const fault = faultForMachine(eff);
  const severity = severityForStatus(eff.status);
  const stepMs = 10 * 60_000;
  const end = Math.floor(now.getTime() / stepMs) * stepMs;
  const start = end - hours * 3600_000;
  const points: { time: string; value: number; temperature: number }[] = [];
  for (let t = start; t <= end; t += stepMs) {
    const rng = rngFor(machine.machineId, 'history', t);
    const signal = synthesizeSignal(fault, severity, SPINDLE_RPM, rng);
    const stats = signalStats(signal);
    const temp = temperatureFromStats(stats.rms, stats.kurtosis, eff.status === 'critical');
    const d = new Date(t);
    points.push({
      time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      value: +round(stats.rms).toFixed(3),
      temperature: +round(temp, 1).toFixed(1),
    });
  }
  return points;
}

/** Remaining-useful-life estimate — the original's model, returned as the
 *  bare 30-point array the Predictions page consumes: days 1–15 are
 *  historical daily scores, days 16–30 are a linear projection (slope
 *  clamped to [-1.2, 0] pts/day, health floored at 20). The frontend splits
 *  `day < 16` → history, `day >= 15` → projection. */
export function rulSeries(
  store: Store,
  ctx: RequestContext,
  machine: MachineDoc,
  bucket: number,
): { day: number; healthScore: number; projected: boolean }[] {
  const eff = effectiveMachine(store, machine, ctx);
  const healthNow = machineHealth(store, ctx, machine, bucket).healthScore;
  const decay = eff.status === 'critical' ? 1.2 : eff.status === 'warning' ? 0.6 : 0.2;
  const slope = -decay;

  const points: { day: number; healthScore: number; projected: boolean }[] = [];
  for (let i = 0; i < 15; i++) {
    points.push({
      day: i + 1,
      healthScore: clamp(Math.round(healthNow + decay * (14 - i)), 20, 100),
      projected: false,
    });
  }
  const lastHealth = points[points.length - 1].healthScore;
  for (let i = 1; i <= 15; i++) {
    points.push({
      day: 15 + i,
      healthScore: Math.max(20, Math.round(lastHealth + slope * i)),
      projected: true,
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Hardware simulator (1 Hz ring buffer) — deterministic port of
// HardwareSimulator.ts: 1440 RPM motor rig with a 420 s load cycle, every
// 4th cycle running ~12 C hotter. Frames are generated for the last 300 s
// on demand; manual/arduino frames appended at runtime merge in by time.
// ---------------------------------------------------------------------------

export interface HardwareFrame {
  rpm: number;
  temperature: number;
  motorSpeed: number;
  rpm_mean: number;
  rpm_std: number;
  temp_mean: number;
  temp_rate_of_change: number;
  rpm_temp_ratio: number;
  health_index: number;
  verdict: string;
  colour: string;
  source: string;
  timestamp: string;
}

function hardwareVerdict(temp: number, healthIndex: number): { verdict: string; colour: string; health_index: number } {
  if (temp > 60) return { verdict: 'BEARING FAULT / SEVERE', colour: 'red', health_index: 0 };
  if (healthIndex >= 0.7) return { verdict: 'HEALTHY', colour: 'green', health_index: healthIndex };
  if (healthIndex >= 0.35) return { verdict: 'WARNING / IMBALANCE', colour: 'yellow', health_index: healthIndex };
  return { verdict: 'BEARING FAULT / SEVERE', colour: 'red', health_index: healthIndex };
}

function hardwareSample(secondEpoch: number): { rpm: number; temperature: number } {
  const rng = rngFor('hw', secondEpoch);
  const tSec = secondEpoch;
  const cycle = Math.floor(tSec / 420);
  const hot = cycle % 4 === 3;
  const rpm = 1440 + 18 * Math.sin((2 * Math.PI * tSec) / 60) + gaussian(rng) * 4;
  // Original rig: temperature drifts 28–32.5 C over a 7-minute load cycle;
  // every 4th cycle runs ~12 C hotter.
  const temperature =
    30 + 2.5 * Math.sin((2 * Math.PI * tSec) / 420) + (hot ? 12 : 0) + gaussian(rng) * 0.8;
  return { rpm: +rpm.toFixed(1), temperature: +temperature.toFixed(1) };
}

export function hardwareFrames(store: Store, now: Date): HardwareFrame[] {
  const frames: HardwareFrame[] = [];
  const nowSec = Math.floor(now.getTime() / 1000);

  if (store.hardwareSimRunning) {
    const samples: { rpm: number; temperature: number; second: number }[] = [];
    for (let s = nowSec - 299; s <= nowSec; s++) {
      samples.push({ ...hardwareSample(s), second: s });
    }
    for (let i = 0; i < samples.length; i++) {
      const window = samples.slice(Math.max(0, i - 29), i + 1);
      const rpms = window.map((w) => w.rpm);
      const temps = window.map((w) => w.temperature);
      const rpmMean = rpms.reduce((a, b) => a + b, 0) / rpms.length;
      const rpmStd = Math.sqrt(rpms.reduce((a, b) => a + (b - rpmMean) ** 2, 0) / rpms.length);
      const tempMean = temps.reduce((a, b) => a + b, 0) / temps.length;
      const tempRate = window.length > 1 ? (temps[temps.length - 1] - temps[0]) / (window.length - 1) : 0;
      const cur = samples[i];
      const healthIndex = clamp(
        1 - Math.max(0, cur.temperature - 50) / 30 - Math.max(0, Math.abs(cur.rpm - 1440) - 30) / 100,
        0,
        1,
      );
      const v = hardwareVerdict(cur.temperature, healthIndex);
      frames.push({
        rpm: cur.rpm,
        temperature: cur.temperature,
        motorSpeed: cur.rpm,
        rpm_mean: +rpmMean.toFixed(1),
        rpm_std: +rpmStd.toFixed(2),
        temp_mean: +tempMean.toFixed(1),
        temp_rate_of_change: +tempRate.toFixed(3),
        rpm_temp_ratio: +(cur.rpm / Math.max(cur.temperature, 1)).toFixed(2),
        health_index: +v.health_index.toFixed(3),
        verdict: v.verdict,
        colour: v.colour,
        source: 'simulator',
        timestamp: new Date(cur.second * 1000).toISOString(),
      });
    }
  }

  // Merge runtime-appended frames (manual/arduino) by timestamp.
  const byTs = new Map<string, HardwareFrame>();
  for (const f of frames) byTs.set(f.timestamp, f);
  for (const f of store.hardwareFrames as HardwareFrame[]) byTs.set(f.timestamp, f);
  const merged = [...byTs.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return merged.slice(-300);
}

export function hardwareStream(store: Store, now: Date): Record<string, any> {
  const readings = hardwareFrames(store, now);
  const latest = readings.length > 0 ? readings[readings.length - 1] : null;
  const online =
    latest !== null && now.getTime() - new Date(latest.timestamp).getTime() < 3500;
  return {
    readings,
    latest,
    ingestCount: readings.length + store.hardwareIngestCount,
    lastIngestAt: latest ? latest.timestamp : store.lastIngestAt,
    online,
  };
}
