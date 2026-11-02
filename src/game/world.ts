import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Sky } from "three/addons/objects/Sky.js";
import {
  jobById,
  loadCareer,
  locoById,
  settle,
  type CarKind,
  type Job,
  type Loco,
  type Report,
  type RunResult,
  type TimeOfDay,
} from "./career";
import { BRIDGE, MARK, MILE, ROUTE_LEN, SAMPLES, SIGNALS, sampleAt, type Sample } from "./route";

export type CameraMode = "chase" | "cab" | "hood" | "railfan";
export type HoldName = "notchUp" | "notchDown" | "brake" | "release" | "horn";
export type Aspect = "clear" | "approach" | "stop" | "none";

export type Hud = {
  running: boolean;
  ready: boolean;
  speedMph: number;
  limitMph: number;
  notch: number;
  pipe: number;
  cyl: number;
  mile: number;
  gradePct: number;
  aspect: Aspect;
  signalName: string;
  signalMi: number;
  nextStop: string;
  nextStopMi: number;
  order: string;
  fuel: number;
  clock: string;
  loco: string;
  tons: number;
  cars: number;
  camera: CameraMode;
  lights: boolean;
  muted: boolean;
  overspeed: boolean;
  radio: string;
  warning: string;
  job: string;
};

export type GameHooks = {
  onHud: (hud: Hud) => void;
  onReport: (report: Report) => void;
};

export type GameHandle = {
  destroy: () => void;
  start: (jobId: string) => void;
  preview: (jobId: string) => void;
  cutOff: () => void;
  setHeld: (name: HoldName, down: boolean) => void;
  cycleCamera: () => void;
  toggleLights: () => void;
  toggleMute: () => void;
  emergency: () => void;
  unlock: () => void;
};

type StopState = {
  d: number;
  name: string;
  hold: number;
  kind: "station" | "meet" | "terminal";
  dwell: number;
  done: boolean;
  missed: boolean;
  rough: boolean;
  seen: boolean;
};

type Unit = {
  group: THREE.Group;
  wheels: THREE.Object3D[];
  offset: number;
};

declare global {
  interface Window {
    __controlsTest?: {
      getYaw: () => number;
      getSpeed: () => number;
      getOrbitYaw?: () => number;
      getZoom?: () => number;
      setKeys: (codes: string[]) => void;
      setSteer: (v: number) => void;
    };
    __vdReady?: boolean;
  }
}

const TE_SCALE = 2.55;

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0 || 1)));
  return t * t * (3 - 2 * t);
}

function hash2(ix: number, iz: number) {
  const n = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function vnoise(x: number, z: number) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function fbm(x: number, z: number) {
  let amp = 0;
  let f = 1;
  let w = 0.55;
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    amp += vnoise(x * f, z * f) * w;
    sum += w;
    f *= 2.07;
    w *= 0.5;
  }
  return amp / sum;
}

function nearestSample(x: number, z: number): Sample {
  let lo = 0;
  let hi = SAMPLES.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (SAMPLES[mid].z < z) lo = mid + 1;
    else hi = mid;
  }
  let best = lo;
  let bestD = Infinity;
  const a = Math.max(0, lo - 50);
  const b = Math.min(SAMPLES.length - 1, lo + 50);
  for (let i = a; i <= b; i++) {
    const s = SAMPLES[i];
    const dd = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
    if (dd < bestD) {
      bestD = dd;
      best = i;
    }
  }
  return SAMPLES[best];
}

type River = { x: number; z: number; level: number; half: number; d: number };

function riverPoint(s: Sample): River {
  let off = 160 + Math.sin(s.z * 0.001) * 74;
  let pinch = 0;
  if (s.z > 1860 && s.z < 2800) {
    const u = (s.z - 1860) / 940;
    pinch = Math.sin(Math.max(0, Math.min(1, u)) * Math.PI);
    off *= 1 - pinch;
  }
  const half = 17 + pinch * 22;
  const level = pinch > 0.42 ? s.y - 7.8 : Math.min(s.y - 3.5, 6.4);
  return { x: s.x + s.rx * off, z: s.z + s.rz * off, level, half, d: s.d };
}

class DieselAudio {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  rumble: OscillatorNode | null = null;
  rumbleGain: GainNode | null = null;
  lfo: OscillatorNode | null = null;
  lfoDepth: GainNode | null = null;
  exhaustFilter: BiquadFilterNode | null = null;
  exhaustGain: GainNode | null = null;
  bedGain: GainNode | null = null;
  noise: AudioBuffer | null = null;
  hissGain: GainNode | null = null;
  horn: OscillatorNode[] = [];
  hornGain: GainNode | null = null;
  muted = false;
  hornOn = false;

  unlock() {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      const master = ctx.createGain();
      master.gain.value = 0.8;
      master.connect(ctx.destination);

      const len = ctx.sampleRate * 1;
      const noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

      // Low prime-mover body. Pitch barely moves — a locomotive does not spool with road speed.
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 130;
      filter.Q.value = 0.5;
      const rumble = ctx.createOscillator();
      rumble.type = "square";
      rumble.frequency.value = 46;
      const rumbleGain = ctx.createGain();
      rumbleGain.gain.value = 0.0001;
      rumble.connect(filter);
      filter.connect(rumbleGain);
      rumbleGain.connect(master);
      rumble.start();

      // Exhaust rasp, gently loped. Notch sets the lope, not the train's speed.
      const exhaust = ctx.createBufferSource();
      exhaust.buffer = noise;
      exhaust.loop = true;
      const exhaustFilter = ctx.createBiquadFilter();
      exhaustFilter.type = "bandpass";
      exhaustFilter.frequency.value = 170;
      exhaustFilter.Q.value = 0.7;
      const exhaustGain = ctx.createGain();
      exhaustGain.gain.value = 0.0001;
      exhaust.connect(exhaustFilter);
      exhaustFilter.connect(exhaustGain);
      exhaustGain.connect(master);
      exhaust.start();

      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 7.4;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.0001;
      lfo.connect(lfoDepth);
      lfoDepth.connect(exhaustGain.gain);
      lfo.start();

      const bed = ctx.createBufferSource();
      bed.buffer = noise;
      bed.loop = true;
      const bedFilter = ctx.createBiquadFilter();
      bedFilter.type = "lowpass";
      bedFilter.frequency.value = 240;
      const bedGain = ctx.createGain();
      bedGain.gain.value = 0.0001;
      bed.connect(bedFilter);
      bedFilter.connect(bedGain);
      bedGain.connect(master);
      bed.start();

      const hissGain = ctx.createGain();
      hissGain.gain.value = 0.0001;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const band = ctx.createBiquadFilter();
      band.type = "highpass";
      band.frequency.value = 1400;
      src.connect(band);
      band.connect(hissGain);
      hissGain.connect(master);
      src.start();

      const hornGain = ctx.createGain();
      hornGain.gain.value = 0.0001;
      hornGain.connect(master);
      this.ctx = ctx;
      this.master = master;
      this.rumble = rumble;
      this.rumbleGain = rumbleGain;
      this.lfo = lfo;
      this.lfoDepth = lfoDepth;
      this.exhaustFilter = exhaustFilter;
      this.exhaustGain = exhaustGain;
      this.bedGain = bedGain;
      this.noise = noise;
      this.hissGain = hissGain;
      this.hornGain = hornGain;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.03);
    }
  }

  update(notch: number, speed: number, horn: boolean, cylRate: number) {
    if (!this.ctx || !this.rumble || !this.rumbleGain || !this.hissGain || !this.hornGain || !this.lfo || !this.lfoDepth || !this.exhaustGain || !this.exhaustFilter || !this.bedGain) return;
    const t = this.ctx.currentTime;
    const n = Math.max(0, notch);
    // EMD-style: idle lope near 7 Hz, run-8 nearer 16. Road speed does not change rpm.
    this.lfo.frequency.setTargetAtTime(7.2 + n * 1.15, t, 0.45);
    this.rumble.frequency.setTargetAtTime(44 + n * 2.2, t, 0.5);
    this.exhaustFilter.frequency.setTargetAtTime(150 + n * 18, t, 0.4);
    const silent = this.muted;
    this.rumbleGain.gain.setTargetAtTime(silent ? 0 : 0.014 + n * 0.005, t, 0.15);
    this.exhaustGain.gain.setTargetAtTime(silent ? 0 : 0.016 + n * 0.006, t, 0.15);
    this.lfoDepth.gain.setTargetAtTime(silent ? 0 : 0.007 + n * 0.0035, t, 0.15);
    const roll = Math.min(0.012, Math.abs(speed) * 0.00035);
    this.bedGain.gain.setTargetAtTime(silent ? 0 : 0.007 + n * 0.002 + roll, t, 0.2);
    const hiss = silent ? 0 : Math.max(0, Math.min(0.06, cylRate * 0.04));
    this.hissGain.gain.setTargetAtTime(hiss, t, 0.05);
    if (horn && !this.hornOn) {
      this.hornOn = true;
      this.stopHorn();
      for (const freq of [311, 370, 466]) {
        const o = this.ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = freq;
        const f = this.ctx.createBiquadFilter();
        f.type = "lowpass";
        f.frequency.value = 1600;
        o.connect(f);
        f.connect(this.hornGain);
        o.start();
        this.horn.push(o);
      }
      this.hornGain.gain.setTargetAtTime(this.muted ? 0 : 0.06, t, 0.02);
    } else if (!horn && this.hornOn) {
      this.hornOn = false;
      this.hornGain.gain.setTargetAtTime(0.0001, t, 0.04);
      const old = this.horn;
      this.horn = [];
      window.setTimeout(() => old.forEach((o) => o.stop()), 180);
    }
  }

  clack(speed: number) {
    if (!this.ctx || !this.noise || !this.master || this.muted || speed < 2) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const g = this.ctx.createGain();
    const f = this.ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 420;
    g.gain.value = Math.min(0.05, speed * 0.0015);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start();
    src.stop(this.ctx.currentTime + 0.045);
  }

  private stopHorn() {
    for (const o of this.horn) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
    }
    this.horn = [];
  }

  dispose() {
    this.stopHorn();
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
  }
}

