// Dart game: aim with the pointer, hold to charge power, release to throw.
//
// Loaded with a dynamic import() the first time the dartboard is focused, so
// this code and dart.glb cost nothing on the initial page load.
//
// No physics engine. A thrown dart follows a parabola:
//   p(t) = p0 + v·t + ½·g·t²        (g points straight down)
// and the board is a vertical plane. Gravity is vertical and the board's normal
// is horizontal, so the distance to the board shrinks LINEARLY with time — the
// moment of impact is a single division, not a simulation.
import * as THREE from 'three';
import { asset } from './asset';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const DART_URL = asset('models/dart.glb');

// ── Tuning (all in real-world units; converted with unitsPerMetre) ──────────
const GRAVITY = 9.81; // m/s²
const IDEAL_SPEED = 6.5; // m/s — at perfect power the dart lands on the aim point
const SPEED_RANGE = [0.7, 1.3]; // power 0 → 70% of ideal speed, power 1 → 130%
const CHARGE_PERIOD = 1.2; // s for the power meter to go 0 → 1 → 0
const DART_LENGTH = 0.15; // m, tip to flights
// Where the held dart sits: HOLD.forward metres in front of the eye, then pushed
// right and down by a fraction of the visible half-width/height at that depth.
// Fractions of the view (not fixed metres) keep it on screen on any aspect ratio —
// the focused view's fov is narrow (~23° on desktop), so a fixed 12 cm offset
// would put the dart outside the frame.
const HOLD = { forward: 0.6, right: 0.45, down: 0.3 }; // down 0.3 keeps it clear of the HUD
const PULL_BACK = 0.06; // m the held dart draws back at full power
const DARTS_PER_ROUND = 3;

// Board geometry as fractions of the board's radius (its outer edge, incl. the
// number ring). Measured from a straight-on render of Mandeep's board — they
// match regulation proportions to within the render's blur.
const RING = { bull: 0.021, outerBull: 0.06, trebleIn: 0.455, trebleOut: 0.477, doubleIn: 0.722, doubleOut: 0.751 };
const SWAY = 0.04; // aim wobble, as a fraction of the board radius
// Clockwise from the top, as printed on the board.
const SEGMENTS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

export interface BoardFrame {
  centre: THREE.Vector3; // bullseye, scene units
  normal: THREE.Vector3; // out of the board face, unit length
  radius: number; // scene units
  unitsPerMetre: number;
}

export interface Hud {
  root: HTMLElement; // gets data-charging / data-round-over
  power: HTMLElement; // gets --power: 0..1
  last: HTMLElement;
  total: HTMLElement;
}

interface Flight {
  dart: THREE.Object3D;
  p0: THREE.Vector3;
  v: THREE.Vector3;
  t: number;
  tEnd: number;
  hit: { score: number; label: string } | null; // null = missed the board
}

