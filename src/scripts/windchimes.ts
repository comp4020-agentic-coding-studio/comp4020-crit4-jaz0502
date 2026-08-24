const SVG_NS = "http://www.w3.org/2000/svg";

const CHIME_COUNT = 9;
// A pentatonic scale so any combination of chimes striking together stays
// consonant — there's no wrong note to hit, only louder or softer ones. Pitched
// an octave up from a plain C major pentatonic (523–1319 Hz) for a bright,
// glassy register rather than a low, heavy one.
const PENTATONIC = [523.25, 587.33, 659.25, 784.0, 880.0, 1046.5, 1174.66, 1318.51];

// How much of the wind's strength turns into torque on each chime. Tuned so a
// single mouse click's gust is enough to swing a chime past STRIKE_THRESHOLD.
const FORCE_SCALE = 0.16;
const STRIKE_THRESHOLD = 0.16; // radians from rest before a chime "strikes"
const REARM_THRESHOLD = STRIKE_THRESHOLD * 0.4;
const GUST_IMPULSE = 11;
const IDLE_MS = 400; // no input for this long and wind starts decaying
const MAX_WIND = 12;

// The branch dips gently toward the middle — chimes hang a fixed gap below
// wherever it passes overhead, so this mirrors the path drawn in index.astro.
function branchY(x: number): number {
  const t = (x - 320) / 320;
  return 52 + 8 * t * t;
}

interface Chime {
  pivotX: number;
  pivotY: number;
  angle: number;
  angularVelocity: number;
  stiffness: number;
  damping: number;
  frequency: number;
  armed: boolean; // false right after a strike, until it swings back near rest
  silent: boolean; // the central wind-catcher sways but never triggers audio
  el: SVGGElement;
}

interface WindState {
  strength: number;
  direction: number; // -1..1
  lastInputAt: number;
}

interface Foliage {
  el: SVGGElement;
  pivotX: number;
  pivotY: number;
  angle: number;
  coupling: number; // heavier/lighter clumps sway by different amounts
}