function clockLabel(startMin: number, elapsed: number) {
  const m = Math.floor((startMin + elapsed / 60) % (24 * 60));
  const hh = Math.floor(m / 60);
  const mm = Math.floor(m % 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function putBox(list: THREE.BufferGeometry[], w: number, h: number, d: number, x: number, y: number, z: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  list.push(g);
}

function merge(list: THREE.BufferGeometry[]) {
  const g = mergeGeometries(list, false);
  if (!g) throw new Error("geometry merge failed");
  return g;
}

export function mountGame(canvas: HTMLCanvasElement, hooks: GameHooks): GameHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 1, 0.25, 18000);
  scene.fog = new THREE.FogExp2(0xd2c3ae, 0.00042);

  const sky = new Sky();
  sky.scale.setScalar(6000);
  scene.add(sky);
  const sunDir = new THREE.Vector3();
  const hemi = new THREE.HemisphereLight(0xc5d0dc, 0x6a5b42, 0.72);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffd2a8, 3.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.04;
  const sCam = sun.shadow.camera as THREE.OrthographicCamera;
  sCam.near = 8;
  sCam.far = 260;
  sCam.left = -75;
  sCam.right = 75;
  sCam.top = 75;
  sCam.bottom = -75;
  scene.add(sun);
  scene.add(sun.target);

  const loader = new THREE.TextureLoader();
  const loadTex = (url: string) => {
    const t = loader.load(url);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  const grassMap = loadTex("/textures/grass.jpg");
  const litterMap = loadTex("/textures/litter.jpg");
  const rockMap = loadTex("/textures/rock.jpg");
  const ballastMap = loadTex("/textures/ballast.jpg");
  ballastMap.repeat.set(1, 1);
  const waterMap = loadTex("/textures/water.jpg");

  const grassMat = new THREE.MeshStandardMaterial({
    map: grassMap,
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
  });
  const ballastMat = new THREE.MeshStandardMaterial({
    map: ballastMap,
    color: 0xd5cfc4,
    roughness: 0.98,
    metalness: 0.02,
  });
  const railMat = new THREE.MeshStandardMaterial({ color: 0x8d9498, metalness: 0.86, roughness: 0.34 });
  const tieMat = new THREE.MeshStandardMaterial({ color: 0x5c4636, roughness: 0.92 });
  const waterMat = new THREE.MeshStandardMaterial({
    map: waterMap,
    color: 0x8fb8b4,
    roughness: 0.18,
    metalness: 0.45,
    transparent: true,
    opacity: 0.94,
  });
  const paint = new THREE.MeshStandardMaterial({ color: 0x1c4032, roughness: 0.48, metalness: 0.14 });
  const cream = new THREE.MeshStandardMaterial({ color: 0xe6e0d2, roughness: 0.52, metalness: 0.04 });
  const black = new THREE.MeshStandardMaterial({ color: 0x17191b, roughness: 0.64, metalness: 0.22 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xa0a8ac, roughness: 0.32, metalness: 0.8 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0xa9c0c6,
    roughness: 0.06,
    metalness: 0.2,
    transparent: true,
    opacity: 0.5,
  });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x2c2e30, roughness: 0.5, metalness: 0.62 });
  const silver = new THREE.MeshStandardMaterial({ color: 0xc5ccd1, roughness: 0.34, metalness: 0.7 });
  const cabooseRed = new THREE.MeshStandardMaterial({ color: 0x8d3028, roughness: 0.55, metalness: 0.06 });
  const clap = new THREE.MeshStandardMaterial({ color: 0xe4e0d6, roughness: 0.78 });
  const barn = new THREE.MeshStandardMaterial({ color: 0x7a342c, roughness: 0.74 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x3c4144, roughness: 0.7, metalness: 0.15 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb7b4ac, roughness: 0.9 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x6a5344, roughness: 0.86 });
  const asphalt = new THREE.MeshStandardMaterial({ color: 0x3a3d3c, roughness: 0.92 });
  const windowMat = new THREE.MeshStandardMaterial({
    color: 0x1a2428,
    emissive: 0xffc48a,
    emissiveIntensity: 0.04,
    roughness: 0.18,
  });
  const lampEmissive: THREE.MeshStandardMaterial[] = [];

  const rivers: River[] = [];
  for (let i = 0; i < SAMPLES.length; i += 4) rivers.push(riverPoint(SAMPLES[i]));

  function nearestRiver(x: number, z: number) {
    let best = rivers[0];
    let bestD = Infinity;
    let lo = 0;
    let hi = rivers.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rivers[mid].z < z) lo = mid + 1;
      else hi = mid;
    }
    const a = Math.max(0, lo - 12);
    const b = Math.min(rivers.length - 1, lo + 12);
    for (let i = a; i <= b; i++) {
      const r = rivers[i];
      const dd = (r.x - x) * (r.x - x) + (r.z - z) * (r.z - z);
      if (dd < bestD) {
        bestD = dd;
        best = r;
      }
    }
    return best;
  }

  function heightAt(x: number, z: number) {
    const n = fbm(x * 0.0031, z * 0.0031);
    const n2 = fbm(x * 0.011 + 9, z * 0.011);
    let h = 8.5 + n * 24 + n2 * 3.2;
    h += Math.max(0, Math.abs(x) - 220) * 0.03;
    const s = nearestSample(x, z);
    const dist = Math.hypot(x - s.x, z - s.z);
    const onBridge = s.d > BRIDGE.d0 - 30 && s.d < BRIDGE.d1 + 30;
    if (dist < 220) {
      if (onBridge) {
        const gorge = s.y - 9.5;
        if (dist < 30) h = Math.min(h, gorge);
        else {
          const t = smoothstep(180, 30, dist);
          h = h + (Math.min(h, gorge) - h) * t;
        }
      } else {
        const shelf = s.y - 0.7 - Math.max(0, dist - 8) * 0.018;
        if (dist < 36) h = Math.min(h, shelf);
        else {
          const t = smoothstep(210, 36, dist);
          h = h + (Math.min(h, shelf) - h) * t;
        }
      }
    }
    const r = nearestRiver(x, z);
    const rd = Math.hypot(x - r.x, z - r.z);
    const reach = r.half + 86;
    if (rd < reach) {
      const t = smoothstep(reach, r.half * 0.8, rd);
      const bed = r.level - 1.15;
      h = h + (Math.min(h, bed) - h) * t;
    }
    return h;
  }

  // Terrain
  {
    const x0 = -1500;
    const x1 = 1500;
    const z0 = -300;
    const z1 = 8200;
    const segX = 200;
    const segZ = 420;
    const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    geo.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
    const pos = geo.getAttribute("position");
    const colors = new Float32Array(pos.count * 3);
    const uv = geo.getAttribute("uv");
    const grassC = new THREE.Color(0.93, 0.9, 0.78);
    const litterC = new THREE.Color(0.78, 0.64, 0.48);
    const rockC = new THREE.Color(0.78, 0.76, 0.7);
    const meadow = new THREE.Color(1, 0.97, 0.86);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = heightAt(x, z);
      pos.setY(i, h);
      uv.setXY(i, x * 0.055, z * 0.055);
    }
    geo.computeVertexNormals();
    const nrm = geo.getAttribute("normal");
    for (let i = 0; i < pos.count; i++) {
      const slope = 1 - Math.max(0, nrm.getY(i));
      const h = pos.getY(i);
      const leaf = fbm(pos.getX(i) * 0.01, pos.getZ(i) * 0.01);
      const col = meadow.clone();
      if (h > 18 || leaf > 0.55) col.lerp(grassC, 0.45);
      if (leaf > 0.62 && h < 30) col.lerp(litterC, 0.55);
      if (slope > 0.28) col.lerp(rockC, Math.min(1, (slope - 0.28) * 2.4));
      if (h < 7.2) col.lerp(new THREE.Color(0.62, 0.66, 0.58), 0.35);
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(geo, grassMat);
    mesh.receiveShadow = true;
    scene.add(mesh);
    // macro litter blend via a second very transparent pass would fight shadows; vertex color carries biome
    void litterMap;
    void rockMap;
  }

  function buildStrip(offset: number, yLift: number, halfW: number, mat: THREE.Material, d0 = 0, d1 = ROUTE_LEN) {
    const pts = SAMPLES.filter((s) => s.d >= d0 && s.d <= d1);
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    pts.forEach((p, i) => {
      const ox = p.rx * offset;
      const oz = p.rz * offset;
      const y = p.y + yLift;
      positions.push(p.x + ox + p.rx * halfW, y, p.z + oz + p.rz * halfW);
      positions.push(p.x + ox - p.rx * halfW, y, p.z + oz - p.rz * halfW);
      uvs.push(0, i * 0.08, 1, i * 0.08);
      if (i > 0) {
        const a = (i - 1) * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }

  buildStrip(0, -0.34, 2.7, ballastMat);
  buildStrip(0.74, 0.02, 0.045, railMat);
  buildStrip(-0.74, 0.02, 0.045, railMat);
  // yard leads
  buildStrip(4.6, -0.34, 1.5, ballastMat, 0, MARK.yardEnd + 80);
  buildStrip(4.6 + 0.74, 0.02, 0.04, railMat, 0, MARK.yardEnd + 40);
  buildStrip(4.6 - 0.74, 0.02, 0.04, railMat, 0, MARK.yardEnd + 40);

  {
    const tieGeo = new THREE.BoxGeometry(2.55, 0.16, 0.22);
    const count = Math.floor(ROUTE_LEN / 0.74);
    const ties = new THREE.InstancedMesh(tieGeo, tieMat, count);
    ties.receiveShadow = true;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const s = sampleAt(i * 0.74);
      dummy.position.set(s.x, s.y - 0.12, s.z);
      dummy.rotation.set(0, s.yaw, 0);
      dummy.updateMatrix();
      ties.setMatrixAt(i, dummy.matrix);
    }
    scene.add(ties);
  }

  // Water ribbon
  {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    rivers.forEach((p, i) => {
      const prev = rivers[Math.max(0, i - 1)];
      const next = rivers[Math.min(rivers.length - 1, i + 1)];
      let tx = next.x - prev.x;
      let tz = next.z - prev.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      const rx = -tz;
      const rz = tx;
      const y = p.level + 0.35;
      positions.push(p.x + rx * p.half, y, p.z + rz * p.half);
      positions.push(p.x - rx * p.half, y, p.z - rz * p.half);
      uvs.push(0, i * 0.15, 1, i * 0.15);
      if (i > 0) {
        const a = (i - 1) * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, waterMat);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // Bridge: plate girders + piers
  {
    const girder = new THREE.BoxGeometry(0.28, 1.55, 5.2);
    const pier = new THREE.BoxGeometry(0.7, 1, 1.6);
    const gCount = Math.max(2, Math.floor((BRIDGE.d1 - BRIDGE.d0) / 5));
    const girders = new THREE.InstancedMesh(girder, steel, gCount * 2);
    const piers: THREE.Mesh[] = [];
    const dummy = new THREE.Object3D();
    for (let i = 0; i < gCount; i++) {
      const s = sampleAt(BRIDGE.d0 + ((i + 0.5) * (BRIDGE.d1 - BRIDGE.d0)) / gCount);
      for (let side = 0; side < 2; side++) {
        const sign = side ? 1 : -1;
        dummy.position.set(s.x + s.rx * sign * 1.7, s.y - 1.15, s.z + s.rz * sign * 1.7);
        dummy.rotation.set(0, s.yaw, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        girders.setMatrixAt(i * 2 + side, dummy.matrix);
      }
      if (i % 3 === 0) {
        const rv = nearestRiver(s.x, s.z);
        const p = new THREE.Mesh(pier, concrete);
        const tall = Math.max(2.2, s.y - rv.level);
        p.scale.set(1.1, tall, 1);
        p.position.set(s.x, rv.level + tall / 2, s.z);
        p.castShadow = true;
        p.receiveShadow = true;
        scene.add(p);
        piers.push(p);
      }
    }
    girders.castShadow = true;
    scene.add(girders);
    void piers;
  }

  // Trees
  const trunkGeo = (() => {
    const parts: THREE.BufferGeometry[] = [];
    const trunk = new THREE.CylinderGeometry(0.11, 0.28, 5.2, 6);
    trunk.translate(0, 2.6, 0);
    parts.push(trunk);
    const rng = mulberry(3);
    for (let i = 0; i < 6; i++) {
      const len = 1.3 + rng() * 1.5;
      const b = new THREE.CylinderGeometry(0.025, 0.06, len, 4);
      b.translate(0, len / 2, 0);
      b.rotateZ(0.55 + rng() * 0.55);
      b.rotateY(rng() * Math.PI * 2);
      b.translate(0, 2.5 + rng() * 2.2, 0);
      parts.push(b);
    }
    return merge(parts);
  })();
  const crownGeo = (() => {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 5; i++) {
      const s = new THREE.IcosahedronGeometry(0.72 + (i % 3) * 0.12, 0);
      s.translate(Math.cos(i * 1.3) * 1.05, 4.5 + (i % 2) * 0.55, Math.sin(i * 1.3) * 1.05);
      parts.push(s);
    }
    return merge(parts);
  })();
  const pineTrunk = new THREE.CylinderGeometry(0.16, 0.26, 3.4, 6);
  pineTrunk.translate(0, 1.7, 0);
  const pineCrown = (() => {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 4; i++) {
      const c = new THREE.ConeGeometry(1.55 - i * 0.28, 2.05, 7);
      c.translate(0, 3.1 + i * 1.15, 0);
      parts.push(c);
    }
    return merge(parts);
  })();

  const barkMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88 });
  const pineMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86 });
  const BARE = 340;
  const RUSSET = 180;
  const PINES = 220;
  const bareMesh = new THREE.InstancedMesh(trunkGeo, barkMat, BARE);
  const russetTrunk = new THREE.InstancedMesh(trunkGeo, barkMat, RUSSET);
  const russetLeaf = new THREE.InstancedMesh(crownGeo, leafMat, RUSSET);
  const pineT = new THREE.InstancedMesh(pineTrunk, barkMat, PINES);
  const pineC = new THREE.InstancedMesh(pineCrown, pineMat, PINES);
  for (const m of [bareMesh, russetTrunk, russetLeaf, pineT, pineC]) {
    m.castShadow = false;
    m.receiveShadow = true;
  }

  const tuftCanvas = document.createElement("canvas");
  tuftCanvas.width = 128;
  tuftCanvas.height = 256;
  {
    const g = tuftCanvas.getContext("2d");
    if (g) {
      g.clearRect(0, 0, 128, 256);
      for (let i = 0; i < 16; i++) {
        const x = 64 + (Math.random() - 0.5) * 36;
        g.strokeStyle = `rgba(${100 + Math.random() * 50}, ${90 + Math.random() * 40}, 48, 0.92)`;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x, 250);
        g.quadraticCurveTo(x + (Math.random() - 0.5) * 24, 130, x + (Math.random() - 0.5) * 16, 30 + Math.random() * 50);
        g.stroke();
      }
    }
  }
  const tuftTex = new THREE.CanvasTexture(tuftCanvas);
  tuftTex.colorSpace = THREE.SRGBColorSpace;
  const tuftMat = new THREE.MeshStandardMaterial({
    map: tuftTex,
    transparent: true,
    alphaTest: 0.35,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  const tuftPlane = new THREE.PlaneGeometry(1.15, 1.7);
  tuftPlane.translate(0, 0.85, 0);
  const tuftCross = tuftPlane.clone();
  tuftCross.rotateY(Math.PI / 2);
  const tuftGeo = merge([tuftPlane, tuftCross]);
  const TUFTS = 420;
  const tuftMesh = new THREE.InstancedMesh(tuftGeo, tuftMat, TUFTS);

  const rockGeo = new THREE.IcosahedronGeometry(1, 0);
  const rockMat = new THREE.MeshStandardMaterial({ map: rockMap, color: 0xc8c2b8, roughness: 0.95 });
  const ROCKS = 140;
  const rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, ROCKS);
  rockMesh.receiveShadow = true;

  {
    const rng = mulberry(11);
    const dummy = new THREE.Object3D();
    const bark = new THREE.Color();
    const leaf = new THREE.Color();
    const pineCol = new THREE.Color();
    let bi = 0;
    let ri = 0;
    let pi = 0;
    let ti = 0;
    let ki = 0;
    const zMax = SAMPLES[SAMPLES.length - 1].z;
    for (let guard = 0; guard < 9000 && (bi < BARE || ri < RUSSET || pi < PINES); guard++) {
      const z = rng() * zMax;
      const x = (rng() - 0.5) * 980;
      const s = nearestSample(x, z);
      if (Math.hypot(x - s.x, z - s.z) < 8.5) continue;
      if (s.d > BRIDGE.d0 - 20 && s.d < BRIDGE.d1 + 20 && Math.hypot(x - s.x, z - s.z) < 14) continue;
      const rv = nearestRiver(x, z);
      if (Math.hypot(x - rv.x, z - rv.z) < rv.half + 1.5) continue;
      const h = heightAt(x, z);
      if (h < rv.level + 0.4) continue;
      const roll = rng();
      dummy.position.set(x, h, z);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      const sc = 0.75 + rng() * 0.85;
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      if (roll < 0.46 && bi < BARE) {
        bareMesh.setMatrixAt(bi, dummy.matrix);
        bark.setHSL(0.07, 0.22, 0.16 + rng() * 0.08);
        bareMesh.setColorAt(bi, bark);
        bi++;
      } else if (roll < 0.7 && ri < RUSSET) {
        russetTrunk.setMatrixAt(ri, dummy.matrix);
        russetLeaf.setMatrixAt(ri, dummy.matrix);
        bark.setHSL(0.07, 0.25, 0.18 + rng() * 0.06);
        leaf.setHSL(0.06, 0.48, 0.26 + rng() * 0.1);
        russetTrunk.setColorAt(ri, bark);
        russetLeaf.setColorAt(ri, leaf);
        ri++;
      } else if (pi < PINES) {
        const scP = 0.85 + rng() * 0.9;
        dummy.scale.setScalar(scP);
        dummy.updateMatrix();
        pineT.setMatrixAt(pi, dummy.matrix);
        pineC.setMatrixAt(pi, dummy.matrix);
        bark.setHSL(0.07, 0.2, 0.2);
        pineCol.setHSL(0.28, 0.32, 0.16 + rng() * 0.06);
        pineT.setColorAt(pi, bark);
        pineC.setColorAt(pi, pineCol);
        pi++;
      }
      if (ti < TUFTS && Math.hypot(x - s.x, z - s.z) < 22 && Math.hypot(x - s.x, z - s.z) > 4.2 && rng() > 0.4) {
        dummy.position.set(x, h, z);
        dummy.scale.setScalar(0.7 + rng() * 0.8);
        dummy.rotation.set(0, rng() * 6, 0);
        dummy.updateMatrix();
        tuftMesh.setMatrixAt(ti, dummy.matrix);
        ti++;
      }
      if (ki < ROCKS && rng() > 0.92) {
        dummy.position.set(x, h, z);
        dummy.scale.set(0.5 + rng(), 0.35 + rng() * 0.5, 0.5 + rng());
        dummy.rotation.set(rng(), rng(), rng());
        dummy.updateMatrix();
        rockMesh.setMatrixAt(ki, dummy.matrix);
        ki++;
      }
    }
    bareMesh.count = bi;
    russetTrunk.count = ri;
    russetLeaf.count = ri;
    pineT.count = pi;
    pineC.count = pi;
    tuftMesh.count = ti;
    rockMesh.count = Math.max(1, ki);
    for (const m of [bareMesh, russetTrunk, russetLeaf, pineT, pineC]) {
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    scene.add(bareMesh, russetTrunk, russetLeaf, pineT, pineC, tuftMesh, rockMesh);
  }

  // Poles
  {
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 7.2, 5);
    poleGeo.translate(0, 3.6, 0);
    const armGeo = new THREE.BoxGeometry(1.4, 0.08, 0.08);
    armGeo.translate(0, 6.7, 0);
    const n = Math.floor(ROUTE_LEN / 46);
    const poles = new THREE.InstancedMesh(poleGeo, wood, n);
    const arms = new THREE.InstancedMesh(armGeo, black, n);
    const dummy = new THREE.Object3D();
    let c = 0;
    for (let d = 30; d < ROUTE_LEN && c < n; d += 46) {
      if (d > BRIDGE.d0 && d < BRIDGE.d1) continue;
      const s = sampleAt(d);
      const x = s.x - s.rx * 8.2;
      const z = s.z - s.rz * 8.2;
      dummy.position.set(x, heightAt(x, z), z);
      dummy.rotation.set(0, s.yaw, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      poles.setMatrixAt(c, dummy.matrix);
      arms.setMatrixAt(c, dummy.matrix);
      c++;
    }
    poles.count = c;
    arms.count = c;
    scene.add(poles, arms);
  }

  function signTexture(text: string, bg: string, fg: string) {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 128;
    const g = c.getContext("2d");
    if (!g) return new THREE.CanvasTexture(c);
    g.fillStyle = bg;
    g.fillRect(0, 0, 512, 128);
    g.strokeStyle = fg;
    g.lineWidth = 8;
    g.strokeRect(8, 8, 496, 112);
    g.fillStyle = fg;
    g.font = "600 64px Georgia, serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, 256, 68);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  function addBuilding(d: number, side: number, dist: number, kind: string, name?: string) {
    const s = sampleAt(d);
    let x = s.x + s.rx * side * dist;
    let z = s.z + s.rz * side * dist;
    const rv = nearestRiver(x, z);
    if (Math.hypot(x - rv.x, z - rv.z) < rv.half + 6) {
      x = s.x - s.rx * dist;
      z = s.z - s.rz * dist;
    }
    const y = heightAt(x, z);
    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.rotation.y = s.yaw;
    const bodyMat = kind === "barn" || kind === "shed" ? barn : kind === "yard" ? wood : clap;
    const w = kind === "station" ? 16 : kind === "barn" ? 11 : kind === "farm" ? 13 : kind === "yard" ? 18 : 7.5;
    const h = kind === "barn" ? 6.2 : kind === "station" ? 4.4 : 4.6;
    const depth = kind === "station" ? 7 : 6.2;
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), bodyMat);
    body.position.y = h / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, depth) * 0.48, 1.8, 4), roofMat);
    roof.position.y = h + 0.7;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    group.add(roof);
    const win = new THREE.Mesh(new THREE.BoxGeometry(w * 0.72, 0.7, 0.08), windowMat);
    win.position.set(0, h * 0.55, depth / 2 + 0.02);
    group.add(win);
    const win2 = win.clone();
    win2.position.z = -depth / 2 - 0.02;
    group.add(win2);
    if (kind === "station" || kind === "yard") {
      const plat = new THREE.Mesh(new THREE.BoxGeometry(kind === "yard" ? 28 : 22, 0.35, 3.2), concrete);
      plat.position.set(side > 0 ? -dist * 0.15 : dist * 0.15, 0.2, 6);
      plat.receiveShadow = true;
      group.add(plat);
      if (name) {
        const board = new THREE.Mesh(
          new THREE.PlaneGeometry(6.2, 1.5),
          new THREE.MeshStandardMaterial({ map: signTexture(name, "#171c19", "#e6e0d2"), roughness: 0.6 }),
        );
        board.position.set(0, h + 0.2, depth / 2 + 0.2);
        group.add(board);
      }
    }
    if (kind === "yard") {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 3.2, 12), steel);
      tank.position.set(8, 1.6, -2);
      tank.castShadow = true;
      group.add(tank);
    }
    scene.add(group);
  }

  addBuilding(dAtZSafe(160), -1, 18, "yard", "BRIAR YARD");
  addBuilding(dAtZSafe(280), -1, 24, "shed");
  addBuilding(MARK.mill, -1, 26, "station", "MILL RIVER");
  addBuilding(MARK.mill + 140, -1, 40, "barn");
  addBuilding(MARK.mill + 260, -1, 32, "house");
  addBuilding(MARK.ferryStop + 40, -1, 24, "station", "EAST FERRY");
  addBuilding(dAtZSafe(3100), -1, 36, "farm");
  addBuilding(dAtZSafe(3900), -1, 30, "house");
  addBuilding(MARK.hale, -1, 24, "station", "HALE");
  addBuilding(MARK.hale + 180, -1, 38, "barn");
  addBuilding(dAtZSafe(6200), -1, 28, "house");
  addBuilding(MARK.tide, -1, 22, "station", "TIDEWATER");
  addBuilding(dAtZSafe(1050), -1, 30, "house");
  addBuilding(dAtZSafe(2500), -1, 34, "farm");

  function dAtZSafe(z: number) {
    let best = SAMPLES[0];
    let bestD = Infinity;
    for (let i = 0; i < SAMPLES.length; i += 4) {
      const dd = Math.abs(SAMPLES[i].z - z);
      if (dd < bestD) {
        bestD = dd;
        best = SAMPLES[i];
      }
    }
    return best.d;
  }

  // Crossings
  for (const d of [MARK.mill, MARK.hale, dAtZSafe(1000)]) {
    const s = sampleAt(d);
    const road = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.06, 16), asphalt);
    road.position.set(s.x, s.y + 0.04, s.z);
    road.rotation.y = s.yaw;
    road.receiveShadow = true;
    scene.add(road);
  }

  // Signals — mast, name board, and a lamp big enough to read from the cab.
  const sigLamps: {
    d: number;
    meet: boolean;
    mats: THREE.MeshBasicMaterial[];
    hues: Aspect[];
    halos: THREE.Sprite[];
    light: THREE.PointLight;
  }[] = [];
  const glowMap = (() => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const g = c.getContext("2d");
    if (g) {
      const grd = g.createRadialGradient(32, 32, 1, 32, 32, 31);
      grd.addColorStop(0, "rgba(255,255,255,1)");
      grd.addColorStop(0.35, "rgba(255,255,255,0.7)");
      grd.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
    }
    return new THREE.CanvasTexture(c);
  })();
  function signalBoard(text: string) {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 128;
    const g = c.getContext("2d");
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
    if (g) {
      g.fillStyle = "#171c19";
      g.fillRect(0, 0, 512, 128);
      g.strokeStyle = "#e6e0d2";
      g.lineWidth = 8;
      g.strokeRect(8, 8, 496, 112);
      g.fillStyle = "#e6e0d2";
      const size = text.length > 16 ? 36 : text.length > 11 ? 46 : 58;
      g.font = `600 ${size}px Georgia, serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(text, 256, 68);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      mat.map = t;
    }
    return mat;
  }
  for (const sig of SIGNALS) {
    const s = sampleAt(sig.d);
    const g = new THREE.Group();
    g.position.set(s.x, s.y, s.z);
    const back = sampleAt(Math.max(0, sig.d - 36));
    g.lookAt(back.x, s.y, back.z);
    const post = new THREE.CylinderGeometry(0.16, 0.22, 7.4, 8);
    const left = new THREE.Mesh(post, black);
    left.position.set(-3.8, 3.7, 0);
    const right = new THREE.Mesh(post, black);
    right.position.set(3.8, 3.7, 0);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.38, 0.42), black);
    beam.position.set(0, 7.35, 0);
    g.add(left, right, beam);
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.25, 2.55, 0.5), black);
    head.position.set(0, 5.85, -0.45);
    g.add(head);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.95), signalBoard(sig.name));
    board.position.set(0, 4.05, -0.5);
    board.rotation.y = Math.PI;
    g.add(board);
    const hues: Aspect[] = ["clear", "approach", "stop"];
    const colors = [0x3dff6a, 0xffc83a, 0xff3b30];
    const mats: THREE.MeshBasicMaterial[] = [];
    const halos: THREE.Sprite[] = [];
    hues.forEach((hue, i) => {
      const mat = new THREE.MeshBasicMaterial({ color: 0x1a1c1b, toneMapped: false });
      mats.push(mat);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.48, 16, 12), mat);
      bulb.position.set(0, 6.55 - i * 0.7, -0.85);
      g.add(bulb);
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowMap,
          color: colors[i],
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          opacity: hue === "clear" ? 0.9 : 0,
          toneMapped: false,
        }),
      );
      halo.position.copy(bulb.position);
      halo.scale.set(14, 14, 1);
      halo.visible = hue === "clear";
      g.add(halo);
      halos.push(halo);
    });
    mats[0].color.setHex(colors[0]);
    const light = new THREE.PointLight(colors[0], 30, 80, 2);
    light.position.set(0, 6.2, -1.4);
    g.add(light);
    sigLamps.push({ d: sig.d, meet: sig.meet, mats, hues, halos, light });
    scene.add(g);
  }

  // Mileposts
  for (let mi = 0; mi <= ROUTE_LEN / MILE; mi += 0.5) {
    const s = sampleAt(mi * MILE);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.3, 0.08), cream);
    const x = s.x - s.rx * 2.6;
    const z = s.z - s.rz * 2.6;
    post.position.set(x, s.y + 0.7, z);
    scene.add(post);
    const label = mi % 1 === 0 ? String(mi) : mi.toFixed(1);
    const spr = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: signTexture(label, "#e6e0d2", "#171c19"),
        transparent: true,
      }),
    );
    spr.position.set(x, s.y + 1.7, z);
    spr.scale.set(1.8, 0.45, 1);
    scene.add(spr);
  }

  const wheelGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.22, 12);
  wheelGeo.rotateZ(Math.PI / 2);
  wheelGeo.userData.shared = true;

  function makeWheel(x: number, z: number) {
    const m = new THREE.Mesh(wheelGeo, rubber);
    m.position.set(x, 0.46, z);
    m.userData.sharedGeo = true;
    return m;
  }

  function numberMat(num: string) {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 96;
    const g = c.getContext("2d");
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.05 });
    if (g) {
      g.fillStyle = "#141816";
      g.fillRect(0, 0, 256, 96);
      g.fillStyle = "#f3efe4";
      g.font = "700 64px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(num, 128, 50);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      mat.map = t;
    }
    return mat;
  }

  const decalMat = (() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 128;
    const g = c.getContext("2d");
    if (g) {
      g.fillStyle = "#1a1e1c";
      g.fillRect(0, 0, 256, 128);
      g.fillStyle = "#e6e0d2";
      g.font = "700 72px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("VD", 128, 66);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.55 });
  })();

  const carColors = [0x6e342c, 0x8a6232, 0x2d4862, 0x4e453c, 0x6d4c34, 0x3d4c3e, 0x5c3a3a, 0x3a3f44];
  const carMats = carColors.map(
    (hex) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.62, metalness: 0.08 }),
  );

  function buildLoco(loco: Loco) {
    const group = new THREE.Group();
    const paintG: THREE.BufferGeometry[] = [];
    const blackG: THREE.BufferGeometry[] = [];
    const creamG: THREE.BufferGeometry[] = [];
    const glassG: THREE.BufferGeometry[] = [];
    const kind = loco.kind;
    const L = loco.length;
    if (kind === "switcher") {
      putBox(blackG, 3, 0.4, L - 0.4, 0, 0.9, 0);
      putBox(paintG, 2.4, 1.45, 4.2, 0, 1.95, 3.1);
      putBox(paintG, 2.4, 1.45, 4.2, 0, 1.95, -3.1);
      putBox(paintG, 3.05, 2.3, 3.1, 0, 2.35, 0);
      putBox(creamG, 3.12, 0.12, 3.1, 0, 3.45, 0);
      putBox(glassG, 2.7, 0.7, 0.08, 0, 2.7, 1.56);
      putBox(glassG, 2.7, 0.7, 0.08, 0, 2.7, -1.56);
      putBox(blackG, 2.4, 0.45, 2.2, 0, 0.48, 2.4);
      putBox(blackG, 2.4, 0.45, 2.2, 0, 0.48, -2.4);
    } else if (kind === "passenger") {
      putBox(blackG, 3.05, 0.38, L - 0.3, 0, 0.9, 0);
      putBox(paintG, 3.05, 2.55, L - 1.2, 0, 2.45, -0.2);
      putBox(creamG, 3.12, 0.16, L - 1.3, 0, 1.55, -0.2);
      putBox(glassG, 2.6, 0.62, 0.08, 0, 2.9, L / 2 - 0.7);
      putBox(glassG, 0.08, 0.7, L * 0.62, 1.54, 2.85, 0);
      putBox(glassG, 0.08, 0.7, L * 0.62, -1.54, 2.85, 0);
      putBox(blackG, 2.5, 0.42, 2.3, 0, 0.5, 4.6);
      putBox(blackG, 2.5, 0.42, 2.3, 0, 0.5, -4.6);
    } else {
      const long = kind === "heavy" ? 10.4 : 9.1;
      putBox(blackG, 3.05, 0.42, L - 0.5, 0, 0.95, 0);
      putBox(paintG, 2.35, 1.62, long, 0, 1.95, -L * 0.18);
      putBox(paintG, 3.02, 2.25, 2.7, 0, 2.4, L * 0.18);
      putBox(paintG, 2.2, 1.32, 4.1, 0, 1.85, L * 0.38);
      putBox(creamG, 2.42, 0.1, long, 0, 2.55, -L * 0.18);
      putBox(creamG, 3.08, 0.12, 2.7, 0, 3.5, L * 0.18);
      putBox(glassG, 2.6, 0.72, 0.08, 0, 2.75, L * 0.18 + 1.36);
      putBox(glassG, 0.08, 0.7, 2.2, 1.52, 2.75, L * 0.18);
      putBox(glassG, 0.08, 0.7, 2.2, -1.52, 2.75, L * 0.18);
      putBox(blackG, 2.2, 0.62, 3.4, 0, 0.72, -0.2);
      putBox(blackG, 2.55, 0.7, 0.35, 0, 0.55, L / 2 - 0.3);
      const truckZ = kind === "heavy" ? 5.6 : 5.05;
      putBox(blackG, 2.45, 0.4, kind === "heavy" ? 3.3 : 2.3, 0, 0.48, truckZ);
      putBox(blackG, 2.45, 0.4, kind === "heavy" ? 3.3 : 2.3, 0, 0.48, -truckZ);
      const stack = new THREE.CylinderGeometry(0.22, 0.28, 0.45, 8);
      stack.translate(0, 3.05, -L * 0.28);
      paintG.push(stack);
    }
    group.add(new THREE.Mesh(merge(paintG), paint));
    group.add(new THREE.Mesh(merge(blackG), black));
    if (creamG.length) group.add(new THREE.Mesh(merge(creamG), cream));
    if (glassG.length) group.add(new THREE.Mesh(merge(glassG), glass));
    const board = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.34), numberMat(loco.number));
    board.position.set(1.55, 3.15, kind === "switcher" ? 0 : loco.length * 0.16);
    board.rotation.y = Math.PI / 2;
    group.add(board);
    const wheels: THREE.Object3D[] = [];
    const axles = kind === "heavy" ? [-6.5, -5.4, -4.3, 4.3, 5.4, 6.5] : kind === "switcher" ? [-3.1, -1.7, 1.7, 3.1] : [-5.7, -4.4, 4.4, 5.7];
    for (const z of axles) {
      for (const x of [-0.78, 0.78]) {
        const w = makeWheel(x, z);
        group.add(w);
        wheels.push(w);
      }
    }
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xfff4dc,
      emissive: 0xfff1cc,
      emissiveIntensity: 1.6,
    });
    lampEmissive.push(lampMat);
    const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.18, 12), lampMat);
    lamp.position.set(0.55, kind === "passenger" ? 2.4 : 2.15, loco.length / 2 - 0.05);
    group.add(lamp);
    const lamp2 = lamp.clone();
    lamp2.position.x = -0.55;
    group.add(lamp2);
    const spot = new THREE.SpotLight(0xfff3d4, 0, 220, 0.42, 0.45, 1.4);
    spot.position.set(0, 2.3, loco.length / 2);
    const target = new THREE.Object3D();
    target.position.set(0, 1.2, loco.length / 2 + 30);
    group.add(spot, target);
    spot.target = target;
    group.userData.spot = spot;
    group.userData.stack = new THREE.Vector3(0, 3.3, kind === "switcher" ? 0.2 : -loco.length * 0.22);
    const eye = new THREE.Vector3();
    const gaze = new THREE.Vector3();
    const hoodEye = new THREE.Vector3();
    const hoodGaze = new THREE.Vector3();
    if (kind === "switcher") {
      eye.set(0.25, 3.15, 1.85);
      gaze.set(0, 3.6, 75);
      hoodEye.set(0, 3.8, 6.4);
      hoodGaze.set(0, 2.9, 70);
    } else if (kind === "passenger") {
      eye.set(0.3, 3.4, L / 2 - 0.35);
      gaze.set(0, 3.8, L / 2 + 75);
      hoodEye.set(0, 4.45, L / 2 + 0.35);
      hoodGaze.set(0, 3.2, L / 2 + 60);
    } else {
      const z = L * 0.18 + 1.7;
      eye.set(0.28, 3.6, z);
      gaze.set(0, 4.3, z + 80);
      hoodEye.set(0, 4.4, L * 0.42);
      hoodGaze.set(0, 3.2, L * 0.42 + 75);
    }
    group.userData.cabEye = eye;
    group.userData.cabLook = gaze;
    group.userData.hoodEye = hoodEye;
    group.userData.hoodLook = hoodGaze;
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    return { group, wheels };
  }

  function buildCar(kind: CarKind, index: number) {
    const group = new THREE.Group();
    const length = kind === "passenger" ? 24.6 : kind === "caboose" ? 10.4 : kind === "tank" ? 14.6 : 15.2;
    const mat = kind === "passenger" ? silver : kind === "caboose" ? cabooseRed : carMats[index % carMats.length];
    const geos: THREE.BufferGeometry[] = [];
    if (kind === "tank") {
      const tank = new THREE.CylinderGeometry(1.35, 1.35, length - 1.2, 14);
      tank.rotateX(Math.PI / 2);
      tank.translate(0, 2.15, 0);
      geos.push(tank);
      putBox(geos, 2.6, 0.35, length, 0, 1.05, 0);
    } else if (kind === "hopper") {
      putBox(geos, 3.05, 1.7, length - 0.4, 0, 1.9, 0);
      putBox(geos, 2.4, 0.7, length - 0.8, 0, 1.05, 0);
    } else if (kind === "gondola") {
      putBox(geos, 3.0, 0.35, length - 0.3, 0, 1.15, 0);
      putBox(geos, 0.12, 1.15, length - 0.4, 1.45, 1.7, 0);
      putBox(geos, 0.12, 1.15, length - 0.4, -1.45, 1.7, 0);
    } else if (kind === "passenger") {
      putBox(geos, 3.05, 2.5, length - 0.4, 0, 2.35, 0);
      const win = new THREE.BoxGeometry(0.06, 0.7, length * 0.78);
      win.translate(1.54, 2.7, 0);
      const win2 = win.clone();
      win2.translate(-3.08, 0, 0);
      group.add(new THREE.Mesh(win, glass));
      group.add(new THREE.Mesh(win2, glass));
    } else if (kind === "caboose") {
      putBox(geos, 2.9, 2.15, length - 0.4, 0, 2.05, 0);
      putBox(geos, 1.5, 0.9, 2.2, 0, 3.3, 0);
    } else {
      putBox(geos, 3.1, 2.7, length - 0.5, 0, 2.35, 0);
      const door = new THREE.BoxGeometry(0.06, 1.8, 1.6);
      door.translate(1.56, 1.9, 0);
      group.add(new THREE.Mesh(door, black));
    }
    const body = new THREE.Mesh(merge(geos), mat);
    body.castShadow = index < 6;
    body.receiveShadow = true;
    group.add(body);
    if (kind !== "passenger") {
      const mark = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.7), decalMat);
      mark.position.set(1.58, kind === "gondola" ? 1.7 : 2.4, 0);
      mark.rotation.y = Math.PI / 2;
      group.add(mark);
    }
    const wheels: THREE.Object3D[] = [];
    for (const z of [-length * 0.32, length * 0.32]) {
      for (const x of [-0.78, 0.78]) {
        const w = makeWheel(x, z);
        group.add(w);
        wheels.push(w);
      }
    }
    return { group, wheels, length };
  }

  let units: Unit[] = [];
  const smokeTex = (() => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const g = c.getContext("2d");
    if (g) {
      const grd = g.createRadialGradient(32, 32, 4, 32, 32, 30);
      grd.addColorStop(0, "rgba(210,210,206,0.45)");
      grd.addColorStop(1, "rgba(210,210,206,0)");
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
    }
    const t = new THREE.CanvasTexture(c);
    return t;
  })();
  const puffs: { sprite: THREE.Sprite; life: number; vel: number }[] = [];
  for (let i = 0; i < 28; i++) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: smokeTex, transparent: true, depthWrite: false, color: 0xd5d3cc }),
    );
    sprite.visible = false;
    sprite.scale.set(1.6, 1.6, 1.6);
    scene.add(sprite);
    puffs.push({ sprite, life: 0, vel: 0.6 });
  }
  let puffT = 0;

  const audio = new DieselAudio();
  const keys = new Set<string>();
  let qaKeys: string[] | null = null;
  let forcedSteer: number | null = null;
  let orbitYaw = 0;
  let orbitPitch = 0;
  let camZoom = 1;
  const fingers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  let dragLatch = false;
  const held: Record<HoldName, boolean> = {
    notchUp: false,
    notchDown: false,
    brake: false,
    release: false,
    horn: false,
  };

  const sim = {
    running: false,
    job: jobById("local"),
    d: MARK.start,
    speed: 0,
    notch: 0,
    pipe: 90,
    cyl: 0,
    prevCyl: 0,
    lookYaw: 0,
    fuel: 0,
    time: 0,
    clock0: 14 * 60 + 12,
    overSec: 0,
    overHard: 0,
    penalty: false,
    emergency: false,
    emergencies: 0,
    red: 0,
    redFlag: false,
    meetCleared: false,
    stops: [] as StopState[],
    settled: false,
    camera: "chase" as CameraMode,
    lights: true,
    radio: "Briar Yard. The valley is clear and cold.",
    radioT: 6,
    warning: "",
    wheelSpin: 0,
    snap: true,
    upArm: 0,
    downArm: 0,
    wasUp: false,
    wasDown: false,
    lastTie: -1,
    menuAng: 0.6,
    hudT: 0,
    focus: new THREE.Vector3(),
  };

  const cues = [
    { d: MARK.start + 40, text: "Dispatcher. Released out of Briar Yard. Fifteen miles an hour until the limit board.", meet: false },
    { d: MARK.mill - 450, text: "Mill River ahead. Stop the merchandise and mind the crossing.", meet: false },
    { d: MARK.ferryStop - 520, text: "East Ferry. Westbound is in the clear on the siding. Stop short of the absolute.", meet: true },
    { d: MARK.hale - 420, text: "Hale's Landing. The platform is short. Bring it in on the air.", meet: false },
    { d: MARK.tide - 480, text: "Tidewater is your tie-up. No emergency unless you mean it.", meet: false },
  ];
  const cueFired = new Set<number>();

  function input() {
    const down = (code: string) => (qaKeys ? qaKeys.includes(code) : keys.has(code));
    return {
      notchUp: held.notchUp || down("KeyW") || down("ArrowUp"),
      notchDown: held.notchDown || down("KeyS") || down("ArrowDown"),
      brake: held.brake || down("Space") || down("KeyQ"),
      release: held.release || down("KeyE"),
      horn: held.horn || down("KeyH"),
    };
  }

  function limitOf(s: Sample) {
    if (sim.job.fast && s.d > dAtZSafe(900)) return Math.min(60, s.limit + 12);
    return s.limit;
  }

  function pose(group: THREE.Group, d: number) {
    const a = sampleAt(d);
    const b = sampleAt(Math.min(ROUTE_LEN - 1, d + 8));
    group.position.set(a.x, a.y, a.z);
    group.lookAt(b.x, b.y, b.z);
    group.rotateY(Math.PI);
    return a;
  }

  function clearTrain() {
    for (const u of units) {
      scene.remove(u.group);
      u.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry && !mesh.userData.sharedGeo) mesh.geometry.dispose();
      });
    }
    units = [];
  }

  function buildTrain(job: Job) {
    clearTrain();
    const loco = locoById(job.loco);
    const lead = buildLoco(loco);
    units.push({ group: lead.group, wheels: lead.wheels, offset: 0 });
    scene.add(lead.group);
    let back = loco.length / 2;
    let index = 0;
    const list: { kind: CarKind }[] = [];
    for (const spec of job.cars) for (let i = 0; i < spec.n; i++) list.push({ kind: spec.kind });
    if (job.caboose) list.push({ kind: "caboose" });
    for (const item of list) {
      const car = buildCar(item.kind, index++);
      back += 0.9 + car.length / 2;
      units.push({ group: car.group, wheels: car.wheels, offset: back });
      back += car.length / 2;
      scene.add(car.group);
    }
  }

  function applyTime(time: TimeOfDay) {
    const elev = time === "dusk" ? 5.5 : time === "dawn" ? 8 : 17;
    const az = time === "dawn" ? 210 : time === "dusk" ? 40 : 125;
    const phi = THREE.MathUtils.degToRad(90 - elev);
    const theta = THREE.MathUtils.degToRad(az);
    sunDir.setFromSphericalCoords(1, phi, theta);
    const u = sky.material.uniforms;
    u.turbidity.value = time === "dusk" ? 8 : time === "dawn" ? 6 : 5.2;
    u.rayleigh.value = time === "dusk" ? 2.1 : time === "dawn" ? 1.7 : 1.35;
    u.mieCoefficient.value = time === "afternoon" ? 0.006 : 0.01;
    u.mieDirectionalG.value = 0.82;
    u.sunPosition.value.copy(sunDir);
    u.cloudCoverage.value = time === "afternoon" ? 0.46 : 0.38;
    u.cloudDensity.value = 0.55;
    u.cloudElevation.value = 0.45;
    const fogHex = time === "dusk" ? 0xc48870 : time === "dawn" ? 0xe4c8b4 : 0xd5c6b0;
    const fog = scene.fog as THREE.FogExp2;
    fog.color.setHex(fogHex);
    fog.density = time === "dusk" ? 0.0005 : 0.0004;
    sun.color.set(time === "dusk" ? 0xffb07a : time === "dawn" ? 0xffd0c2 : 0xffd7ae);
    sun.intensity = time === "dusk" ? 1.7 : time === "dawn" ? 2.2 : 3.15;
    hemi.intensity = time === "dusk" ? 0.38 : 0.7;
    hemi.color.set(time === "dusk" ? 0x8a6a78 : 0xc5d0dc);
    windowMat.emissiveIntensity = time === "dusk" ? 1.7 : time === "dawn" ? 0.55 : 0.03;
    renderer.toneMappingExposure = time === "dusk" ? 0.78 : 0.92;
    sim.clock0 = time === "dawn" ? 6 * 60 + 40 : time === "dusk" ? 16 * 60 + 48 : 14 * 60 + 12;
    sim.lights = time !== "afternoon";
  }

  function say(text: string) {
    sim.radio = text;
    sim.radioT = 7.5;
  }

  function resetRun(job: Job, running: boolean) {
    sim.job = job;
    sim.running = running;
    sim.d = MARK.start;
    sim.speed = 0;
    sim.notch = 0;
    sim.pipe = 90;
    sim.cyl = 0;
    sim.prevCyl = 0;
    sim.lookYaw = 0;
    sim.fuel = 0;
    sim.time = 0;
    sim.overSec = 0;
    sim.overHard = 0;
    sim.penalty = false;
    sim.emergency = false;
    sim.emergencies = 0;
    sim.red = 0;
    sim.redFlag = false;
    sim.meetCleared = !job.meet;
    sim.settled = false;
    sim.wasUp = false;
    sim.wasDown = false;
    sim.upArm = 0;
    sim.downArm = 0;
    sim.snap = true;
    orbitYaw = 0;
    orbitPitch = 0;
    camZoom = 1;
    sim.warning = "";
    sim.lastTie = -1;
    cueFired.clear();
    sim.stops = job.stops.map((s) => ({
      ...s,
      dwell: 0,
      done: false,
      missed: false,
      rough: false,
      seen: false,
    }));
    buildTrain(job);
    applyTime(job.time);
    say(running ? `${job.symbol} ${job.name}. Brakes released. You are clear to depart.` : "Pick a job off the board.");
    pushHud();
  }

  function finish(completed: boolean) {
    if (sim.settled) return;
    sim.settled = true;
    sim.running = false;
    sim.speed = 0;
    const result: RunResult = {
      jobId: sim.job.id,
      completed,
      seconds: sim.time,
      miles: Math.max(0, (sim.d - MARK.start) / MILE),
      fuelGal: sim.fuel,
      overSeconds: sim.overSec,
      missed: sim.stops.filter((s) => s.missed).length,
      rough: sim.stops.filter((s) => s.rough && s.done).length,
      smoothStops: sim.stops.filter((s) => s.done && !s.rough && s.kind !== "terminal").length,
      red: sim.red,
      emergencyCount: sim.emergencies,
    };
    const { report } = settle(loadCareer(), result);
    hooks.onReport(report);
    say(completed ? "Tied up. The dispatcher has your time." : "Off the board. The valley will still be here.");
  }

  function triggerEmergency() {
    if (!sim.running || sim.emergency) return;
    sim.emergency = true;
    sim.emergencies += 1;
    sim.notch = Math.min(0, sim.notch);
    say("Emergency. The air is dumping.");
  }

  function aspectNow(): { aspect: Aspect; name: string; dist: number } {
    const ahead = SIGNALS.filter((s) => s.d > sim.d + 6);
    const next = ahead[0];
    if (!next) return { aspect: "none", name: "", dist: -1 };
    if (next.meet && sim.job.meet && !sim.meetCleared) return { aspect: "stop", name: next.name, dist: (next.d - sim.d) / MILE };
    const red = ahead.find((s) => s.meet && sim.job.meet && !sim.meetCleared);
    if (red && !next.meet && red.d - sim.d < 1200) return { aspect: "approach", name: next.name, dist: (next.d - sim.d) / MILE };
    return { aspect: "clear", name: next.name, dist: (next.d - sim.d) / MILE };
  }

  function orderLine(
    pending: { name: string; d: number; kind: string } | undefined,
    asp: { aspect: Aspect; name: string },
  ) {
    const aheadMi = pending ? (pending.d - sim.d) / MILE : 0;
    if (asp.aspect === "stop") return `Red at ${asp.name}. Stop before the signal. Do not pass it.`;
    if (pending && aheadMi < -0.02) return `You passed ${pending.name} without a stop.`;
    if (asp.aspect === "approach") {
      const where = pending ? ` ${pending.name} is ${Math.max(0, aheadMi).toFixed(1)} mi ahead.` : "";
      return `Yellow at ${asp.name}. Ease off.${where}`;
    }
    if (!pending) return "No more stops. Bring the train in.";
    if (pending.kind === "meet") return `Stop at ${pending.name}, ${Math.max(0, aheadMi).toFixed(1)} mi. Wait until the meet is clear.`;
    if (pending.kind === "terminal") return `Last stop is ${pending.name}, ${Math.max(0, aheadMi).toFixed(1)} mi. Stop and tie up.`;
    return `Stop at ${pending.name}, ${Math.max(0, aheadMi).toFixed(1)} mi. Hold there until the work is done.`;
  }

  function pushHud() {
    const s = sampleAt(sim.d);
    const asp = aspectNow();
    const pending = sim.stops.find((st) => !st.done && !st.missed);
    const mph = Math.abs(sim.speed) * 2.23694;
    const lim = limitOf(s);
    const loco = locoById(sim.job.loco);
    const hud: Hud = {
      running: sim.running,
      ready: true,
      speedMph: mph,
      limitMph: lim,
      notch: sim.notch,
      pipe: sim.pipe,
      cyl: sim.cyl,
      mile: sim.d / MILE,
      gradePct: s.grade * 100,
      aspect: asp.aspect,
      signalName: asp.name,
      signalMi: asp.dist,
      nextStop: pending ? pending.name : "Tied up",
      nextStopMi: pending ? (pending.d - sim.d) / MILE : 0,
      order: orderLine(pending, asp),
      fuel: sim.fuel,
      clock: clockLabel(sim.clock0, sim.time),
      loco: `${loco.name} ${loco.number}`,
      tons: sim.job.tons,
      cars: units.length - 1,
      camera: sim.camera,
      lights: sim.lights,
      muted: audio.muted,
      overspeed: mph > lim + 2,
      radio: sim.radio,
      warning: sim.warning,
      job: sim.job.symbol,
    };
    hooks.onHud(hud);
  }

  function physics(dt: number) {
    if (!sim.running || sim.settled) return;
    const h = input();
    if (h.notchUp && !h.notchDown) {
      if (!sim.wasUp) {
        sim.notch = Math.min(8, sim.notch + 1);
        sim.upArm = 0.17;
      } else {
        sim.upArm -= dt;
        if (sim.upArm <= 0) {
          sim.notch = Math.min(8, sim.notch + 1);
          sim.upArm = 0.09;
        }
      }
    }
    if (h.notchDown && !h.notchUp) {
      if (!sim.wasDown) {
        sim.notch = Math.max(-8, sim.notch - 1);
        sim.downArm = 0.17;
      } else {
        sim.downArm -= dt;
        if (sim.downArm <= 0) {
          sim.notch = Math.max(-8, sim.notch - 1);
          sim.downArm = 0.09;
        }
      }
    }
    sim.wasUp = h.notchUp && !h.notchDown;
    sim.wasDown = h.notchDown && !h.notchUp;

    if (sim.emergency) {
      sim.pipe = Math.max(0, sim.pipe - 36 * dt);
      sim.notch = Math.min(0, sim.notch);
      if (Math.abs(sim.speed) < 0.25 && h.release) sim.emergency = false;
    } else if (sim.penalty) {
      sim.pipe = Math.max(64, sim.pipe - 10 * dt);
      sim.notch = Math.min(0, sim.notch);
    } else if (h.brake) {
      sim.pipe = Math.max(64, sim.pipe - 8 * dt);
    } else if (h.release) {
      const rate = sim.notch <= 0 ? 6.5 : 2.4;
      sim.pipe = Math.min(90, sim.pipe + rate * dt);
    }
    const reduction = Math.max(0, 90 - sim.pipe);
    const targetCyl = sim.emergency ? 70 : Math.min(30, Math.max(0, reduction - 3.5) * 1.15);
    sim.cyl += (targetCyl - sim.cyl) * (1 - Math.exp(-dt * 2.6));

    const loco = locoById(sim.job.loco);
    const mass = sim.job.tons * 1000;
    const s = sampleAt(sim.d);
    const notchF = Math.max(0, sim.notch) / 8;
    const dynF = Math.max(0, -sim.notch) / 8;
    const hp = loco.hp * TE_SCALE * Math.pow(Math.max(notchF, 0.0001), 1.05);
    const vAbs = Math.max(Math.abs(sim.speed), 0.4);
    const te = notchF <= 0 ? 0 : Math.min(loco.teKn * 1000 * TE_SCALE * notchF, (hp * 746) / vAbs);
    const dyn = dynF * loco.teKn * 1000 * 0.55 * Math.min(1, Math.abs(sim.speed) / 4);
    const roll = mass * 9.81 * (0.0015 + 0.000022 * Math.abs(sim.speed));
    const curve = mass * 9.81 * 12 * Math.abs(s.curv);
    const gradeF = mass * 9.81 * s.grade;
    const brakeF = mass * (sim.cyl / 26) * 0.72;
    let net = te - dyn - gradeF;
    const drag = roll + curve + brakeF;
    if (sim.speed > 0.03) net -= drag;
    else if (sim.speed < -0.03) net += drag;
    else if (Math.abs(net) < drag) net = 0;
    sim.speed += (net / mass) * dt;
    if (Math.abs(sim.speed) < 0.04 && Math.abs(net) < mass * 0.08) sim.speed = 0;
    if (sim.speed > 38) sim.speed = 38;
    if (sim.speed < -2.5) sim.speed = -2.5;
    sim.d += sim.speed * dt;
    if (sim.d < 4) {
      sim.d = 4;
      if (sim.speed < 0) sim.speed = 0;
    }
    if (sim.d > ROUTE_LEN - 8) {
      if (sim.speed > 1.4) sim.warning = "Ran through the bumper.";
      sim.d = ROUTE_LEN - 8;
      sim.speed = 0;
      const term = sim.stops.find((st) => st.kind === "terminal");
      if (term && !term.done) finish(false);
    }

    const mph = Math.abs(sim.speed) * 2.23694;
    const lim = limitOf(s);
    if (mph > lim + 3) sim.overSec += dt;
    sim.warning = mph > lim + 2 ? "OVERSPEED" : sim.d > ROUTE_LEN - 12 ? sim.warning : mph > lim + 2 ? "OVERSPEED" : "";
    if (mph > lim + 3) sim.warning = "OVERSPEED";
    else if (sim.warning === "OVERSPEED") sim.warning = "";
    if (mph > lim + 15) {
      sim.overHard += dt;
      if (sim.overHard > 3.2 && !sim.penalty) {
        sim.penalty = true;
        say("Penalty brake. You were over the limit.");
      }
    } else sim.overHard = Math.max(0, sim.overHard - dt);
    if (sim.penalty && mph < lim - 1 && h.release) sim.penalty = false;

    if (sim.job.meet && !sim.meetCleared && sim.d > MARK.ferrySignal + 10 && !sim.redFlag) {
      sim.redFlag = true;
      sim.red += 1;
      sim.emergency = true;
      sim.emergencies += 1;
      say("Signal passed at danger. Dumping the air.");
    }

    for (const st of sim.stops) {
      if (st.done || st.missed) continue;
      if (!st.seen && sim.d > st.d - 70) {
        st.seen = true;
        if (mph > (sim.job.fast ? 14 : 18)) st.rough = true;
      }
      if (Math.abs(sim.d - st.d) < 40 && Math.abs(sim.speed) < 0.65) {
        st.dwell += dt;
        if (st.dwell >= st.hold) {
          st.done = true;
          if (st.kind === "meet") {
            sim.meetCleared = true;
            say("East Ferry is in the clear. Proceed on signal indication.");
          } else if (st.kind === "terminal") {
            say(`${st.name}. The air is set. You're tied up.`);
            finish(true);
          } else say(`Work done at ${st.name}.`);
        }
      }
      if (sim.d > st.d + 80 && !st.done) {
        st.missed = true;
        say(`By ${st.name} without a stop.`);
        if (st.kind === "terminal") finish(false);
      }
    }

    if (!sim.settled && sim.job.maxD < ROUTE_LEN - 200 && sim.d > sim.job.maxD) finish(false);

    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (cueFired.has(i)) continue;
      if (c.meet && !sim.job.meet) continue;
      if (c.d > sim.job.maxD) continue;
      if (sim.d >= c.d) {
        cueFired.add(i);
        say(c.text);
      }
    }

    const locoDef = locoById(sim.job.loco);
    sim.fuel += ((0.22 + Math.max(0, sim.notch) * (locoDef.hp / 1500)) / 60) * dt;
    sim.time += dt;
    const tie = Math.floor(sim.d / 13);
    if (tie !== sim.lastTie) {
      sim.lastTie = tie;
      audio.clack(Math.abs(sim.speed));
    }
  }

  function aimCamera(desired: THREE.Vector3, look: THREE.Vector3, lookMode: boolean) {
    const up = new THREE.Vector3(0, 1, 0);
    if (!lookMode) {
      const offset = desired.clone().sub(look);
      const len = Math.max(0.5, offset.length());
      offset.applyAxisAngle(up, -orbitYaw);
      const horiz = Math.hypot(offset.x, offset.z) || 1;
      const basePitch = Math.atan2(offset.y, horiz);
      const pitch = Math.max(0.05, Math.min(1.15, basePitch + orbitPitch));
      const dist = len * camZoom;
      desired.set(
        look.x + (offset.x / horiz) * Math.cos(pitch) * dist,
        look.y + Math.sin(pitch) * dist,
        look.z + (offset.z / horiz) * Math.cos(pitch) * dist,
      );
      if (camera.fov !== 58) {
        camera.fov = 58;
        camera.updateProjectionMatrix();
      }
      return;
    }
    const dir = look.clone().sub(desired);
    const len = Math.max(0.5, dir.length());
    dir.normalize();
    dir.applyAxisAngle(up, -orbitYaw);
    const right = new THREE.Vector3().crossVectors(dir, up);
    if (right.lengthSq() > 1e-8) {
      right.normalize();
      dir.applyAxisAngle(right, -orbitPitch);
    }
    look.copy(desired).addScaledVector(dir, len);
    const fov = Math.max(24, Math.min(82, 58 * camZoom));
    if (Math.abs(camera.fov - fov) > 0.04) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  function frameCamera(dt: number) {
    const lead = units[0];
    if (!lead) return;
    pose(lead.group, sim.d);
    for (let i = 1; i < units.length; i++) {
      const slack = Math.sin(sim.time * 1.6 + i) * Math.min(0.12, Math.abs(sim.speed) * 0.01);
      pose(units[i].group, sim.d - units[i].offset - slack);
    }
    sim.wheelSpin += (sim.speed / 0.46) * dt;
    for (const u of units) for (const w of u.wheels) w.rotation.x = sim.wheelSpin;

    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(lead.group.quaternion);
    const spot = lead.group.userData.spot as THREE.SpotLight | undefined;
    if (spot) {
      const dusk = sim.job.time !== "afternoon";
      spot.intensity = sim.lights ? (dusk ? 80 : 28) : 0;
    }
    sim.focus.copy(lead.group.position);
    sun.position.copy(sim.focus).addScaledVector(sunDir, 150);
    sun.target.position.copy(sim.focus);
    sky.position.copy(camera.position);

    let desired = new THREE.Vector3();
    let look = new THREE.Vector3();
    if (!sim.running) {
      if (fingers.size === 0) sim.menuAng += dt * 0.07;
      const s = sampleAt(sim.d + 18);
      desired.set(s.x + Math.sin(sim.menuAng) * 28, s.y + 8.2, s.z + Math.cos(sim.menuAng) * 24);
      look.set(s.x, s.y + 2.2, s.z + 14);
    } else if (sim.camera === "cab") {
      const eye = lead.group.userData.cabEye as THREE.Vector3;
      const gaze = lead.group.userData.cabLook as THREE.Vector3;
      desired = eye.clone().applyQuaternion(lead.group.quaternion).add(lead.group.position);
      look = gaze.clone().applyQuaternion(lead.group.quaternion).add(lead.group.position);
    } else if (sim.camera === "hood") {
      const eye = lead.group.userData.hoodEye as THREE.Vector3;
      const gaze = lead.group.userData.hoodLook as THREE.Vector3;
      desired = eye.clone().applyQuaternion(lead.group.quaternion).add(lead.group.position);
      look = gaze.clone().applyQuaternion(lead.group.quaternion).add(lead.group.position);
    } else if (sim.camera === "railfan") {
      const s = sampleAt(Math.min(ROUTE_LEN - 2, sim.d + 46));
      desired.set(s.x + s.rx * 16, s.y + 3.4, s.z + s.rz * 16);
      look.copy(lead.group.position).add(new THREE.Vector3(0, 2, 0));
    } else {
      const aheadS = sampleAt(Math.min(ROUTE_LEN - 2, sim.d + 24));
      const travel = new THREE.Vector3(aheadS.x - lead.group.position.x, 0, aheadS.z - lead.group.position.z);
      if (travel.lengthSq() < 1e-4) travel.set(0, 0, 1);
      travel.normalize();
      const shake = Math.min(0.12, Math.abs(sim.speed) * 0.004) * Math.sin(sim.d * 0.85);
      desired.copy(lead.group.position).addScaledVector(travel, -22).add(new THREE.Vector3(0, 6.6 + shake, 0));
      look.copy(lead.group.position).addScaledVector(travel, 70).add(new THREE.Vector3(0, 3.4, 0));
    }
    aimCamera(desired, look, sim.running && (sim.camera === "cab" || sim.camera === "hood"));
    const k = sim.snap ? 1 : 1 - Math.exp(-3.1 * dt);
    camera.position.lerp(desired, k);
    camera.lookAt(look);
    sim.snap = false;

    if (sim.notch > 0 && sim.running) {
      puffT += dt;
      if (puffT > 0.12) {
        puffT = 0;
        const puff = puffs.find((p) => p.life <= 0);
        if (puff) {
          const stack = (lead.group.userData.stack as THREE.Vector3).clone();
          stack.applyQuaternion(lead.group.quaternion).add(lead.group.position);
          puff.sprite.position.copy(stack);
          puff.sprite.visible = true;
          puff.life = 1;
          puff.vel = 1.2 + Math.random();
          puff.sprite.material.opacity = 0.45;
        }
      }
    }
    for (const p of puffs) {
      if (p.life <= 0) continue;
      p.life -= dt * 0.35;
      p.sprite.position.y += p.vel * dt;
      p.sprite.material.opacity = Math.max(0, p.life * 0.4);
      p.sprite.scale.setScalar(1.4 + (1 - p.life) * 3.2);
      if (p.life <= 0) p.sprite.visible = false;
    }
  }

  function updateSignals() {
    for (const sig of sigLamps) {
      let show: Aspect = "clear";
      if (sig.meet && sim.job.meet && !sim.meetCleared) show = "stop";
      else {
        const red = SIGNALS.find((s) => s.meet && s.d > sig.d && sim.job.meet && !sim.meetCleared);
        if (red && red.d - sig.d < 1500) show = "approach";
      }
      const colors = [0x3dff6a, 0xffc83a, 0xff3b30];
      sig.mats.forEach((mat, i) => {
        const on = sig.hues[i] === show;
        mat.color.setHex(on ? colors[i] : 0x1a1c1b);
        sig.halos[i].visible = on;
        const dist = Math.max(40, Math.abs(sig.d - sim.d));
        const scale = Math.min(36, Math.max(14, dist * 0.045));
        sig.halos[i].scale.set(scale, scale, 1);
        (sig.halos[i].material as THREE.SpriteMaterial).opacity = on ? 0.95 : 0;
      });
      sig.light.color.setHex(show === "stop" ? 0xff3b30 : show === "approach" ? 0xffc83a : 0x3dff6a);
      sig.light.intensity = 40;
    }
  }

  let raf = 0;
  let last = performance.now();
  let acc = 0;
  const step = 1 / 60;
  const camForward = new THREE.Vector3();

  function tick(now: number) {
    const frameDt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (sim.running) {
      acc += frameDt;
      let n = 0;
      while (acc >= step && n < 5) {
        physics(step);
        acc -= step;
        n++;
      }
    } else acc = 0;
    sim.radioT -= frameDt;
    frameCamera(frameDt);
    updateSignals();
    const h = input();
    audio.update(sim.notch, sim.speed, h.horn && sim.running, Math.max(0, sim.cyl - sim.prevCyl) / Math.max(frameDt, 0.001));
    sim.prevCyl = sim.cyl;
    waterMap.offset.y -= frameDt * 0.015;
    sky.material.uniforms.time.value += frameDt;
    sim.hudT += frameDt;
    if (sim.hudT > 0.12) {
      sim.hudT = 0;
      pushHud();
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
    void camForward;
  }

  function resize() {
    const parent = canvas.parentElement;
    const w = parent?.clientWidth || window.innerWidth;
    const h = parent?.clientHeight || window.innerHeight;
    if (w < 2 || h < 2) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  resize();
  const ro = new ResizeObserver(() => resize());
  if (canvas.parentElement) ro.observe(canvas.parentElement);

  function onKeyDown(e: KeyboardEvent) {
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
    keys.add(e.code);
    if (e.repeat) return;
    if (e.code === "KeyC") cycleCamera();
    if (e.code === "KeyL") toggleLights();
    if (e.code === "KeyM") toggleMute();
    if (e.code === "KeyX") triggerEmergency();
  }
  function onKeyUp(e: KeyboardEvent) {
    keys.delete(e.code);
  }
  function onBlur() {
    keys.clear();
  }
  function onVis() {
    if (document.visibilityState === "visible") audio.unlock();
  }
  function fingerSpan() {
    const pts = [...fingers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }
  function onCanvasDown(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinchDist = 0;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* the gesture still tracks while the pointer stays over the view */
    }
  }
  function onCanvasMove(e: PointerEvent) {
    const prev = fingers.get(e.pointerId);
    if (!prev) return;
    const x = e.clientX;
    const y = e.clientY;
    if (fingers.size >= 2) {
      prev.x = x;
      prev.y = y;
      const span = fingerSpan();
      if (pinchDist > 12 && span > 12) camZoom = Math.min(3.2, Math.max(0.42, camZoom * (pinchDist / span)));
      pinchDist = span;
      dragLatch = true;
      return;
    }
    if (dragLatch) {
      dragLatch = false;
      prev.x = x;
      prev.y = y;
      return;
    }
    const dx = x - prev.x;
    const dy = y - prev.y;
    prev.x = x;
    prev.y = y;
    orbitYaw += dx * 0.0055;
    orbitPitch = Math.max(-0.55, Math.min(1.05, orbitPitch - dy * 0.0045));
  }
  function onCanvasUp(e: PointerEvent) {
    fingers.delete(e.pointerId);
    pinchDist = 0;
    if (fingers.size === 1) dragLatch = true;
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    camZoom = Math.min(3.2, Math.max(0.42, camZoom * Math.exp(e.deltaY * 0.0011)));
  }
  canvas.addEventListener("pointerdown", onCanvasDown);
  canvas.addEventListener("pointermove", onCanvasMove);
  canvas.addEventListener("pointerup", onCanvasUp);
  canvas.addEventListener("pointercancel", onCanvasUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVis);

  function cycleCamera() {
    const order: CameraMode[] = ["chase", "cab", "hood", "railfan"];
    sim.camera = order[(order.indexOf(sim.camera) + 1) % order.length];
    orbitYaw = 0;
    orbitPitch = 0;
    sim.snap = true;
    pushHud();
  }
  function toggleLights() {
    sim.lights = !sim.lights;
    pushHud();
  }
  function toggleMute() {
    audio.setMuted(!audio.muted);
    pushHud();
  }

  window.__controlsTest = {
    getYaw: () => sampleAt(sim.d).yaw,
    getSpeed: () => sim.speed,
    getOrbitYaw: () => orbitYaw,
    getZoom: () => camZoom,
    setKeys: (codes: string[]) => {
      qaKeys = codes;
    },
    setSteer: (v: number) => {
      forcedSteer = v;
    },
  };
  window.__vdReady = true;

  resetRun(jobById("local"), false);
  raf = requestAnimationFrame(tick);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("pointerdown", onCanvasDown);
      canvas.removeEventListener("pointermove", onCanvasMove);
      canvas.removeEventListener("pointerup", onCanvasUp);
      canvas.removeEventListener("pointercancel", onCanvasUp);
      canvas.removeEventListener("wheel", onWheel);
      ro.disconnect();
      audio.dispose();
      renderer.dispose();
      window.__vdReady = false;
    },
    start(jobId: string) {
      audio.unlock();
      resetRun(jobById(jobId), true);
    },
    preview(jobId: string) {
      if (sim.running) return;
      resetRun(jobById(jobId), false);
    },
    cutOff() {
      if (sim.running) finish(false);
    },
    setHeld(name, down) {
      held[name] = down;
    },
    cycleCamera,
    toggleLights,
    toggleMute,
    emergency: triggerEmergency,
    unlock() {
      audio.unlock();
    },
  };
}