export async function createDartGame(opts: {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  loader: GLTFLoader;
  board: BoardFrame;
  hud: Hud;
}) {
  const { scene, camera, canvas, board, hud } = opts;
  const upm = board.unitsPerMetre;

  // ── Board axes, as the player sees it ──────────────────────────────────
  const up = new THREE.Vector3(0, 1, 0);
  // Looking along -normal, "right" is (-normal) × up.
  const right = board.normal.clone().negate().cross(up).normalize();
  const boardPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(board.normal, board.centre);

  // ── The dart model: one template, cloned per throw (clones share geometry) ─
  const gltf = await opts.loader.loadAsync(DART_URL);
  const template = gltf.scene;
  // dart.gltf points its tip along +Y, from y = -4.6 (flights) to y = 3.4 (tip).
  const box = new THREE.Box3().setFromObject(template);
  const modelLength = box.max.y - box.min.y;
  const tipY = box.max.y;
  template.scale.setScalar((DART_LENGTH * upm) / modelLength);
  const tipOffset = tipY * template.scale.y; // origin → tip distance after scaling

  // ── Aim reticle: a small ring lying on the board face ──────────────────
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(board.radius * 0.025, board.radius * 0.035, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
  );
  reticle.lookAt(board.normal); // RingGeometry faces +Z; turn it to face the player
  reticle.visible = false;
  scene.add(reticle);

  // ── The held dart: visible while aiming, points at the (swaying) aim ────
  const held = template.clone();
  held.visible = false;
  scene.add(held);

  // ── State ──────────────────────────────────────────────────────────────
  let active = false;
  let elapsed = 0;
  const aim = new THREE.Vector3().copy(board.centre); // where the pointer is on the board plane
  const swayed = new THREE.Vector3(); // aim + wobble: what the throw actually targets
  let charging = false;
  let chargeStart = 0;
  let power = 0;
  let flight: Flight | null = null;
  let thrown: THREE.Object3D[] = [];
  let roundScores: string[] = [];
  let roundTotal = 0;

  // ── Pointer → aim point on the board's plane ───────────────────────────
  // Intersecting a mathematical plane (not the board mesh) means aiming off the
  // edge still works, and costs nothing.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function updateAim(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    raycaster.ray.intersectPlane(boardPlane, aim);
  }

  const busy = () => !active || flight !== null;

  const onMove = (e: PointerEvent) => {
    if (active) updateAim(e);
  };
  const onDown = (e: PointerEvent) => {
    if (busy()) return;
    if (thrown.length >= DARTS_PER_ROUND) newRound(); // the press after a round clears the board
    updateAim(e); // on touch there's no hover, so the press itself sets the aim
    canvas.setPointerCapture(e.pointerId);
    charging = true;
    chargeStart = elapsed;
    hud.root.dataset.charging = 'true';
  };
  const onUp = () => {
    if (!charging) return;
    charging = false;
    delete hud.root.dataset.charging;
    throwDart(power);
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  // ── Throwing ───────────────────────────────────────────────────────────
  // The held dart's tip, and the point a throw starts from. Same point, so the
  // dart leaves from exactly where it was shown.
  function handPosition(out = new THREE.Vector3()) {
    const forward = board.normal.clone().negate();
    const depth = HOLD.forward * upm;
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const tanH = tanV * camera.aspect;
    return out
      .copy(camera.position)
      .addScaledVector(forward, depth)
      .addScaledVector(right, depth * tanH * HOLD.right)
      .addScaledVector(up, -depth * tanV * HOLD.down);
  }

  // Launch direction that hits `target` from `p0` at speed `v` under gravity `g`.
  // Classic projectile formula, low-arc solution:
  //   tan θ = (v² − √(v⁴ − g(g·x² + 2·y·v²))) / (g·x)
  function launchDirection(p0: THREE.Vector3, target: THREE.Vector3, v: number, g: number) {
    const d = target.clone().sub(p0);
    const y = d.y;
    const horiz = new THREE.Vector3(d.x, 0, d.z);
    const x = horiz.length();
    horiz.normalize();
    const disc = v ** 4 - g * (g * x * x + 2 * y * v * v);
    const theta = disc >= 0 ? Math.atan((v * v - Math.sqrt(disc)) / (g * x)) : Math.PI / 4;
    return horiz.multiplyScalar(Math.cos(theta)).addScaledVector(up, Math.sin(theta));
  }

  function throwDart(p: number) {
    const g = GRAVITY * upm;
    const ideal = IDEAL_SPEED * upm;
    const p0 = handPosition();
    // Direction is solved for the IDEAL speed; the actual speed comes from power.
    // Too little power → slower → longer flight → more drop → lands low. Too much → high.
    const dir = launchDirection(p0, swayed, ideal, g);
    const speed = ideal * THREE.MathUtils.lerp(SPEED_RANGE[0], SPEED_RANGE[1], p);
    const v = dir.multiplyScalar(speed);

    // Impact time with the board plane: distance along the normal changes linearly.
    const n = board.normal;
    const tBoard = -boardPlane.distanceToPoint(p0) / v.dot(n);
    // Impact time with the floor (y = 0): solve ½·(−g)·t² + vy·t + y0 = 0.
    const tFloor = (v.y + Math.sqrt(v.y * v.y + 2 * g * p0.y)) / g;
    const tEnd = Math.min(tBoard, tFloor);
    const hitPoint = positionAt(p0, v, tEnd, new THREE.Vector3());

    const dart = template.clone();
    scene.add(dart);
    thrown.push(dart);
    flight = { dart, p0, v, t: 0, tEnd, hit: tBoard <= tFloor ? scoreAt(hitPoint) : null };
    placeDart(flight, 0);
  }

  function positionAt(p0: THREE.Vector3, v: THREE.Vector3, t: number, out: THREE.Vector3) {
    return out.copy(p0).addScaledVector(v, t).addScaledVector(up, -0.5 * GRAVITY * upm * t * t);
  }

  // Point the dart along its current velocity, with the tip at the flight position.
  const vel = new THREE.Vector3();
  const tip = new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0);
  function placeDart(f: Flight, t: number) {
    positionAt(f.p0, f.v, t, tip);
    vel.copy(f.v).addScaledVector(up, -GRAVITY * upm * t).normalize();
    f.dart.quaternion.setFromUnitVectors(Y, vel);
    f.dart.position.copy(tip).addScaledVector(vel, -tipOffset);
  }

  // ── Scoring ────────────────────────────────────────────────────────────
  // Convert the hit into polar coordinates on the board: distance from the
  // bullseye picks the ring, angle (clockwise from straight up) picks the number.
  function scoreAt(p: THREE.Vector3) {
    const d = p.clone().sub(board.centre);
    const u = d.dot(right) / board.radius;
    const w = d.dot(up) / board.radius;
    const r = Math.hypot(u, w);
    if (r <= RING.bull) return { score: 50, label: 'Bullseye' };
    if (r <= RING.outerBull) return { score: 25, label: 'Outer bull' };
    if (r > RING.doubleOut) return { score: 0, label: 'Off the board' };
    const deg = (THREE.MathUtils.radToDeg(Math.atan2(u, w)) + 360 + 9) % 360;
    const n = SEGMENTS[Math.floor(deg / 18)];
    if (r >= RING.trebleIn && r <= RING.trebleOut) return { score: n * 3, label: `Treble ${n}` };
    if (r >= RING.doubleIn) return { score: n * 2, label: `Double ${n}` };
    return { score: n, label: `${n}` };
  }

  function land(f: Flight) {
    const result = f.hit ?? { score: 0, label: 'Missed' };
    roundScores.push(result.label);
    roundTotal += result.score;
    hud.last.textContent = `${result.label}${result.score ? ` · ${result.score}` : ''}`;
    hud.total.textContent = `Round: ${roundTotal}  (${thrown.length}/${DARTS_PER_ROUND})`;
    if (thrown.length >= DARTS_PER_ROUND) hud.root.dataset.roundOver = 'true';
  }

  function newRound() {
    for (const d of thrown) scene.remove(d);
    thrown = [];
    roundScores = [];
    roundTotal = 0;
    delete hud.root.dataset.roundOver;
    hud.last.textContent = '';
    hud.total.textContent = `Round: 0  (0/${DARTS_PER_ROUND})`;
  }

  // ── Per frame (called from room.ts's render loop) ──────────────────────
  const swayOffset = new THREE.Vector3();
  function update(dt: number) {
    elapsed += dt;
    if (!active) return;

    // Aim wobble: two sine waves at unrelated frequencies, so it never settles
    // into an obvious loop. Hitting a treble means timing the release.
    const a = SWAY * board.radius;
    swayOffset
      .copy(right)
      .multiplyScalar(Math.sin(elapsed * 2.1) * a)
      .addScaledVector(up, Math.sin(elapsed * 1.3 + 1) * a);
    swayed.copy(aim).add(swayOffset);
    reticle.position.copy(swayed).addScaledVector(board.normal, 0.002 * upm);
    reticle.visible = !flight;

    // Held dart: tip at the hand, pointing along the launch direction for the
    // current aim (so it tilts up a little to allow for the drop), pulled back
    // as power charges. Hidden while a dart is in the air.
    held.visible = !flight;
    if (held.visible) {
      const hand = handPosition(tip);
      const dir = launchDirection(hand, swayed, IDEAL_SPEED * upm, GRAVITY * upm);
      held.quaternion.setFromUnitVectors(Y, dir);
      const pull = charging ? power * PULL_BACK * upm : 0;
      held.position.copy(hand).addScaledVector(dir, -(tipOffset + pull));
    }

    if (charging) {
      const phase = ((elapsed - chargeStart) / CHARGE_PERIOD) % 1;
      power = phase < 0.5 ? phase * 2 : 2 - phase * 2; // triangle wave 0 → 1 → 0
      hud.power.style.setProperty('--power', power.toFixed(3));
    }

    if (flight) {
      flight.t = Math.min(flight.t + dt, flight.tEnd);
      placeDart(flight, flight.t);
      if (flight.t >= flight.tEnd) {
        const f = flight;
        flight = null;
        land(f);
      }
    }
  }

  return {
    activate() {
      active = true;
      newRound();
      hud.power.style.setProperty('--power', '0');
    },
    deactivate() {
      active = false;
      charging = false;
      flight = null;
      reticle.visible = false;
      held.visible = false;
      newRound();
    },
    update,
    dispose() {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      newRound();
      scene.remove(reticle, held);
      reticle.geometry.dispose();
      (reticle.material as THREE.Material).dispose();
    },
  };
}

export type DartGame = Awaited<ReturnType<typeof createDartGame>>;
