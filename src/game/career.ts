import { MARK, MILE, ROUTE_LEN } from "./route";

export type TimeOfDay = "dawn" | "afternoon" | "dusk";
export type CarKind = "box" | "hopper" | "tank" | "gondola" | "passenger" | "caboose";
export type StopKind = "station" | "meet" | "terminal";
export type QualId = "mountain" | "passenger";

export type Loco = {
  id: string;
  name: string;
  number: string;
  hp: number;
  teKn: number;
  length: number;
  kind: "switcher" | "road" | "heavy" | "passenger";
};

export type StopDef = { d: number; name: string; hold: number; kind: StopKind };

export type Job = {
  id: string;
  name: string;
  symbol: string;
  blurb: string;
  loco: string;
  tons: number;
  cars: { kind: CarKind; n: number }[];
  caboose: boolean;
  pay: number;
  par: number;
  time: TimeOfDay;
  qual: QualId | null;
  meet: boolean;
  fast: boolean;
  /** Spot and load on the yard track before the switch will let you out. */
  load: boolean;
  stops: StopDef[];
  maxD: number;
};

export type Rank = { xp: number; title: string };

export const RANKS: Rank[] = [
  { xp: 0, title: "Hostler" },
  { xp: 350, title: "Yard Engineer" },
  { xp: 1100, title: "Local Engineer" },
  { xp: 2600, title: "Road Engineer" },
  { xp: 4800, title: "Senior Engineer" },
  { xp: 8200, title: "Road Foreman" },
];

export const LOCOS: Record<string, Loco> = {
  sw1500: { id: "sw1500", name: "SW1500", number: "1204", hp: 1500, teKn: 300, length: 13.6, kind: "switcher" },
  gp38: { id: "gp38", name: "GP38-2", number: "2218", hp: 2000, teKn: 290, length: 17.6, kind: "road" },
  sd40: { id: "sd40", name: "SD40-2", number: "3056", hp: 3000, teKn: 420, length: 20.8, kind: "heavy" },
  f40: { id: "f40", name: "F40PH", number: "274", hp: 3000, teKn: 270, length: 17.2, kind: "passenger" },
};

export const QUALS: Record<QualId, { title: string; cost: number; rep: number; detail: string }> = {
  mountain: {
    title: "Mountain grade",
    cost: 2800,
    rep: 60,
    detail: "Air, dynamic brake, and the 1.5% into Hale. Unlocks Summit Stone and the grain drag.",
  },
  passenger: {
    title: "Passenger rules",
    cost: 4600,
    rep: 70,
    detail: "Station stops, higher speed, the evening extra, and the night mail.",
  },
};

