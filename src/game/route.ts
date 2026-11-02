/** Valley main: Briar Yard to Tidewater, beside a November river. */

export const MILE = 1609.344;

export type Sample = {
  d: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  grade: number;
  curv: number;
  limit: number;
  rx: number;
  rz: number;
};

export type SignalDef = { d: number; name: string; meet: boolean };

function smoother(z: number, a: number, b: number) {
  if (z <= a) return 0;
  if (z >= b) return 1;
  const t = (z - a) / (b - a);
  return t * t * (3 - 2 * t);
}

function rawX(z: number) {
  const s = z / 7600;
  const curve = Math.sin(s * Math.PI * 1.05) * 380 + Math.sin(s * Math.PI * 2.35 + 0.45) * 95;
  return curve * smoother(z, 480, 980);
}

function rawY(z: number) {
  const keys: [number, number][] = [
    [0, 17],
    [900, 16.5],
    [1750, 12.2],
    [2650, 12.4],
    [5200, 46],
    [5900, 45],
    [7600, 11],
  ];
  if (z <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [z0, y0] = keys[i - 1];
    const [z1, y1] = keys[i];
    if (z <= z1) {
      const t = smoother(z, z0, z1);
      return y0 + (y1 - y0) * t;
    }
  }
  return keys[keys.length - 1][1];
}

function limitFor(d: number, len: number) {
  const mile = d / MILE;
  if (mile < 0.32) return 15;
  if (mile < 0.55) return 25;
  let lim = 45;
  if (d > len * 0.36 && d < len * 0.74) lim = 30;
  if (Math.abs(d / len - 0.22) < 0.025) lim = Math.min(lim, 25);
  if (d > len * 0.27 && d < len * 0.36) lim = Math.min(lim, 30);
  if (Math.abs(d / len - 0.7) < 0.03) lim = Math.min(lim, 25);
  if (d > len * 0.9) lim = 15;
  if (d > len * 0.96) lim = 10;
  return lim;
}

function buildSamples(): Sample[] {
  const raw: { x: number; y: number; z: number }[] = [];
  const steps = 2800;
  const zMax = 7600;
  for (let i = 0; i <= steps; i++) {
    const z = (i / steps) * zMax;
    raw.push({ x: rawX(z), y: rawY(z), z });
  }
  const dist = [0];
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1];
    const b = raw[i];
    dist.push(dist[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  const total = dist[dist.length - 1];
  const step = 2;
  const pts: { d: number; x: number; y: number; z: number }[] = [];
  let j = 0;
  for (let d = 0; d <= total; d += step) {
    while (j < dist.length - 2 && dist[j + 1] < d) j++;
    const span = dist[j + 1] - dist[j] || 1;
    const u = (d - dist[j]) / span;
    const a = raw[j];
    const b = raw[j + 1];
    pts.push({
      d,
      x: a.x + (b.x - a.x) * u,
      y: a.y + (b.y - a.y) * u,
      z: a.z + (b.z - a.z) * u,
    });
  }
  const out: Sample[] = [];
  let yawUnwrapped = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const n = pts[Math.min(pts.length - 1, i + 1)];
    const prev = pts[Math.max(0, i - 1)];
    const dx = n.x - p.x;
    const dz = n.z - p.z;
    const yaw = Math.atan2(-dx, -dz);
    if (i === 0) yawUnwrapped = yaw;
    else {
      let delta = yaw - (yawUnwrapped % (Math.PI * 2));
      // compare against principal of current unwrapped
      const base = Math.atan2(Math.sin(yawUnwrapped), Math.cos(yawUnwrapped));
      delta = yaw - base;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      yawUnwrapped += delta;
    }
    const ds = n.d - prev.d || 1;
    const grade = (n.y - prev.y) / ds;
    out.push({
      d: p.d,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: yawUnwrapped,
      grade,
      curv: 0,
      limit: 45,
      rx: Math.cos(yawUnwrapped),
      rz: -Math.sin(yawUnwrapped),
    });
  }
  for (let i = 1; i < out.length - 1; i++) {
    const ds = out[i + 1].d - out[i - 1].d || 1;
    out[i].curv = (out[i + 1].yaw - out[i - 1].yaw) / ds;
  }
  const len = out[out.length - 1].d;
  for (const s of out) s.limit = limitFor(s.d, len);
  return out;
}

export const SAMPLES: Sample[] = buildSamples();
export const ROUTE_LEN = SAMPLES[SAMPLES.length - 1].d;

export function dAtZ(z: number): number {
  let best = SAMPLES[0];
  let bestAbs = Infinity;
  // z is monotonic — binary search
  let lo = 0;
  let hi = SAMPLES.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (SAMPLES[mid].z < z) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(0, lo);
  best = SAMPLES[i];
  if (i > 0 && Math.abs(SAMPLES[i - 1].z - z) < Math.abs(best.z - z)) best = SAMPLES[i - 1];
  bestAbs = Math.abs(best.z - z);
  void bestAbs;
  return best.d;
}

export const MARK = {
  start: dAtZ(70),
  yardSpot: dAtZ(320),
  yardEnd: dAtZ(620),
  mill: dAtZ(1680),
  ferryStop: dAtZ(2140),
  ferrySignal: dAtZ(2280),
  hale: dAtZ(5450),
  tide: dAtZ(7050),
};

export const BRIDGE = { d0: dAtZ(2060), d1: dAtZ(2520) };

export const SIGNALS: SignalDef[] = [
  { d: dAtZ(980), name: "Yard Limit", meet: false },
  { d: dAtZ(1500), name: "Mill River", meet: false },
  { d: MARK.ferrySignal, name: "East Ferry", meet: true },
  { d: dAtZ(3400), name: "Block 34", meet: false },
  { d: dAtZ(4100), name: "Summit Approach", meet: false },
  { d: dAtZ(4700), name: "Summit", meet: false },
  { d: dAtZ(5600), name: "Hale", meet: false },
  { d: dAtZ(6600), name: "Tidewater Approach", meet: false },
];

function lerp(a: Sample, b: Sample, u: number): Sample {
  const yaw = a.yaw + (b.yaw - a.yaw) * u;
  return {
    d: a.d + (b.d - a.d) * u,
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    z: a.z + (b.z - a.z) * u,
    yaw,
    grade: a.grade + (b.grade - a.grade) * u,
    curv: a.curv + (b.curv - a.curv) * u,
    limit: Math.min(a.limit, b.limit),
    rx: Math.cos(yaw),
    rz: -Math.sin(yaw),
  };
}

export function sampleAt(d: number): Sample {
  const a = SAMPLES;
  if (d <= a[0].d) return a[0];
  if (d >= a[a.length - 1].d) return a[a.length - 1];
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid].d < d) lo = mid;
    else hi = mid;
  }
  const span = a[hi].d - a[lo].d || 1;
  const u = (d - a[lo].d) / span;
  return lerp(a[lo], a[hi], u);
}
