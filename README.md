# SmartBearing — serverless rebuild

SmartBearing is a rotating-machinery condition-monitoring dashboard for
textile MSMEs (hackathon Problem Statement 08): live vibration monitoring,
ML fault classification (Healthy / Imbalance / Misalignment / Ball /
Inner Race / Outer Race), alerts with evidence packs, a hardware rig lab,
and an operations view.

This repo is a **serverless rebuild** of
[`Vaishnav-Hub9/hackathon-vibration-monitor`](https://github.com/Vaishnav-Hub9/hackathon-vibration-monitor).
The original backend (Express + Socket.io + MongoDB on Render) is dead —
its Render API 404s — so the whole backend was re-implemented as a single
Vercel serverless function with deterministic simulation, and the frontend
polls it instead of using sockets.

## Layout

- `artifacts/smartbearing/` — the React + Vite app (Vercel project root)
  - `api/index.ts` — the entire backend: one catch-all serverless function
  - `api/_lib/` — auth (JWT), seed fleet, deterministic DSP simulation
    engine (ported from the original SensorSimulator), route handlers
  - `src/lib/serverless.ts` — the serverless-mode flag + demo-write
    overrides (fault injection / alert ack-resolve survive cold starts)
- `lib/api-client-react/` — workspace package the app depends on
- `artifacts/api-server/`, `artifacts/mockup-sandbox/`, `lib/*`,
  `scripts/` — `package.json` files only, kept so the frozen pnpm
  lockfile stays valid (their source is not used by this deployment)

## Deploy

Vercel project, root directory `artifacts/smartbearing`. The included
`vercel.json` wires `/api/*` to the serverless function and everything
else to the SPA. `.env.production` sets `VITE_SERVERLESS_MODE=true`.

## Demo logins

| Role | Email | Password |
|---|---|---|
| Maintenance Engineer | maintenance@smartbearing.com | Maintenance@123 |
| Admin | admin@smartbearing.com | Admin@123 |
| Factory Manager | manager@smartbearing.com | Manager@123 |
| Worker | worker@smartbearing.com | Worker@123 |
| Customer | customer@mangalyanarayana.com | Customer@123 |
| Operator | operator@smartbearing.com | Operator@123 |

Fleet Overview is at `/fleet`; the role landing page is at `/dashboard`.

## Notes

- Live sensor data is computed deterministically from the current time
  (seeded PRNG per machine/spindle/3.5 s tick), so every function
  instance agrees without a database. Writes (ack/resolve, fault
  injection, captures, incidents) live in memory while an instance is
  warm; the frontend also echoes demo writes back as request headers.
- Classification runs in-process with the DSP band-energy classifier —
  the same fallback the original simulator used when its Python ML server
  was down. `GET /api/ml/analysis` serves real metrics precomputed from
  the trained GradientBoosting model (`smartline_final.pkl`, accuracy
  0.995).
- Health scores are derived from vibration severity (RMS), calibrated to
  the seed baselines (healthy ~92, warning ~66, critical ~34); the
  original's confidence-based formula collapsed every fault to ~10,
  contradicting its own seed data.
- The phone capture PWA lives at `/capture/`.