export const JOBS: Job[] = [
  {
    id: "yard",
    name: "First trick hostling",
    symbol: "YD-1",
    blurb: "You start on the yard track beside the dock. Load the cars, line the switch for the main, and pull to the departure lead.",
    loco: "sw1500",
    tons: 280,
    cars: [
      { kind: "box", n: 2 },
      { kind: "tank", n: 1 },
      { kind: "hopper", n: 1 },
    ],
    caboose: false,
    pay: 260,
    par: 160,
    time: "afternoon",
    qual: null,
    meet: false,
    fast: false,
    load: true,
    stops: [
      { d: MARK.yardSpot, name: "Dock", hold: 8, kind: "station" },
      { d: MARK.yardEnd, name: "Departure lead", hold: 5, kind: "terminal" },
    ],
    maxD: MARK.yardEnd + 380,
  },
  {
    id: "local",
    name: "River Local",
    symbol: "CV-2",
    blurb: "Merchandise for the valley towns. Stop at Mill River, hold for the meet at East Ferry, tie up at Tidewater.",
    loco: "gp38",
    tons: 920,
    cars: [
      { kind: "box", n: 3 },
      { kind: "hopper", n: 2 },
      { kind: "tank", n: 1 },
      { kind: "gondola", n: 2 },
    ],
    caboose: true,
    pay: 880,
    par: 560,
    time: "afternoon",
    qual: null,
    meet: true,
    fast: false,
    load: false,
    stops: [
      { d: MARK.mill, name: "Mill River", hold: 7, kind: "station" },
      { d: MARK.ferryStop, name: "East Ferry meet", hold: 9, kind: "meet" },
      { d: MARK.hale, name: "Hale's Landing", hold: 7, kind: "station" },
      { d: MARK.tide, name: "Tidewater", hold: 6, kind: "terminal" },
    ],
    maxD: ROUTE_LEN,
  },
  {
    id: "stone",
    name: "Summit Stone",
    symbol: "ST-9",
    blurb: "Loaded hoppers for the river dock. The grade out of East Ferry will tell you if you rushed the throttle.",
    loco: "sd40",
    tons: 2800,
    cars: [{ kind: "hopper", n: 16 }],
    caboose: true,
    pay: 1620,
    par: 820,
    time: "dawn",
    qual: "mountain",
    meet: true,
    fast: false,
    load: false,
    stops: [
      { d: MARK.ferryStop, name: "East Ferry meet", hold: 9, kind: "meet" },
      { d: MARK.hale, name: "Hale setout", hold: 8, kind: "station" },
      { d: MARK.tide, name: "Tidewater dock", hold: 6, kind: "terminal" },
    ],
    maxD: ROUTE_LEN,
  },
  {
    id: "extra",
    name: "Evening passenger extra",
    symbol: "PX-4",
    blurb: "Four coaches and a clock. Higher speed, no meet, and the platforms will not forgive a rough stop.",
    loco: "f40",
    tons: 460,
    cars: [{ kind: "passenger", n: 4 }],
    caboose: false,
    pay: 1480,
    par: 470,
    time: "dusk",
    qual: "passenger",
    meet: false,
    fast: true,
    load: false,
    stops: [
      { d: MARK.mill, name: "Mill River", hold: 10, kind: "station" },
      { d: MARK.hale, name: "Hale's Landing", hold: 10, kind: "station" },
      { d: MARK.tide, name: "Tidewater", hold: 8, kind: "terminal" },
    ],
    maxD: ROUTE_LEN,
  },
];

export function jobById(id: string): Job {
  return JOBS.find((j) => j.id === id) ?? JOBS[1];
}

export function locoById(id: string): Loco {
  return LOCOS[id] ?? LOCOS.gp38;
}

const KEY = "valley-division-v1";

export type JobRecord = { runs: number; bestPay: number };

export type Career = {
  version: 1;
  name: string;
  cash: number;
  xp: number;
  reputation: number;
  miles: number;
  trips: number;
  quals: Record<QualId, boolean>;
  jobs: Record<string, JobRecord>;
};

export function defaultCareer(): Career {
  return {
    version: 1,
    name: "Engineer",
    cash: 640,
    xp: 0,
    reputation: 74,
    miles: 0,
    trips: 0,
    quals: { mountain: false, passenger: false },
    jobs: {},
  };
}

export function loadCareer(): Career {
  if (typeof localStorage === "undefined") return defaultCareer();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultCareer();
    const parsed = JSON.parse(raw) as Partial<Career>;
    if (!parsed || parsed.version !== 1) return defaultCareer();
    const base = defaultCareer();
    return {
      ...base,
      ...parsed,
      version: 1,
      quals: { ...base.quals, ...parsed.quals },
      jobs: { ...parsed.jobs },
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.slice(0, 24) : base.name,
    };
  } catch {
    return defaultCareer();
  }
}

export function saveCareer(c: Career) {
  localStorage.setItem(KEY, JSON.stringify(c));
}

export function rankFor(xp: number): Rank {
  let current = RANKS[0];
  for (const r of RANKS) if (xp >= r.xp) current = r;
  return current;
}

export function nextRank(xp: number): Rank | null {
  for (const r of RANKS) if (xp < r.xp) return r;
  return null;
}

export function qualLocked(c: Career, job: Job): string | null {
  if (!job.qual) return null;
  if (c.quals[job.qual]) return null;
  const q = QUALS[job.qual];
  if (c.reputation < q.rep) return `Needs reputation ${q.rep}`;
  return `Qualify · $${q.cost.toLocaleString("en-US")}`;
}

export function buyQual(c: Career, id: QualId): Career | null {
  const q = QUALS[id];
  if (c.quals[id] || c.cash < q.cost || c.reputation < q.rep) return null;
  const next: Career = {
    ...c,
    cash: c.cash - q.cost,
    quals: { ...c.quals, [id]: true },
  };
  saveCareer(next);
  return next;
}

