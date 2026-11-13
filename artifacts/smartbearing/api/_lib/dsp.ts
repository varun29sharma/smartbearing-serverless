// Deterministic signal DSP — ported from the original api-server:
//   * SensorSimulator.ts  (synthesizeSignal, classifyDSP, faultForMachine)
//   * lib/fft.ts          (FFT helpers, in ./fft.ts)
//   * lib/prevention.ts   (per-fault prevention tips)
//   * routes/ingest.ts    (kurtosis, evidence packs)
//   * lib/datasetAugmentation.ts (CWRU fallback tables for phone captures)
//
// The only deliberate difference from the original: Math.random is replaced
// by a seeded RNG passed in by the caller, so the same (machine, spindle,
// time-bucket) always produces the same reading on every function instance.

import { computeFFTBins, fftMagnitudeSpectrum } from './fft.js';
import { clamp, gaussian } from './util.js';

export const SAMPLE_RATE = 4000; // Hz — original simulator sample rate
export const SIGNAL_LENGTH = 2048;
export const SPINDLE_RPM = 14400;

export type FaultLabel =
  | 'Healthy'
  | 'Imbalance'
  | 'Misalignment'
  | 'Ball'
  | 'Inner Race'
  | 'Outer Race';

export type Severity = 'healthy' | 'degrading' | 'warning' | 'critical';

export interface DefectFrequencies {
  fr: number;
  bpfo: number;
  bpfi: number;
  bsf: number;
  ftf: number;
}

// 6205 bearing geometry (9 balls, 39.04 mm pitch diameter, 7.94 mm ball).
export const BEARING_GEOMETRY = {
  balls: 9,
  pitchDiameterMm: 39.04,
  ballDiameterMm: 7.94,
};

export function defectFrequencies(rpm: number): DefectFrequencies {
  const fr = rpm / 60;
  const d = BEARING_GEOMETRY.ballDiameterMm / BEARING_GEOMETRY.pitchDiameterMm;
  return {
    fr,
    bpfo: (BEARING_GEOMETRY.balls / 2) * fr * (1 - d),
    bpfi: (BEARING_GEOMETRY.balls / 2) * fr * (1 + d),
    bsf: (BEARING_GEOMETRY.pitchDiameterMm / (2 * BEARING_GEOMETRY.ballDiameterMm)) * fr * (1 - d * d),
    ftf: (fr / 2) * (1 - d),
  };
}

export const FAULT_FREQS: Record<FaultLabel, keyof DefectFrequencies> = {
  Healthy: 'fr',
  Imbalance: 'fr',
  Misalignment: 'fr',
  Ball: 'bsf',
  'Inner Race': 'bpfi',
  'Outer Race': 'bpfo',
};

/** Fault tones + broadband noise, 2048 samples. `rand` is a seeded RNG. */
export function synthesizeSignal(
  faultLabel: FaultLabel,
  severity: Severity,
  rpm: number,
  rand: () => number,
): number[] {
  const n = SIGNAL_LENGTH;
  const signal = new Array<number>(n);
  const df = defectFrequencies(rpm);
  const faultFreq = df[FAULT_FREQS[faultLabel]];

  const amplitude =
    severity === 'critical' ? 2.2 : severity === 'warning' ? 1.2 : severity === 'degrading' ? 0.9 : 0.6;
  const harmonics = faultLabel === 'Healthy' ? 2 : 5;
  const noiseStd = severity === 'critical' ? 0.45 : severity === 'warning' ? 0.3 : 0.22;

  const phases = Array.from({ length: harmonics }, () => rand() * Math.PI);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    let value = 0;
    for (let h = 1; h <= harmonics; h++) {
      const freq = faultFreq * h;
      const harmAmp = amplitude / (faultLabel === 'Healthy' && h > 1 ? 1.3 : h);
      value += harmAmp * Math.sin(2 * Math.PI * freq * t + phases[h - 1]);
    }
    if (faultLabel === 'Imbalance') value += 0.5 * Math.sin(2 * Math.PI * df.fr * t);
    if (faultLabel === 'Misalignment') value += 0.4 * Math.sin(2 * Math.PI * 2 * df.fr * t);
    value += gaussian(rand) * noiseStd;
    signal[i] = value;
  }
  return signal;
}

