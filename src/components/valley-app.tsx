import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  AlertTriangle,
  Award,
  Camera,
  ChevronDown,
  ChevronUp,
  Fuel,
  Lock,
  Map,
  Radio,
  Sunrise,
  Sunset,
  Sun,
  TrainFront,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  JOBS,
  QUALS,
  buyQual,
  defaultCareer,
  jobById,
  loadCareer,
  locoById,
  milesBetween,
  nextRank,
  qualLocked,
  rankFor,
  saveCareer,
  type Career,
  type Job,
  type QualId,
  type Report,
} from "@/game/career";
import { MARK, MILE, ROUTE_LEN, SAMPLES, sampleAt } from "@/game/route";
import type { GameHandle, HoldName, Hud } from "@/game/world";

const emptyHud = (): Hud => ({
  running: false,
  ready: false,
  speedMph: 0,
  limitMph: 15,
  notch: 0,
  pipe: 90,
  cyl: 0,
  mile: 0,
  gradePct: 0,
  aspect: "none",
  signalName: "",
  signalMi: -1,
  nextStop: "",
  nextStopMi: 0,
  order: "Pick a job off the board.",
  fuel: 0,
  clock: "14:12",
  loco: "",
  tons: 0,
  cars: 0,
  camera: "chase",
  lights: true,
  muted: false,
  overspeed: false,
  radio: "Calling the yard…",
  warning: "",
  job: "",
  switchMain: false,
});

function money(n: number) {
  const sign = n < 0 ? "−" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US")}`;
}

function notchKind(n: number) {
  if (n < 0) return "Dyn brake";
  if (n === 0) return "Idle";
  return "Throttle";
}

function notchNum(n: number) {
  return n === 0 ? "0" : String(Math.abs(n));
}

function notchText(n: number) {
  if (n === 0) return "Idle";
  return `${notchKind(n)} ${notchNum(n)}`;
}

function aspectClass(aspect: Hud["aspect"]) {
  if (aspect === "stop") return "bg-signal";
  if (aspect === "approach") return "bg-amber";
  if (aspect === "clear") return "bg-clear";
  return "bg-steel";
}

function Hold({
  label,
  sub,
  name,
  gameRef,
  tone = "panel",
  className = "",
  icon,
}: {
  label: string;
  sub?: string;
  name: HoldName;
  gameRef: RefObject<GameHandle | null>;
  tone?: "panel" | "signal" | "amber";
  className?: string;
  icon?: ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const ids = useRef(new Set<number>());

  const apply = (down: boolean) => {
    const el = ref.current;
    if (el) {
      el.dataset.down = down ? "1" : "0";
      el.setAttribute("aria-pressed", down ? "true" : "false");
    }
    gameRef.current?.setHeld(name, down);
  };

  useEffect(() => {
    const end = (e: PointerEvent) => {
      if (!ids.current.has(e.pointerId)) return;
      ids.current.delete(e.pointerId);
      if (ids.current.size === 0) apply(false);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      ids.current.clear();
      apply(false);
    };
    // apply closes over a stable ref and the hold name
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const toneClass =
    tone === "signal" ? "bg-signal text-ink" : tone === "amber" ? "bg-amber text-ink" : "border border-line bg-panel text-cream";

  return (
    <button
      ref={ref}
      type="button"
      aria-label={sub ? `${label} ${sub}` : label}
      className={`cab-key ${toneClass} ${className}`}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        ids.current.add(e.pointerId);
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* some mobile browsers reject capture; the window listener still releases */
        }
        apply(true);
      }}
    >
      {icon}
      <span className="text-base leading-none font-semibold tracking-wide">{label}</span>
      {sub ? <span className="cab-key-sub">{sub}</span> : null}
    </button>
  );
}

function aspectTone(aspect: Hud["aspect"]) {
  if (aspect === "stop") return "text-signal";
  if (aspect === "approach") return "text-amber";
  if (aspect === "clear") return "text-clear";
  return "text-steel";
}

function signalLine(hud: Hud) {
  if (hud.aspect === "none") return "No signal ahead";
  const dist = hud.signalMi < 0 ? "" : hud.signalMi >= 1 ? ` · ${hud.signalMi.toFixed(1)} mi` : ` · ${hud.signalMi.toFixed(2)} mi`;
  const name = hud.signalName ? ` · ${hud.signalName}` : "";
  return `${hud.aspect}${name}${dist}`;
}

