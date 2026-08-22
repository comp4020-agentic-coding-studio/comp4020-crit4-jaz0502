const SVG_NS = "http://www.w3.org/2000/svg";

const CHIME_COUNT = 9;
// A pentatonic scale so any combination of chimes striking together stays
// consonant — there's no wrong note to hit, only louder or softer ones.
const PENTATONIC = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];

// How much of the wind's strength turns into torque on each chime. Tuned so a
// single mouse click's gust is enough to swing a chime past STRIKE_THRESHOLD.
const FORCE_SCALE = 0.16;
const STRIKE_THRESHOLD = 0.16; // radians from rest before a chime "strikes"
const REARM_THRESHOLD = STRIKE_THRESHOLD * 0.4;
const GUST_IMPULSE = 11;
const IDLE_MS = 400; // no input for this long and wind starts decaying

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

export function initWindChimes(scene: HTMLElement, svg: SVGSVGElement): void {
  const width = 640;
  const rigQuery = svg.querySelector<SVGGElement>("#chime-rig");
  if (!rigQuery) return;
  const rig = rigQuery;

  const chimes: Chime[] = [];

  function makeTubeGroup(pivotX: number, pivotY: number, stringLen: number, tubeLen: number, tubeWidth: number) {
    const g = document.createElementNS(SVG_NS, "g");

    const string = document.createElementNS(SVG_NS, "line");
    string.setAttribute("x1", String(pivotX));
    string.setAttribute("y1", String(pivotY));
    string.setAttribute("x2", String(pivotX));
    string.setAttribute("y2", String(pivotY + stringLen));
    string.setAttribute("stroke", "#4a3728");
    string.setAttribute("stroke-width", "1.5");
    g.appendChild(string);

    const tubeTop = pivotY + stringLen;
    const tube = document.createElementNS(SVG_NS, "rect");
    tube.setAttribute("x", String(pivotX - tubeWidth / 2));
    tube.setAttribute("y", String(tubeTop));
    tube.setAttribute("width", String(tubeWidth));
    tube.setAttribute("height", String(tubeLen));
    tube.setAttribute("rx", String(tubeWidth / 2));
    tube.setAttribute("fill", "url(#tube-gradient)");
    tube.setAttribute("stroke", "#6b4a33");
    tube.setAttribute("stroke-width", "0.5");
    g.appendChild(tube);

    for (const cy of [tubeTop, tubeTop + tubeLen]) {
      const cap = document.createElementNS(SVG_NS, "circle");
      cap.setAttribute("cx", String(pivotX));
      cap.setAttribute("cy", String(cy));
      cap.setAttribute("r", String(tubeWidth / 2 + 1));
      cap.setAttribute("fill", "#6b4a33");
      g.appendChild(cap);
    }

    rig.appendChild(g);
    return g;
  }

  for (let i = 0; i < CHIME_COUNT; i++) {
    const pivotX = 60 + (i / (CHIME_COUNT - 1)) * (width - 120);
    const pivotY = 66;
    const stringLen = 18 + (i % 3) * 8;
    const tubeLen = 120 + ((i * 37) % 60);

    const el = makeTubeGroup(pivotX, pivotY, stringLen, tubeLen, 12);

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

  // A central wind-catcher disc: bigger, looser, and more visibly restless
  // than the tubes, so the strength of the wind reads at a glance even before
  // any chime strikes. It never makes sound on its own.
  const catcherPivotX = width / 2;
  const catcherPivotY = 66;
  const catcherStringLen = 60;
  const catcherEl = document.createElementNS(SVG_NS, "g");
  const catcherString = document.createElementNS(SVG_NS, "line");
  catcherString.setAttribute("x1", String(catcherPivotX));
  catcherString.setAttribute("y1", String(catcherPivotY));
  catcherString.setAttribute("x2", String(catcherPivotX));
  catcherString.setAttribute("y2", String(catcherPivotY + catcherStringLen));
  catcherString.setAttribute("stroke", "#4a3728");
  catcherString.setAttribute("stroke-width", "1.5");
  catcherEl.appendChild(catcherString);
  const disc = document.createElementNS(SVG_NS, "circle");
  disc.setAttribute("cx", String(catcherPivotX));
  disc.setAttribute("cy", String(catcherPivotY + catcherStringLen + 14));
  disc.setAttribute("r", "14");
  disc.setAttribute("fill", "url(#tube-gradient)");
  disc.setAttribute("stroke", "#6b4a33");
  disc.setAttribute("stroke-width", "1");
  catcherEl.appendChild(disc);
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
    // rather than a plain sine beep.
    const partials = [1, 2.4, 3.8];
    const decays = [1.1, 0.6, 0.35];
    partials.forEach((ratio, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = chime.frequency * ratio;

      const peak = loudness * (idx === 0 ? 0.35 : 0.14);
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
    wind.strength = Math.min(12, wind.strength + speed * 1.1);
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

    for (const chime of chimes) {
      const force = wind.strength * wind.direction * FORCE_SCALE * (chime.silent ? 1.6 : 1);
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

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