export function initWindChimes(scene: HTMLElement, svg: SVGSVGElement): void {
  const rigQuery = svg.querySelector<SVGGElement>("#chime-rig");
  if (!rigQuery) return;
  const rig = rigQuery;

  const chimes: Chime[] = [];

  function makeTubeGroup(pivotX: number, pivotY: number, stringLen: number, tubeLen: number, tubeWidth: number) {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("filter", "url(#soft-shadow)");

    const string = document.createElementNS(SVG_NS, "line");
    string.setAttribute("x1", String(pivotX));
    string.setAttribute("y1", String(pivotY));
    string.setAttribute("x2", String(pivotX));
    string.setAttribute("y2", String(pivotY + stringLen));
    string.setAttribute("stroke", "#3d3b34");
    string.setAttribute("stroke-width", "1");
    g.appendChild(string);

    const tubeTop = pivotY + stringLen;
    const tube = document.createElementNS(SVG_NS, "rect");
    tube.setAttribute("x", String(pivotX - tubeWidth / 2));
    tube.setAttribute("y", String(tubeTop));
    tube.setAttribute("width", String(tubeWidth));
    tube.setAttribute("height", String(tubeLen));
    tube.setAttribute("rx", String(tubeWidth / 2));
    tube.setAttribute("fill", "url(#tube-gradient)");
    g.appendChild(tube);

    // A vertical glint layered over the tube's cylindrical shading, fading
    // out down the length — this is what reads as light catching real metal
    // rather than a flat, uniform gradient.
    const glint = document.createElementNS(SVG_NS, "rect");
    glint.setAttribute("x", String(pivotX - tubeWidth * 0.18));
    glint.setAttribute("y", String(tubeTop + 1));
    glint.setAttribute("width", String(tubeWidth * 0.22));
    glint.setAttribute("height", String(tubeLen - 2));
    glint.setAttribute("rx", String(tubeWidth * 0.11));
    glint.setAttribute("fill", "url(#tube-highlight-gradient)");
    glint.setAttribute("style", "mix-blend-mode: screen");
    g.appendChild(glint);

    for (const cy of [tubeTop, tubeTop + tubeLen]) {
      const cap = document.createElementNS(SVG_NS, "circle");
      cap.setAttribute("cx", String(pivotX));
      cap.setAttribute("cy", String(cy));
      cap.setAttribute("r", String(tubeWidth / 2 + 0.75));
      cap.setAttribute("fill", "url(#wood-gradient)");
      g.appendChild(cap);
    }

    rig.appendChild(g);
    return g;
  }

  for (let i = 0; i < CHIME_COUNT; i++) {
    const pivotX = 60 + (i / (CHIME_COUNT - 1)) * (640 - 120);
    const pivotY = branchY(pivotX) + 8;
    const stringLen = 16 + (i % 3) * 7;
    const tubeLen = 118 + ((i * 37) % 58);

    const el = makeTubeGroup(pivotX, pivotY, stringLen, tubeLen, 8);

    chimes.push({
      pivotX,
      pivotY,
      angle: (Math.random() - 0.5) * 0.05,
      angularVelocity: 0,
      // Each chime a little stiffer than the last, so they don't all swing in
      // lockstep — that's most of what makes a row of tubes read as a set.
      stiffness: 1.3 + i * 0.12,
      damping: 0.85,
      frequency: PENTATONIC[i % PENTATONIC.length],
      armed: true,
      silent: false,
      el,
    });
  }

  // A central wind-catcher: bigger, looser, and more visibly restless than
  // the tubes, so the strength of the wind reads at a glance even before any
  // chime strikes. A small wooden disc rather than another metal tube — it
  // never makes sound on its own.
  const catcherPivotX = 320;
  const catcherPivotY = branchY(catcherPivotX) + 8;
  const catcherStringLen = 56;
  const catcherEl = document.createElementNS(SVG_NS, "g");
  catcherEl.setAttribute("filter", "url(#soft-shadow)");
  const catcherString = document.createElementNS(SVG_NS, "line");
  catcherString.setAttribute("x1", String(catcherPivotX));
  catcherString.setAttribute("y1", String(catcherPivotY));
  catcherString.setAttribute("x2", String(catcherPivotX));
  catcherString.setAttribute("y2", String(catcherPivotY + catcherStringLen));
  catcherString.setAttribute("stroke", "#3d3b34");
  catcherString.setAttribute("stroke-width", "1");
  catcherEl.appendChild(catcherString);
  const disc = document.createElementNS(SVG_NS, "circle");
  disc.setAttribute("cx", String(catcherPivotX));
  disc.setAttribute("cy", String(catcherPivotY + catcherStringLen + 11));
  disc.setAttribute("r", "11");
  disc.setAttribute("fill", "url(#orb-gradient)");
  catcherEl.appendChild(disc);
  const orbGlint = document.createElementNS(SVG_NS, "ellipse");
  orbGlint.setAttribute("cx", String(catcherPivotX - 3.2));
  orbGlint.setAttribute("cy", String(catcherPivotY + catcherStringLen + 11 - 4.5));
  orbGlint.setAttribute("rx", "3");
  orbGlint.setAttribute("ry", "1.8");
  orbGlint.setAttribute("fill", "#fff8df");
  orbGlint.setAttribute("opacity", "0.6");
  catcherEl.appendChild(orbGlint);
  rig.appendChild(catcherEl);
  chimes.push({
    pivotX: catcherPivotX,
    pivotY: catcherPivotY,
    angle: 0,
    angularVelocity: 0,
    stiffness: 0.7,
    damping: 0.7,
    frequency: 0,
    armed: false,
    silent: true,
    el: catcherEl,
  });

  // The garden foliage sways too, more slowly and subtly than the delicate
  // tubes — heavier mass, lazier response, so the same gust moves it less.
  const foliage: Foliage[] = Array.from(svg.querySelectorAll<SVGGElement>("[data-pivot-x]")).map((el, i) => ({
    el,
    pivotX: Number(el.dataset.pivotX),
    pivotY: Number(el.dataset.pivotY),
    angle: 0,
    coupling: 0.8 + (i % 2) * 0.35,
  }));

  const wind: WindState = { strength: 0, direction: 1, lastInputAt: 0 };

  let audioCtx: AudioContext | null = null;
  let masterGain: GainNode | null = null;

  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new AudioContext();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 0.7;
      masterGain.connect(audioCtx.destination);
    }
    // Some browsers create a context in "suspended" state even inside a user
    // gesture handler — resuming explicitly is the reliable way to unmute it.
    if (audioCtx.state === "suspended") {
      void audioCtx.resume();
    }
  }

  function strike(chime: Chime, velocity: number) {
    if (!audioCtx || !masterGain || chime.silent) return;
    const ctx = audioCtx;
    const master = masterGain;
    const now = ctx.currentTime;
    const loudness = Math.min(1, Math.abs(velocity) / 2.5);

    // A fundamental plus two inharmonic partials is what reads as "bell/chime"
    // rather than a plain sine beep. Shorter decays than a low bell would use —
    // that quick fade is what makes a bright, light strike read as delicate
    // rather than a heavy, sustained bong.
    const partials = [1, 2.4, 3.8];
    const decays = [0.75, 0.4, 0.22];
    partials.forEach((ratio, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = chime.frequency * ratio;

      const peak = loudness * (idx === 0 ? 0.3 : 0.13);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(peak, now + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + decays[idx]);

      osc.connect(gain).connect(master);
      osc.start(now);
      osc.stop(now + decays[idx] + 0.05);
    });
  }

  function addWind(dx: number, dt: number) {
    const speed = Math.abs(dx) / Math.max(dt, 1);
    wind.strength = Math.min(MAX_WIND, wind.strength + speed * 1.1);
    wind.direction = Math.sign(dx) || wind.direction;
    wind.lastInputAt = performance.now();
  }

  function gust(direction: number) {
    ensureAudio();
    wind.strength = Math.min(16, wind.strength + GUST_IMPULSE);
    wind.direction = direction;
    wind.lastInputAt = performance.now();
  }

  // Pointer Events unify mouse, touch and pen — no device branching needed
  // for the physics, only for whether movement alone counts (mouse hover) or
  // contact is required (touch has no hover to speak of).
  let lastX = 0;
  let lastT = 0;
  let dragging = false;
  scene.style.touchAction = "none";

  scene.addEventListener("pointerdown", (e) => {
    ensureAudio();
    dragging = true;
    lastX = e.clientX;
    lastT = performance.now();
    gust(1);
    scene.setPointerCapture(e.pointerId);
  });

  scene.addEventListener("pointermove", (e) => {
    if (!dragging && e.pointerType !== "mouse") return;
    const now = performance.now();
    const dt = now - lastT || 16;
    addWind(e.clientX - lastX, dt);
    lastX = e.clientX;
    lastT = now;
  });

  scene.addEventListener("pointerup", () => (dragging = false));
  scene.addEventListener("pointercancel", () => (dragging = false));

  // Keyboard equivalent: hold an arrow key for sustained wind, Space/Enter
  // for a gust — the same wind state the pointer path feeds.
  const heldKeys = new Set<string>();
  scene.addEventListener("keydown", (e) => {
    ensureAudio();
    if (e.code === "Space" || e.code === "Enter") {
      e.preventDefault();
      gust(heldKeys.has("ArrowLeft") ? -1 : 1);
      return;
    }
    if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
      heldKeys.add(e.code);
    }
  });
  scene.addEventListener("keyup", (e) => heldKeys.delete(e.code));

  let lastFrame = performance.now();
  function frame(now: number) {
    const dt = Math.min(50, now - lastFrame);
    lastFrame = now;

    if (heldKeys.has("ArrowLeft")) addWind(-dt * 0.6, dt);
    if (heldKeys.has("ArrowRight")) addWind(dt * 0.6, dt);

    if (now - wind.lastInputAt > IDLE_MS) {
      wind.strength = Math.max(0, wind.strength - dt * 0.008);
    }

    // The chimes and foliage lean away from the side the wind is coming
    // from — e.g. the pointer moving right reads as wind arriving from the
    // right, so everything swings left — hence the sign flip here rather
    // than in wind.direction itself, which stays the raw input reading.
    const windPush = -wind.direction;

    for (const chime of chimes) {
      const rawForce = wind.strength * windPush * FORCE_SCALE * (chime.silent ? 1.6 : 1);
      // Capped relative to this chime's own stiffness so wind can never fully
      // overpower the spring — without this, a strong sustained push has no
      // stable resting angle and the tube swings past horizontal instead of
      // settling into a bounded lean.
      const maxForce = chime.stiffness * 0.6;
      const force = Math.max(-maxForce, Math.min(maxForce, rawForce));
      const accel =
        -chime.stiffness * Math.sin(chime.angle) - chime.damping * chime.angularVelocity + force;
      chime.angularVelocity += accel * (dt / 1000);
      chime.angle += chime.angularVelocity * (dt / 1000);

      const absAngle = Math.abs(chime.angle);
      if (!chime.silent) {
        if (chime.armed && absAngle > STRIKE_THRESHOLD) {
          strike(chime, chime.angularVelocity);
          chime.armed = false;
        } else if (!chime.armed && absAngle < REARM_THRESHOLD) {
          chime.armed = true;
        }
      }

      const degrees = (chime.angle * 180) / Math.PI;
      chime.el.setAttribute("transform", `rotate(${degrees} ${chime.pivotX} ${chime.pivotY})`);
    }

    // Foliage is heavier than the tubes: it eases toward a wind-scaled lean
    // instead of swinging on its own spring, so a gust reads as a slow,
    // physical rustle rather than another chime.
    const windFactor = Math.min(1, wind.strength / MAX_WIND);
    const smoothing = 1 - Math.exp(-dt / 220);
    for (const clump of foliage) {
      const target = windFactor * 6 * windPush * clump.coupling;
      clump.angle += (target - clump.angle) * smoothing;
      clump.el.setAttribute("transform", `rotate(${clump.angle} ${clump.pivotX} ${clump.pivotY})`);
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