export type RunResult = {
  jobId: string;
  completed: boolean;
  seconds: number;
  miles: number;
  fuelGal: number;
  overSeconds: number;
  missed: number;
  rough: number;
  smoothStops: number;
  red: number;
  emergencyCount: number;
};

export type PayLine = { label: string; amount: number };

export type Report = {
  title: string;
  completed: boolean;
  lines: PayLine[];
  pay: number;
  xpGain: number;
  rep: number;
  repDelta: number;
  rank: string;
  rankedUp: boolean;
  grade: string;
};

export function settle(c: Career, run: RunResult): { career: Career; report: Report } {
  const job = jobById(run.jobId);
  const lines: PayLine[] = [];
  let pay = run.completed ? job.pay : 40;
  lines.push({ label: run.completed ? "Trip rate" : "Called off the board", amount: run.completed ? job.pay : 40 });
  const onTime = run.completed && run.seconds <= job.par && run.missed === 0 && run.red === 0;
  if (onTime) {
    const bonus = Math.round(job.pay * 0.16);
    pay += bonus;
    lines.push({ label: "On the advertised", amount: bonus });
  }
  if (run.smoothStops) {
    const bonus = run.smoothStops * 50;
    pay += bonus;
    lines.push({ label: "Smooth stops", amount: bonus });
  }
  const fuel = Math.round(run.fuelGal * 3.2);
  pay -= fuel;
  lines.push({ label: "Fuel", amount: -fuel });
  const over = Math.round(run.overSeconds * 8);
  if (over) {
    pay -= over;
    lines.push({ label: "Overspeed", amount: -over });
  }
  if (run.missed) {
    const hit = run.missed * 170;
    pay -= hit;
    lines.push({ label: "Missed stops", amount: -hit });
  }
  if (run.rough) {
    const hit = run.rough * 70;
    pay -= hit;
    lines.push({ label: "Rough stops", amount: -hit });
  }
  if (run.red) {
    pay -= run.red * 780;
    lines.push({ label: "Signal violated", amount: -run.red * 780 });
  }
  if (run.emergencyCount) {
    const hit = run.emergencyCount * 140;
    pay -= hit;
    lines.push({ label: "Emergency application", amount: -hit });
  }
  if (!run.completed) pay = Math.min(pay, 40);
  pay = Math.max(0, Math.round(pay));

  let rep = c.reputation;
  if (run.completed && run.red === 0 && run.missed === 0 && run.overSeconds < 6) rep += 2;
  rep -= run.red * 9;
  rep -= run.missed * 3;
  if (run.overSeconds > 10) rep -= 2;
  if (run.rough) rep -= 1;
  rep = Math.max(0, Math.min(100, rep));

  const xpGain = Math.max(
    10,
    (run.completed ? 100 : 24) + run.smoothStops * 16 + (onTime ? 40 : 0) - run.red * 40 - run.missed * 15,
  );
  const before = rankFor(c.xp).title;
  const xp = c.xp + xpGain;
  const after = rankFor(xp).title;

  const prev = c.jobs[job.id] ?? { runs: 0, bestPay: 0 };
  const next: Career = {
    ...c,
    cash: c.cash + pay,
    xp,
    reputation: rep,
    miles: c.miles + run.miles,
    trips: c.trips + 1,
    jobs: {
      ...c.jobs,
      [job.id]: { runs: prev.runs + 1, bestPay: Math.max(prev.bestPay, pay) },
    },
  };
  saveCareer(next);

  let grade = "C";
  if (run.completed && run.red === 0 && run.missed === 0 && run.rough === 0 && onTime) grade = "A";
  else if (run.completed && run.red === 0 && run.missed === 0) grade = "B";
  else if (!run.completed || run.red > 0) grade = "D";

  return {
    career: next,
    report: {
      title: job.name,
      completed: run.completed,
      lines,
      pay,
      xpGain,
      rep,
      repDelta: rep - c.reputation,
      rank: after,
      rankedUp: before !== after,
      grade,
    },
  };
}

export function milesBetween(a: number, b: number) {
  return Math.abs(b - a) / MILE;
}