function gradeWord(pct: number) {
  if (pct > 0.2) return "uphill";
  if (pct < -0.2) return "downhill";
  return "level";
}

function gradeTone(pct: number) {
  if (pct >= 1) return "text-signal";
  if (pct > 0.2) return "text-amber";
  if (pct < -0.2) return "text-clear";
  return "text-cream";
}

function gradeInk(g: number) {
  const pct = g * 100;
  if (pct >= 1) return "#d35a42";
  if (pct > 0.35) return "#e0a04a";
  if (pct < -0.35) return "#7ea37a";
  return "#b7b1a3";
}

const MAP = (() => {
  const step = Math.max(1, Math.ceil(SAMPLES.length / 140));
  const pts = [];
  for (let i = 0; i < SAMPLES.length; i += step) pts.push(SAMPLES[i]);
  const tail = SAMPLES[SAMPLES.length - 1];
  if (pts[pts.length - 1] !== tail) pts.push(tail);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const W = 320;
  const H = 168;
  const pad = 16;
  const round = (n: number) => Math.round(n * 100) / 100;
  const to = (x: number, z: number) => ({
    x: round(pad + ((x - minX) / (maxX - minX || 1)) * (W - pad * 2)),
    y: round(pad + ((maxZ - z) / (maxZ - minZ || 1)) * (H - pad * 2)),
  });
  const towns = [
    { name: "Briar", d: MARK.start },
    { name: "Mill R.", d: MARK.mill },
    { name: "Ferry", d: MARK.ferryStop },
    { name: "Hale", d: MARK.hale },
    { name: "Tide", d: MARK.tide },
  ].map((t) => {
    const s = sampleAt(t.d);
    return { ...t, ...to(s.x, s.z) };
  });
  return { pts, to, towns, W, H, minY, maxY };
})();