export interface SignalStats {
  rms: number;
  kurtosis: number;
  peak: number;
  crestFactor: number;
  mean: number;
}

export function signalStats(signal: number[] | Float64Array): SignalStats {
  const n = signal.length;
  let sum = 0;
  let sumSq = 0;
  let peak = 0;
  for (const v of signal) {
    sum += v;
    sumSq += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  const std = Math.sqrt(Math.max(variance, 0));
  let m4 = 0;
  for (const v of signal) {
    const d = v - mean;
    m4 += d * d * d * d;
  }
  m4 /= n;
  const kurtosis = std > 0 ? m4 / (std * std * std * std) : 3;
  const rms = Math.sqrt(sumSq / n);
  const crestFactor = rms > 0 ? peak / rms : 0;
  return { rms, kurtosis, peak, crestFactor, mean };
}

/** Kurtosis of a raw signal — the standalone helper from routes/ingest.ts. */
export function kurtosisOf(signal: number[]): number {
  const n = signal.length;
  const mean = signal.reduce((a, b) => a + b, 0) / n;
  const varSum = signal.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
  const m4 = signal.reduce((acc, v) => acc + (v - mean) ** 4, 0) / n;
  const sd = Math.sqrt(varSum);
  return sd === 0 ? 3 : m4 / sd ** 4;
}

export interface DspVerdict {
  label: FaultLabel;
  confidence: number;
  anomaly: boolean;
  scores: Record<string, number>;
  ratios: Record<string, number>;
}

/** Band-energy classifier — the same DSP fallback the original simulator
 *  uses when its Python ML server is down. In the serverless backend this
 *  IS the classifier (it runs in-process, so it is never down). */
export function classifyDSP(signal: number[], rpm: number, sampleRate = SAMPLE_RATE): DspVerdict {
  const mags = fftMagnitudeSpectrum(signal);
  const df = defectFrequencies(rpm);
  const nyquist = sampleRate / 2;
  const binHz = nyquist / mags.length;

  const bandEnergy = (center: number, tolFrac: number): number => {
    let energy = 0;
    for (let i = 0; i < mags.length; i++) {
      const f = i * binHz;
      if (Math.abs(f - center) <= center * tolFrac) energy += mags[i] ** 2;
    }
    return energy;
  };
  const totalEnergy = mags.reduce((a, b) => a + b * b, 0) || 1;

  const bands: Record<string, number> = {
    fr: 0,
    '2fr': 0,
    bpfo: 0,
    bpfi: 0,
    bsf: 0,
  };
  for (let h = 1; h <= 3; h++) {
    bands.fr += bandEnergy(df.fr * h, 0.08) / (h * h);
    bands['2fr'] += bandEnergy(2 * df.fr * h, 0.08) / (h * h);
    bands.bpfo += bandEnergy(df.bpfo * h, 0.08) / (h * h);
    bands.bpfi += bandEnergy(df.bpfi * h, 0.08) / (h * h);
    bands.bsf += bandEnergy(df.bsf * h, 0.08) / (h * h);
  }

  const ratios: Record<string, number> = {};
  let top = 'fr';
  let topRatio = 0;
  for (const [k, v] of Object.entries(bands)) {
    ratios[k] = v / totalEnergy;
    if (ratios[k] > topRatio) {
      topRatio = ratios[k];
      top = k;
    }
  }

  let label: FaultLabel = 'Healthy';
  let confidence = 0.95;
  const anomaly = topRatio >= 0.28;

  if (anomaly) {
    if (top === 'bpfo') label = 'Outer Race';
    else if (top === 'bpfi') label = 'Inner Race';
    else if (top === 'bsf') label = 'Ball';
    else if (top === '2fr') label = 'Misalignment';
    else label = 'Imbalance';
    confidence = clamp(0.6 + topRatio * 0.55, 0.6, 0.97);
  } else {
    confidence = clamp(0.92 + (0.28 - topRatio), 0.92, 0.99);
  }

  return { label, confidence, anomaly, scores: bands, ratios };
}

/** BPFO band (±20%) energy ratio from a 128-bin FFT — the bpfoScore the
 *  dashboard's health cards and alert evidence packs read. */
export function bpfoScoreFromFft(fft: { freq: number; amplitude: number }[], rpm: number): number {
  const df = defectFrequencies(rpm);
  let total = 0;
  let bpfo = 0;
  for (const b of fft) {
    const e = b.amplitude * b.amplitude;
    total += e;
    if (Math.abs(b.freq - df.bpfo) <= df.bpfo * 0.2) bpfo += e;
  }
  return total > 0 ? bpfo / total : 0;
}

/** Temperature model from the original simulator (not a sensor — derived
 *  from vibration statistics). */
export function temperatureFromStats(rms: number, kurtosis: number, isCritical: boolean): number {
  return 30 + rms * 8 + (kurtosis > 3.2 ? 4 : 0) + (isCritical ? 8 : 0);
}

/** The original's health formula (confidence-based), kept for phone/edge
 *  captures, where the signal scale is unknown: an anomalous reading
 *  scores 100 - confidence*100, a healthy one confidence*100. */
export function healthFromVerdict(v: DspVerdict): number {
  if (v.anomaly) return Math.max(10, Math.round(100 - v.confidence * 100));
  return Math.min(100, Math.round(v.confidence * 100));
}

/** RMS threshold separating the simulator's healthy signals (rms ~0.58)
 *  from its faulty ones (warning ~1.07, critical ~1.93). The pure
 *  band-ratio classifier labels a healthy 1x-dominant signal as Imbalance,
 *  so the simulator gates on amplitude first: a quiet signal is healthy
 *  no matter which band dominates. Calibrated for the simulator's signal
 *  scale only — phone/edge captures use classifyDSP as-is. */
export const HEALTHY_RMS_MAX = 0.85;

/** Health from vibration severity (RMS), calibrated so the simulator's
 *  synthesized signals land near the seed baselines the demo was built
 *  around (healthy ~92, warning ~66, critical ~34). The original's
 *  confidence-based formula collapses every fault to ~10, which
 *  contradicts its own seed data, so the simulator uses severity instead. */
export function healthFromRms(rms: number): number {
  return clamp(Math.round(104 - 35 * rms), 10, 98);
}

export const PREVENTION_TIPS: Record<FaultLabel, string[]> = {
  'Outer Race': [
    'Replace bearing before scheduled maintenance to prevent catastrophic failure.',
    'Inspect housing fit and lubrication quality after replacement.',
    'Reduce radial load if possible until bearing is swapped.',
  ],
  'Inner Race': [
    'Check shaft fit and mounting torque; schedule bearing replacement.',
    'Verify lubrication and inspect for contamination.',
    'Monitor closely — inner race faults escalate faster than outer race.',
  ],
  Ball: [
    'Inspect rolling elements for spalling; replace bearing if pitting is visible.',
    'Check lubrication and contamination; re-grease with specified grease.',
    'Avoid shock loads until the bearing is replaced.',
  ],
  Imbalance: [
    'Balance the rotor in two planes to ISO 1940 G2.5 or better.',
    'Check for uneven loading, buildup, or a loose rotor component.',
    'Re-check alignment after balancing.',
  ],
  Misalignment: [
    'Realign the coupling with a dial indicator or laser tool.',
    'Check for soft foot and pipe strain before final alignment.',
    'Verify bearing seating after realignment.',
  ],
  Healthy: ['No action needed. Continue routine monitoring.'],
};

export function getPreventionTips(faultLabel: FaultLabel): string[] {
  return PREVENTION_TIPS[faultLabel] ?? PREVENTION_TIPS.Healthy;
}

/** Evidence pack for an alert — same shape as routes/ingest.ts. */
export function buildEvidence(
  label: FaultLabel,
  confidence: number,
  fft: { freq: number; amplitude: number }[],
  rpm: number,
  rms: number,
  kurtosis: number,
  peakAbs: number,
): Record<string, any> {
  const df = defectFrequencies(rpm);
  const dominant = fft.reduce(
    (best, b) => (b.amplitude > best.amplitude ? b : best),
    { freq: 0, amplitude: 0 },
  );
  const peaks = [...fft]
    .sort((a, b) => b.amplitude - a.amplitude)
    .slice(0, 5)
    .map((p) => ({ freq: p.freq, amplitude: +p.amplitude.toFixed(3) }));
  return {
    label,
    confidence: +confidence.toFixed(3),
    dominantFreq: dominant.freq,
    rpm,
    peaks,
    features: { rms: +rms.toFixed(3), kurtosis: +kurtosis.toFixed(3), crestFactor: +(peakAbs / Math.max(rms, 0.001)).toFixed(3) },
    defectFrequencies: {
      fr: +df.fr.toFixed(2),
      bpfo: +df.bpfo.toFixed(2),
      bpfi: +df.bpfi.toFixed(2),
      bsf: +df.bsf.toFixed(2),
      ftf: +df.ftf.toFixed(2),
    },
  };
}

// ---------------------------------------------------------------------------
// CWRU fallback table for phone captures (lib/datasetAugmentation.ts).
// Used when a capture arrives without temperature/voltage, so the UI still
// gets plausible sensor context.
// ---------------------------------------------------------------------------
export const CWRU_BASELINE: Record<FaultLabel, { temp: number; voltage: number }> = {
  Healthy: { temp: 42, voltage: 3.3 },
  Ball: { temp: 52, voltage: 3.1 },
  'Inner Race': { temp: 58, voltage: 2.9 },
  'Outer Race': { temp: 56, voltage: 3.0 },
  Imbalance: { temp: 48, voltage: 3.2 },
  Misalignment: { temp: 50, voltage: 3.1 },
};

export const CWRU_SEVERITY: Record<string, { tempDelta: number; voltageDelta: number }> = {
  '0.007': { tempDelta: 2, voltageDelta: -0.05 },
  '0.014': { tempDelta: 5, voltageDelta: -0.12 },
  '0.021': { tempDelta: 9, voltageDelta: -0.2 },
};

export function cwruFallback(
  label: FaultLabel,
  severityIn: string | undefined,
  rand: () => number,
): { temperature: number; voltage: number } {
  const base = CWRU_BASELINE[label] ?? CWRU_BASELINE.Healthy;
  const sev = CWRU_SEVERITY[severityIn ?? ''] ?? { tempDelta: 0, voltageDelta: 0 };
  return {
    temperature: +(base.temp + sev.tempDelta + (rand() - 0.5) * 4).toFixed(1),
    voltage: +(base.voltage + sev.voltageDelta + (rand() - 0.5) * 0.1).toFixed(2),
  };
}

/** The fault a machine's simulator should synthesize, from its status +
 *  fault profile — ported from SensorSimulator.faultForMachine. */
export function faultForMachine(machine: { status: string; faultProfile?: string | null; machineId: string }): FaultLabel {
  if (machine.faultProfile) return machine.faultProfile as FaultLabel;
  if (machine.status === 'critical') return 'Outer Race';
  if (machine.status === 'warning') {
    if (machine.machineId === 'M002') return 'Imbalance';
    if (machine.machineId === 'M006') return 'Misalignment';
    return 'Ball';
  }
  return 'Healthy';
}

export function severityForStatus(status: string): Severity {
  if (status === 'critical') return 'critical';
  if (status === 'warning') return 'warning';
  if (status === 'degrading') return 'degrading';
  return 'healthy';
}
