// "You can click these" hints, made from the room's own visuals rather than UI
// overlays — like an arcade cabinet's attract mode:
//   • the TV plays a demo of its game (arcade.ts, started from room.ts);
//   • the posters breathe a soft glow (posters.ts, switched on from here);
//   • the dartboard has darts thrown into it every few seconds (this file).
// The posters and darts stop for good the first time something is opened —
// by then the visitor has got the idea. The TV demo keeps running; that's
// just what an idle arcade screen does.
//
// The demo darts reuse dart.glb (10.8 KB brotli), fetched after the room is
// ready, so it never delays the first view. The real dart game later loads the
// same URL again; the browser serves it from cache.
import * as THREE from 'three';
import { asset } from './asset';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { BoardFrame } from './darts';
import type { Posters } from './posters';

const DART_URL = asset('models/dart.glb');
const DART_LENGTH = 0.15; // m, same as darts.ts
const START_AFTER = 1.5; // s after the room is ready
const FLIGHT = 0.35; // s from release to the board
const BETWEEN = 1.1; // s between darts in a volley
const VOLLEY = 3; // darts per volley, like a real turn
const REST = 2.5; // s the volley stays in the board before it's pulled out
const SPREAD = 0.45; // landing points within this fraction of the board radius

export function createHints(opts: {
  scene: THREE.Scene;
  loader: GLTFLoader;
  board: BoardFrame | null;
  posters: Posters | null;
}) {
  const { scene, loader, board, posters } = opts;
  posters?.setAttract(true);

  let dismissed = false;
  let template: THREE.Object3D | null = null;
  let tipOffset = 0;
  const darts: { obj: THREE.Object3D; from: THREE.Vector3; to: THREE.Vector3; dir: THREE.Vector3; t: number }[] = [];
  let clock = -START_AFTER; // counts up; volley timing is measured from 0
  let thrown = 0;

  if (board) {
    loader
      .loadAsync(DART_URL)
      .then((gltf) => {
        // dart.glb points its tip along +Y (see darts.ts); scale it to 15 cm.
        template = gltf.scene;
        const box = new THREE.Box3().setFromObject(template);
        template.scale.setScalar((DART_LENGTH * board.unitsPerMetre) / (box.max.y - box.min.y));
        tipOffset = box.max.y * template.scale.y;
      })
      .catch((err) => console.warn('Demo darts unavailable', err));
  }

  // Board axes as a thrower sees it: right and up along the face.
  const up = new THREE.Vector3(0, 1, 0);
  const right = board ? board.normal.clone().negate().cross(up).normalize() : new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0);

  function throwOne() {
    if (!board || !template) return;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * SPREAD * board.radius; // sqrt → even spread over the disc
    const to = board.centre.clone().addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r);
    // Released from about where a thrower's hand would be, 1 m out, a bit low and to the side.
    const upm = board.unitsPerMetre;
    const from = to
      .clone()
      .addScaledVector(board.normal, 1.0 * upm)
      .addScaledVector(up, -0.12 * upm)
      .addScaledVector(right, (Math.random() - 0.5) * 0.3 * upm);
    const dir = to.clone().sub(from).normalize();
    const obj = template.clone();
    obj.quaternion.setFromUnitVectors(Y, dir);
    scene.add(obj);
    darts.push({ obj, from, to, dir, t: 0 });
  }

  function clearDarts() {
    for (const d of darts) scene.remove(d.obj); // clones share geometry; nothing to dispose
    darts.length = 0;
  }

  // `visible` is false while a focused view or camera move is in progress.
  function update(dt: number, visible: boolean) {
    if (dismissed) return;
    for (const d of darts) d.obj.visible = visible;
    if (!visible) return;
    clock += dt;
    if (clock < 0) return;
    // A volley: VOLLEY darts BETWEEN seconds apart, then REST, then pull them out.
    if (thrown < VOLLEY && clock >= thrown * BETWEEN) {
      throwOne();
      thrown++;
    }
    if (clock >= (VOLLEY - 1) * BETWEEN + FLIGHT + REST) {
      clearDarts();
      thrown = 0;
      clock = -1; // a short pause before the next volley
    }
    for (const d of darts) {
      d.t = Math.min(FLIGHT, d.t + dt);
      const k = d.t / FLIGHT;
      // Straight line with a slight arc; the tip leads, so place by the tip.
      const tip = new THREE.Vector3().lerpVectors(d.from, d.to, k).addScaledVector(up, Math.sin(k * Math.PI) * 0.05 * (board?.unitsPerMetre ?? 1));
      d.obj.position.copy(tip).addScaledVector(d.dir, -tipOffset);
    }
  }

  // The first time something is opened: stop the poster glow and the demo darts.
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    posters?.setAttract(false);
    clearDarts();
  }

  return { update, dismiss, dispose: dismiss };
}

export type Hints = ReturnType<typeof createHints>;