function RouteMap({ mile, dock }: { mile: number | null; dock?: boolean }) {
  const here = mile == null ? null : sampleAt(Math.max(0, Math.min(ROUTE_LEN - 1, mile * MILE)));
  const dot = here ? MAP.to(here.x, here.z) : null;
  const along = here ? here.d / ROUTE_LEN : null;
  return (
    <div className={dock ? "route-map-static border border-line bg-ink" : "route-map border border-line bg-ink"}>
      <div className="flex items-center justify-between px-2 pt-1">
        <p className="text-[0.65rem] tracking-widest text-steel uppercase">Valley map</p>
        <p className="flex items-center gap-1.5 text-[0.65rem] tracking-wide text-cream-dim uppercase">
          <span className="inline-block h-1 w-3 bg-amber" />
          Up
          <span className="inline-block h-1 w-3 bg-clear" />
          Down
        </p>
      </div>
      <svg viewBox={`0 0 ${MAP.W} ${MAP.H}`} className="block h-auto w-full" role="img" aria-label="Route map">
        {MAP.pts.slice(1).map((p, i) => {
          const a = MAP.pts[i];
          const pa = MAP.to(a.x, a.z);
          const pb = MAP.to(p.x, p.z);
          return <line key={a.d} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke={gradeInk(p.grade)} strokeWidth="4" strokeLinecap="round" />;
        })}
        {MAP.towns.map((t) => (
          <g key={t.name}>
            <circle cx={t.x} cy={t.y} r="3" fill="#e6e0d2" />
            <text x={t.x + 6} y={t.y + 3} fill="#e6e0d2" fontSize="11" fontFamily="IBM Plex Mono, ui-monospace, monospace">
              {t.name}
            </text>
          </g>
        ))}
        {dot ? (
          <g>
            <circle cx={dot.x} cy={dot.y} r="7" fill="#101311" stroke="#e0a04a" strokeWidth="2" />
            <circle cx={dot.x} cy={dot.y} r="2.5" fill="#e0a04a" />
          </g>
        ) : null}
      </svg>
      <svg viewBox="0 0 320 42" className="block h-9 w-full" role="img" aria-label="Track grade profile">
        <polyline
          fill="none"
          stroke="#e0a04a"
          strokeWidth="2"
          points={MAP.pts
            .map((p) => {
              const x = 8 + (p.d / ROUTE_LEN) * 304;
              const y = 36 - ((p.y - MAP.minY) / (MAP.maxY - MAP.minY || 1)) * 28;
              return `${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(" ")}
        />
        {along != null ? (
          <line x1={Math.round((8 + along * 304) * 10) / 10} y1="4" x2={Math.round((8 + along * 304) * 10) / 10} y2="40" stroke="#e6e0d2" strokeWidth="1.5" />
        ) : null}
      </svg>
      <p className="px-2 pb-1 text-[0.65rem] tracking-wide text-steel uppercase">Profile climbs to Hale, then drops to the dock</p>
    </div>
  );
}

function RunHud({ hud }: { hud: Hud }) {
  return (
    <div className="run-hud pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="bg-ink px-3 py-2">
          <p className={`num text-5xl leading-none ${hud.overspeed ? "text-signal" : "text-cream"}`}>{hud.speedMph.toFixed(0)}</p>
          <p className="text-xs tracking-widest text-steel uppercase">mph · limit {hud.limitMph}</p>
        </div>
        <div className="bg-ink px-3 py-2">
          <p className={`num text-3xl leading-none ${gradeTone(hud.gradePct)}`}>
            {hud.gradePct > 0.05 ? "+" : ""}
            {hud.gradePct.toFixed(1)}%
          </p>
          <p className="text-xs tracking-widest text-steel uppercase">grade · {gradeWord(hud.gradePct)}</p>
        </div>
        <div className="bg-ink px-3 py-2 text-right">
          <p className="num text-2xl leading-none text-amber">{notchText(hud.notch)}</p>
          <p className="text-xs tracking-widest text-steel uppercase">
            pipe {hud.pipe.toFixed(0)} · cyl {hud.cyl.toFixed(0)}
          </p>
        </div>
      </div>
      <div className="max-w-xl bg-ink px-3 py-2">
        <p className={`flex items-center gap-2 text-lg font-semibold tracking-wide uppercase ${aspectTone(hud.aspect)}`}>
          <span className={`inline-block size-3.5 shrink-0 rounded-full ${aspectClass(hud.aspect)}`} />
          <span className="truncate">{signalLine(hud)}</span>
        </p>
        <p className="mt-1 text-base leading-snug text-cream">{hud.order}</p>
      </div>
      {hud.warning ? (
        <p className="flex w-fit items-center gap-2 bg-signal px-3 py-2 text-sm font-semibold tracking-widest text-ink uppercase">
          <AlertTriangle className="size-4" />
          {hud.warning}
        </p>
      ) : null}
      <div className="run-radio max-w-xl bg-ink px-3 py-2">
        <p className="flex items-center gap-2 text-xs tracking-widest text-cream-dim uppercase">
          <Radio className="size-3.5 text-amber" />
          Dispatch
        </p>
        <p className="run-radio-body mt-1 text-base leading-snug">{hud.radio}</p>
      </div>
      <p className="flex w-fit items-center gap-2 bg-ink px-2 py-1 text-xs tracking-wide text-cream-dim uppercase">
        <Fuel className="size-3.5" />
        MP {hud.mile.toFixed(2)} · {hud.nextStop} {hud.nextStopMi >= 0 ? `${hud.nextStopMi.toFixed(2)} mi` : ""} · {hud.fuel.toFixed(0)} gal ·{" "}
        {hud.clock}
      </p>
    </div>
  );
}

function CabStand({
  gameRef,
  hud,
  mapOn,
  onToggleMap,
}: {
  gameRef: RefObject<GameHandle | null>;
  hud: Hud;
  mapOn: boolean;
  onToggleMap: () => void;
}) {
  const game = () => gameRef.current;
  return (
    <div className="cab-stand">
      <div className="flex gap-2">
        <button type="button" className="flex h-12 min-w-12 flex-1 items-center justify-center border border-line bg-panel" aria-label="Camera" onClick={() => game()?.cycleCamera()}>
          <Camera className="size-5" />
        </button>
        <button
          type="button"
          className={`h-12 min-w-11 flex-1 border border-line bg-panel px-1 text-xs tracking-wide uppercase ${hud.lights ? "text-amber" : "text-cream-dim"}`}
          onClick={() => game()?.toggleLights()}
        >
          Lamp
        </button>
        <button type="button" className="flex h-12 min-w-12 flex-1 items-center justify-center border border-line bg-panel" aria-label={hud.muted ? "Unmute" : "Mute"} onClick={() => game()?.toggleMute()}>
          {hud.muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
        </button>
        <button type="button" className="h-12 min-w-11 flex-1 border border-signal bg-panel px-1 text-xs tracking-wide text-signal uppercase" onClick={() => game()?.emergency()}>
          Emerg
        </button>
        <button
          type="button"
          className={`h-12 min-w-11 flex-1 border border-line bg-panel px-1 text-xs tracking-wide uppercase ${mapOn ? "text-amber" : "text-cream-dim"}`}
          onClick={onToggleMap}
        >
          <Map className="mx-auto size-4" />
          Map
        </button>
        <button type="button" className="h-12 min-w-11 flex-1 border border-line bg-panel px-1 text-xs tracking-wide text-cream-dim uppercase" onClick={() => game()?.cutOff()}>
          Tie
        </button>
      </div>
      <div className="cab-grid">
        <div className="cab-left">
          <Hold label="HORN" name="horn" gameRef={gameRef} className="cab-horn" />
          <button
            type="button"
            className={`flex h-16 min-w-16 flex-col items-center justify-center border border-line bg-panel px-1 text-xs tracking-wide uppercase ${hud.switchMain ? "text-clear" : "text-signal"}`}
            onClick={() => game()?.lineSwitch()}
          >
            Line
            <span className="text-[0.65rem] tracking-widest">{hud.switchMain ? "Main" : "Yard"}</span>
          </button>
        </div>
        <div className="cab-power">
          <div className="cab-notch">
            <span className="text-xs tracking-widest text-steel uppercase">{notchKind(hud.notch)}</span>
            <span className="num text-xl text-amber">{notchNum(hud.notch)}</span>
            <span className="num text-sm text-cream-dim">{hud.pipe.toFixed(0)}</span>
          </div>
          <div className="cab-pair">
            <Hold label="POWER" sub="hold" name="notchUp" gameRef={gameRef} tone="amber" icon={<ChevronUp className="size-5" />} />
            <Hold label="LESS" sub={hud.notch > 0 ? "ease" : "dyn"} name="notchDown" gameRef={gameRef} icon={<ChevronDown className="size-5" />} />
          </div>
          <div className="cab-pair">
            <Hold label="AIR" sub="brake" name="brake" gameRef={gameRef} tone="signal" />
            <Hold label="REL" sub="release" name="release" gameRef={gameRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ValleyApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<GameHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [hud, setHud] = useState<Hud>(emptyHud);
  const [career, setCareer] = useState<Career>(defaultCareer);
  const [selected, setSelected] = useState("local");
  const [phase, setPhase] = useState<"dispatch" | "run" | "report">("dispatch");
  const [report, setReport] = useState<Report | null>(null);
  const [fail, setFail] = useState("");
  const [showMap, setShowMap] = useState(true);

  useEffect(() => {
    setCareer(loadCareer());
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let dead = false;
    let handle: GameHandle | null = null;
    void import("@/game/world")
      .then(({ mountGame }) => {
        if (dead) return;
        handle = mountGame(canvas, {
          onHud: (next) => setHud(next),
          onReport: (next) => {
            setReport(next);
            setCareer(loadCareer());
            setPhase("report");
          },
        });
        gameRef.current = handle;
        setReady(true);
      })
      .catch((err: unknown) => {
        setFail(err instanceof Error ? err.message : "The valley failed to load.");
      });
    return () => {
      dead = true;
      handle?.destroy();
      gameRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready || phase !== "dispatch") return;
    gameRef.current?.preview(selected);
  }, [ready, phase, selected]);

  const job = jobById(selected);
  const lock = qualLocked(career, job);
  const rank = rankFor(career.xp);
  const upcoming = nextRank(career.xp);
  const rankPct = upcoming ? Math.min(100, ((career.xp - rank.xp) / (upcoming.xp - rank.xp)) * 100) : 100;

  function startShift() {
    if (!ready || lock) return;
    const game = gameRef.current;
    if (!game) return;
    game.unlock();
    game.start(selected);
    setPhase("run");
    setReport(null);
  }

  function qualify(id: QualId) {
    const next = buyQual(career, id);
    if (next) setCareer(next);
  }

  const timeIcon =
    job.time === "dawn" ? <Sunrise className="size-4" /> : job.time === "dusk" ? <Sunset className="size-4" /> : <Sun className="size-4" />;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-ink text-cream select-none">
      <div className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" />
        <div className="vignette pointer-events-none absolute inset-0" />

        {phase === "run" ? (
          <>
            <RunHud hud={hud} />
            {showMap ? <RouteMap mile={hud.mile} /> : null}
            <CabStand gameRef={gameRef} hud={hud} mapOn={showMap} onToggleMap={() => setShowMap((v) => !v)} />
          </>
        ) : null}

        {phase === "dispatch" ? (
          <div className="absolute inset-x-0 top-1/3 bottom-0 overflow-y-auto border-t border-line bg-ink sm:inset-y-0 sm:right-auto sm:w-full sm:max-w-md sm:border-t-0 sm:border-r">
            <div className="flex items-end justify-between gap-3 px-4 pt-4">
              <div>
                <p className="text-xs tracking-[0.28em] text-amber uppercase">New England regional</p>
                <h1 className="font-display text-4xl leading-none text-cream">Valley Division</h1>
              </div>
              <TrainFront className="mb-1 size-8 text-steel" />
            </div>
            <p className="px-4 pt-2 text-sm leading-relaxed text-cream-dim">
              A late-autumn freight railroad. Notch, air, and signals — from the yard at Briar to the dock at Tidewater.
            </p>

            <div className="mx-4 mt-4 border border-line bg-cab px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <label className="min-w-0 flex-1">
                  <span className="text-xs tracking-[0.18em] text-steel uppercase">Engineer</span>
                  <input
                    value={career.name}
                    maxLength={24}
                    onChange={(e) => {
                      const next = { ...career, name: e.target.value };
                      setCareer(next);
                      saveCareer(next);
                    }}
                    className="mt-1 w-full border border-line bg-panel px-2 py-1.5 text-lg text-cream outline-none"
                  />
                </label>
                <div className="text-right">
                  <p className="text-xs tracking-[0.18em] text-steel uppercase">{rank.title}</p>
                  <p className="num text-xl text-amber">{money(career.cash)}</p>
                  <p className="text-xs text-cream-dim">Rep {career.reputation}</p>
                </div>
              </div>
              <div className="mt-3 h-1 bg-panel">
                <div className="h-1 bg-amber" style={{ width: `${rankPct}%` }} />
              </div>
              <p className="mt-1 text-xs tracking-wide text-steel uppercase">
                {upcoming ? `${upcoming.title} at ${upcoming.xp} · ${career.miles.toFixed(1)} mi` : "Road foreman"}
              </p>
            </div>

            <ul className="mt-4 flex flex-col gap-2 px-4">
              {JOBS.map((item) => (
                <JobRow
                  key={item.id}
                  job={item}
                  career={career}
                  active={item.id === selected}
                  onSelect={() => setSelected(item.id)}
                />
              ))}
            </ul>

            <div className="mx-4 mt-4 border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-2xl leading-none">{job.name}</h2>
                <span className="flex items-center gap-1 text-xs tracking-widest text-steel uppercase">
                  {timeIcon}
                  {job.time}
                </span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-cream-dim">{job.blurb}</p>
              <div className="mt-3">
                <RouteMap mile={null} dock />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <Stat k="Symbol" v={job.symbol} />
                <Stat k="Power" v={`${locoById(job.loco).name} ${locoById(job.loco).number}`} />
                <Stat k="Tonnage" v={`${job.tons.toLocaleString("en-US")} t`} />
                <Stat k="Trip rate" v={money(job.pay)} />
                <Stat k="Length" v={`${milesBetween(MARK.start, job.stops[job.stops.length - 1].d).toFixed(1)} mi`} />
                <Stat k="Par" v={`${Math.round(job.par / 60)} min`} />
              </dl>
              <p className="mt-3 text-xs leading-relaxed tracking-wide text-steel uppercase">
                Phone: drag to look, pinch to zoom. Line throws the yard switch. Blow the horn at crossings. Right thumb is power and air.
                Keyboard: W raises the throttle 1–8. S eases it, and past idle S is the dynamic brake. Space is the air brake.
              </p>
              {job.qual && !career.quals[job.qual] ? (
                <button
                  type="button"
                  className="mt-3 flex h-11 w-full items-center justify-center gap-2 border border-amber text-sm tracking-widest text-amber uppercase"
                  onClick={() => qualify(job.qual as QualId)}
                  disabled={career.cash < QUALS[job.qual].cost || career.reputation < QUALS[job.qual].rep}
                >
                  <Award className="size-4" />
                  {QUALS[job.qual].title} · {money(QUALS[job.qual].cost)}
                </button>
              ) : null}
            </div>

            <div className="sticky bottom-0 bg-ink px-4 pt-3 pb-4">
              <button
                type="button"
                disabled={!ready || Boolean(lock)}
                onClick={startShift}
                className="h-12 w-full bg-amber text-lg tracking-[0.2em] text-ink uppercase disabled:opacity-40"
              >
                {ready ? (lock ? "Locked" : "Start") : "Lining the valley"}
              </button>
              {fail ? <p className="mt-2 text-sm text-signal">{fail}</p> : null}
            </div>
          </div>
        ) : null}

        {phase === "report" && report ? (
          <div className="absolute inset-x-0 top-1/4 bottom-0 overflow-y-auto border-t border-line bg-ink sm:inset-y-0 sm:right-auto sm:w-full sm:max-w-md sm:border-t-0 sm:border-r">
            <div className="px-4 pt-4">
              <p className="text-xs tracking-[0.28em] text-amber uppercase">{report.completed ? "Tie-up" : "Off the board"}</p>
              <h2 className="font-display text-4xl leading-none">{report.title}</h2>
              <p className="mt-2 text-sm text-cream-dim">
                Mark {report.grade}
                {report.rankedUp ? ` · promoted to ${report.rank}` : ` · ${report.rank}`}
                {" · "}rep {report.rep} ({report.repDelta >= 0 ? "+" : ""}
                {report.repDelta})
              </p>
            </div>
            <ul className="mx-4 mt-4 border border-line">
              {report.lines.map((line) => (
                <li key={line.label} className="flex items-center justify-between border-b border-line px-3 py-2 text-sm last:border-b-0">
                  <span>{line.label}</span>
                  <span className={`num ${line.amount < 0 ? "text-signal" : "text-cream"}`}>{money(line.amount)}</span>
                </li>
              ))}
              <li className="flex items-center justify-between bg-cab px-3 py-3">
                <span className="tracking-widest uppercase">Pay</span>
                <span className="num text-xl text-amber">{money(report.pay)}</span>
              </li>
            </ul>
            <p className="px-4 pt-3 text-sm text-cream-dim">+{report.xpGain} experience · balance {money(career.cash)}</p>
            <div className="px-4 pt-4 pb-4">
              <button
                type="button"
                className="h-12 w-full bg-amber tracking-[0.2em] text-ink uppercase"
                onClick={() => {
                  setPhase("dispatch");
                  setReport(null);
                }}
              >
                Back to the board
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {phase === "run" ? null : (
        <footer className="shrink-0 border-t border-line bg-cab px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <div className="flex items-center justify-between gap-3 py-2">
            <p className="text-xs tracking-widest text-steel uppercase">Cab order · throttle, air, and the hill</p>
            <p className="num text-sm text-cream-dim">{ready ? "Ready" : "Setting the scene"}</p>
          </div>
        </footer>
      )}
    </div>
  );
}

function JobRow({
  job,
  career,
  active,
  onSelect,
}: {
  job: Job;
  career: Career;
  active: boolean;
  onSelect: () => void;
}) {
  const lock = qualLocked(career, job);
  const record = career.jobs[job.id];
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-center gap-3 border px-3 py-2 text-left ${active ? "border-amber bg-panel" : "border-line bg-ink"}`}
      >
        <span className="num w-12 text-sm text-amber">{job.symbol}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-lg leading-tight">{job.name}</span>
          <span className="block text-xs tracking-wide text-steel uppercase">
            {locoById(job.loco).name} · {job.tons}t · {money(job.pay)}
            {record ? ` · best ${money(record.bestPay)}` : ""}
          </span>
        </span>
        {lock ? <Lock className="size-4 shrink-0 text-steel" /> : null}
      </button>
    </li>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="border border-line px-2 py-1.5">
      <dt className="text-xs tracking-widest text-steel uppercase">{k}</dt>
      <dd className="truncate text-base">{v}</dd>
    </div>
  );
}
