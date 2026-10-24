import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { DartGame, Hud } from './darts';
import type { Arcade, Glass } from './arcade';
import { createPosters, type Posters } from './posters';
import { createNowPlaying } from './nowplaying';
import { asset } from './asset';
import { createHints, type Hints } from './hints';

const MODEL_URL = asset('models/mandeep.glb');

// The room is rescaled to this size. Camera and control limits below are written
// against it, not against Maya's units, so swapping in a re-export doesn't break them.
const ROOM_SIZE = 10;

// The walls and floor. Framing uses this object, not the whole scene: the scene's
// bounding box is 567 units wide because of a stray mesh (polySurface196) far
// outside the room.
const ROOM_SHELL = 'pPlane5';

// The dartboard is the first clickable object. Clicking it moves the camera to
// the throw line and frames the board.
const DARTBOARD = 'dartboard';
// Regulation dimensions. Mandeep's room isn't modelled at real-world scale, so
// metres are converted to scene units from the board itself: whatever height
// the bullseye is at in the scene *is* 1.73 m (see unitsPerMetre below).
const BULLSEYE_HEIGHT_M = 1.73; // floor to bullseye centre
const THROW_DISTANCE_M = 2.37; // board face to throw line (the oche)
const BOARD_FILL = 0.7; // in focus, the board fills 70% of the screen's shorter side
const FOCUS_SECONDS = 0.9;

// The TV next to the console shows the maze game. Clicking either focuses it.
const TV = 'television_03';
const CONSOLE = 'gaming_console1';
// Where the glass sits on the TV, as FRACTIONS of the TV mesh's bounding box
// (mesh space: x right, z up, front faces −y). Measured on the unquantized
// mesh: the tube spans x ±0.16 and z 0.14–0.377 inside a box of x −0.202–0.198,
// z 0–0.411 — 4:3, like the game. Fractions, not raw numbers, because meshopt
// quantization rescales mesh space to −1…1 and moves the difference into the
// node's transform; ratios inside the box survive that, coordinates don't.
const TV_GLASS_FRAC = { cx: 0.5, cz: 0.6277, w: 0.75, h: 0.5474, inFront: 0.0015 };
const SCREEN_FILL = 0.8; // in focus, the screen fills 80% of the view
const SCREEN_FOV = 40;

export type RoomState = 'loading' | 'ready' | 'error';
export type RoomView = 'room' | 'dartboard' | 'console';

export interface RoomHandle {
  backToRoom: () => void;
  dispose: () => void;
}

export function mountRoom(canvas: HTMLCanvasElement, dartsHud?: Hud): RoomHandle {
  const setState = (s: RoomState) => (canvas.dataset.state = s);
  setState('loading');

  // ── Renderer ────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // Cost is quadratic in pixel ratio: 2 = 4× the pixels, 3 = 9×. Cap at 2.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // Without tone mapping, bright areas clip to flat white.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  // ── Scene + lighting ────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1d1d21);

  // Image-based lighting. PBR materials take reflections from scene.environment;
  // without it anything metallic renders black.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envMap;

  // A key light so the room reads as lit from the window side, not evenly.
  // Only the direction of `position` matters for a DirectionalLight.
  const sun = new THREE.DirectionalLight(0xfff1e0, 1.2);
  sun.position.set(-1, 2, 0.5);
  scene.add(sun);

  // ── Camera + controls ───────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;
  // The room has walls on -X, -Z and +Z and is open on +X. The camera stays inside,
  // looking from the open side: azimuth is measured from +Z toward +X, so +X is π/2.
  controls.minAzimuthAngle = Math.PI / 2 - 0.8;
  controls.maxAzimuthAngle = Math.PI / 2 + 0.8;
  // Polar is measured from straight up. Keeping it under π/2 keeps the camera above
  // the target, looking slightly down — the room has no ceiling, so looking up
  // would show the empty background.
  controls.minPolarAngle = 0.9;
  controls.maxPolarAngle = 1.25;

  let roomHeight = 0; // known once the model has loaded

  // ── Keep the camera inside the room ─────────────────────────────────────
  // OrbitControls has no notion of walls: it only limits angles and distance to
  // the target. So after every update we clamp the camera's position into this
  // box. OrbitControls re-reads the position at the start of each update, so a
  // clamped position simply becomes where the next frame starts from.
  const WALL_MARGIN = 0.3; // stay this far from walls, floor and the ceiling height
  const cameraBounds = new THREE.Box3();

  // Near the open edge, the camera only has ROOM_SIZE / 2 of room in front of the
  // target, so it can't back away to fit the room — widen the lens instead.
  // fov is VERTICAL; the horizontal angle follows from the aspect ratio. Pick the
  // vertical fov whose horizontal angle spans the back wall, then clamp it:
  // below 50° crops the desk and bed at the side walls, above 75° looks fish-eyed (portrait phones hit
  // that cap and crop the sides; the user orbits to see them).
  function fitFov() {
    const distToBackWall = ROOM_SIZE - WALL_MARGIN;
    const hHalf = Math.atan((ROOM_SIZE / 2) / distToBackWall);
    const vHalf = Math.atan(Math.tan(hHalf) / camera.aspect);
    camera.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * vHalf), 60, 75);
    camera.updateProjectionMatrix();
  }

  // ── Dartboard focus: state ──────────────────────────────────────────────
  // Declared before resize(), which reads it on the very first call.
  let view: RoomView = 'room';
  canvas.dataset.view = view;
  let dartboard: THREE.Object3D | null = null;
  // Filled in once the model has loaded, in scene units.
  const focus = {
    centre: new THREE.Vector3(), // bullseye
    normal: new THREE.Vector3(), // unit vector pointing out of the board face
    radius: 0, // board incl. the number ring
    throwPos: new THREE.Vector3(), // where the camera stands to throw
    unitsPerMetre: 1,
  };
  // Where the room view was when the user clicked, so "back" returns there.
  const saved = { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: 0 };

  // A camera move in progress. Interpolating position, target and fov together
  // from `from` to `to` over FOCUS_SECONDS.
  interface Tween {
    t: number;
    from: { position: THREE.Vector3; target: THREE.Vector3; fov: number };
    to: { position: THREE.Vector3; target: THREE.Vector3; fov: number };
    onDone: () => void;
  }
  let tween: Tween | null = null;

  // Vertical fov that makes the board fill BOARD_FILL of the screen's shorter
  // side, from `dist` away. Same idea as fitFov: solve for the horizontal angle
  // too and keep whichever vertical fov is wider, so portrait phones fit as well.
  function focusFov(dist: number) {
    const half = focus.radius / BOARD_FILL;
    const vFromHeight = Math.atan(half / dist);
    const vFromWidth = Math.atan(Math.tan(Math.atan(half / dist)) / camera.aspect);
    return THREE.MathUtils.radToDeg(2 * Math.max(vFromHeight, vFromWidth));
  }

  // ── Size: canvas CSS decides layout; we size the drawing buffer to match ──
  function resize() {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false); // false = don't write CSS; the stylesheet owns it
    camera.aspect = w / h;
    if (view === 'dartboard' && !tween) {
      camera.fov = focusFov(camera.position.distanceTo(focus.centre));
      camera.updateProjectionMatrix();
    } else if (view === 'console' && !tween) {
      camera.updateProjectionMatrix(); // keep the fixed screen framing
    } else {
      fitFov(); // also calls updateProjectionMatrix(); reruns when a phone rotates
    }
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize(); // the observer's first callback is async

  // ── Load the model ──────────────────────────────────────────────────────
  // Two decoders: meshopt for geometry, Basis (via KTX2Loader) for textures.
  // No setTranscoderPath(): since r16x, KTX2Loader locates its transcoder with
  // `new URL(..., import.meta.url)`, so Vite copies the .js/.wasm into the build
  // with hashed names. detectSupport() asks the GPU which compressed formats it
  // supports, so Basis transcodes to one this device can keep compressed in VRAM.
  const ktx2 = new KTX2Loader().detectSupport(renderer);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);

  loader.load(
    MODEL_URL,
    (gltf) => {
      const room = gltf.scene;
      scene.add(room);
      room.updateMatrixWorld(true); // Box3 reads world matrices

      const shell = room.getObjectByName(ROOM_SHELL) ?? room;
      const box = new THREE.Box3().setFromObject(shell);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());

      // Scale to ROOM_SIZE, centre on X/Z, put the floor at y = 0.
      const s = ROOM_SIZE / Math.max(size.x, size.y, size.z);
      room.scale.setScalar(s);
      room.position.set(-centre.x * s, -box.min.y * s, -centre.z * s);

      roomHeight = size.y * s;
      const half = ROOM_SIZE / 2 - WALL_MARGIN;
      cameraBounds.set(
        new THREE.Vector3(-half, WALL_MARGIN, -half),
        new THREE.Vector3(half, roomHeight - WALL_MARGIN, half),
      );

      controls.target.set(0, roomHeight * 0.3, 0);
      // Start just inside the open (+X) edge, well above the target: looking down
      // keeps the wall tops (and the missing ceiling above them) out of frame.
      camera.position.set(half, roomHeight * 0.75, 0);
      // Zooming in stops short of the target; zooming out stops at the open edge.
      controls.minDistance = 1.5;
      controls.maxDistance = camera.position.distanceTo(controls.target);
      controls.update();

      // ── Measure the dartboard (after the room's scale/position are set) ──
      // The "now playing" card (Room.astro markup, nowplaying.ts behaviour);
      // its stop button stops whichever poster is playing.
      const npRoot = canvas.parentElement?.querySelector<HTMLElement>('#now-playing');
      const nowPlaying = npRoot ? createNowPlaying(npRoot, () => posters?.stopAll()) : null;
      posters = createPosters(room, {
        onPlay: (song) => nowPlaying?.show(song),
        onProgress: (f) => nowPlaying?.progress(f),
        onStop: () => nowPlaying?.hide(),
      });

      dartboard = room.getObjectByName(DARTBOARD) ?? null;
      if (dartboard) {
        room.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(dartboard);
        const bs = b.getSize(new THREE.Vector3());
        b.getCenter(focus.centre);
        focus.radius = Math.max(bs.x, bs.y, bs.z) / 2;
        // The board is a thin disc: its facing direction is its thinnest axis.
        // Point it at the middle of the room so it comes out of the face, not the wall.
        const thin = bs.x < bs.y && bs.x < bs.z ? 'x' : bs.y < bs.z ? 'y' : 'z';
        focus.normal.set(0, 0, 0)[thin] = 1;
        const toRoom = new THREE.Vector3(0, focus.centre.y, 0).sub(focus.centre);
        if (focus.normal.dot(toRoom) < 0) focus.normal.negate();

        // 1.73 m is the bullseye's height above the floor (y = 0), so that height
        // in scene units, divided by 1.73, is how many units make a metre.
        focus.unitsPerMetre = focus.centre.y / BULLSEYE_HEIGHT_M;
        focus.throwPos
          .copy(focus.centre)
          .addScaledVector(focus.normal, THROW_DISTANCE_M * focus.unitsPerMetre);
        canvas.dataset.unitsPerMetre = focus.unitsPerMetre.toFixed(3);
      } else {
        console.warn(`No "${DARTBOARD}" node in ${MODEL_URL}; dartboard focus disabled`);
      }

      // ── Measure the TV screen ──
      tv = room.getObjectByName(TV) ?? null;
      consoleObj = room.getObjectByName(CONSOLE) ?? null;
      if (tv) {
        room.updateMatrixWorld(true);
        const geo = (tv as THREE.Mesh).geometry;
        geo.computeBoundingBox();
        const bb = geo.boundingBox!;
        const size = bb.getSize(new THREE.Vector3());
        tvGlass = {
          cx: bb.min.x + TV_GLASS_FRAC.cx * size.x,
          cz: bb.min.z + TV_GLASS_FRAC.cz * size.z,
          y: bb.min.y - TV_GLASS_FRAC.inFront * size.y, // front face is min y
          w: TV_GLASS_FRAC.w * size.x,
          h: TV_GLASS_FRAC.h * size.z,
        };
        tv.localToWorld(screen.centre.set(tvGlass.cx, tvGlass.y, tvGlass.cz));
        // The glass faces local −Y; turn that into a world direction.
        screen.normal.set(0, -1, 0).transformDirection(tv.matrixWorld);
        // World size of the glass: local size × the TV's world scale.
        const s = new THREE.Vector3().setFromMatrixScale(tv.matrixWorld);
        screen.w = tvGlass.w * s.x;
        screen.h = tvGlass.h * s.z;
      }

      // ── Idle hints, made of the scene itself (see hints.ts) ──
      hints = createHints({ scene, loader, board: dartboard ? focus : null, posters });
      // The TV's demo needs the game code, so fetch it now instead of on first
      // click (3.5 KB brotli, requested after the room is already on screen).
      loadArcade()?.then((a) => {
        if (view === 'room') a.showDemo();
      });

      setState('ready');
    },
    undefined,
    (err) => {
      console.error('Failed to load', MODEL_URL, err);
      setState('error');
    },
  );

  // ── Picking: which object is under the pointer? ─────────────────────────
  // A Raycaster fires a ray from the camera through the pointer and returns what
  // it hits. Testing only the clickable things — the dartboard (4.4k vertices)
  // and three posters (700 triangles each) — not the whole room (~195k), keeps
  // this cheap enough to run on every pointer move for hover.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2(); // pointer in normalized device coords, -1..1
  let posters: Posters | null = null;
  let hints: Hints | null = null;

  type Pick = { kind: 'dartboard' } | { kind: 'console' } | { kind: 'poster'; name: string } | null;
  function pickUnderPointer(e: PointerEvent): Pick {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    if (dartboard && raycaster.intersectObject(dartboard, true).length > 0) return { kind: 'dartboard' };
    const screenObjs = [tv, consoleObj].filter((o): o is THREE.Object3D => o !== null);
    if (raycaster.intersectObjects(screenObjs, true).length > 0) return { kind: 'console' };
    const poster = posters?.pick(raycaster);
    return poster ? { kind: 'poster', name: poster } : null;
  }

  // OrbitControls also listens to these events, so a drag to rotate ends with a
  // pointerup too. Only count it as a click if the pointer barely moved.
  const down = { x: 0, y: 0 };
  const onPointerDown = (e: PointerEvent) => {
    down.x = e.clientX;
    down.y = e.clientY;
  };
  const onPointerUp = (e: PointerEvent) => {
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (moved >= 6 || view !== 'room' || tween) return;
    const hit = pickUnderPointer(e);
    if (hit) hints?.dismiss();
    if (hit?.kind === 'dartboard') focusDartboard();
    else if (hit?.kind === 'console') focusConsole();
    else if (hit?.kind === 'poster') posters?.toggle(hit.name);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (e.buttons !== 0 || view !== 'room' || tween) return; // dragging or busy
    canvas.style.cursor = pickUnderPointer(e) ? 'pointer' : '';
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') backToRoom();
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointermove', onPointerMove);
  window.addEventListener('keydown', onKeyDown);

  // ── Switching views ─────────────────────────────────────────────────────
  // OrbitControls is switched off for the move and while focused: its update()
  // enforces the room's angle and distance limits around controls.target, and
  // would yank the camera back the moment the target moves to the board.
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function startTween(to: Tween['to'], onDone: () => void) {
    tween = {
      t: reduceMotion ? 1 : 0,
      from: { position: camera.position.clone(), target: controls.target.clone(), fov: camera.fov },
      to,
      onDone,
    };
  }

  function setView(v: RoomView) {
    view = v;
    canvas.dataset.view = v; // Room.astro shows the "Back" button off this
  }

  function focusDartboard() {
    saved.position.copy(camera.position);
    saved.target.copy(controls.target);
    saved.fov = camera.fov;
    controls.enabled = false;
    canvas.style.cursor = '';
    posters?.stopAll(); // a clip playing behind you while you throw would be odd
    setView('dartboard');
    const dist = focus.throwPos.distanceTo(focus.centre);
    const game = loadGame(); // starts downloading while the camera moves
    startTween({ position: focus.throwPos.clone(), target: focus.centre.clone(), fov: focusFov(dist) }, () => {
      game?.then((g) => {
        if (view === 'dartboard') g.activate(); // the user may have left before it loaded
      });
    });
  }

  // ── The dart game: fetched on first use ─────────────────────────────────
  // import() makes Vite split darts.ts into its own chunk, and dart.glb is only
  // requested here — neither is part of the first page load.
  let gamePromise: Promise<DartGame> | null = null;
  let game: DartGame | null = null;
  function loadGame() {
    if (!dartsHud) return null;
    gamePromise ??= import('./darts').then(async ({ createDartGame }) => {
      game = await createDartGame({ scene, camera, canvas, loader, board: focus, hud: dartsHud });
      return game;
    });
    gamePromise.catch((err) => console.error('Dart game failed to load', err));
    return gamePromise;
  }

  // ── The TV game: its own chunk, fetched once the room is ready so the TV can
  // play a demo; clicking the console then moves the camera in and starts it ──
  let tv: THREE.Object3D | null = null;
  let tvGlass: Glass | null = null;
  let consoleObj: THREE.Object3D | null = null;
  const screen = { centre: new THREE.Vector3(), normal: new THREE.Vector3(), w: 0, h: 0 };
  let arcadePromise: Promise<Arcade> | null = null;
  let arcade: Arcade | null = null;

  function loadArcade() {
    if (!tv || !tvGlass) return null;
    const tvNode = tv;
    const glass = tvGlass;
    arcadePromise ??= import('./arcade').then(({ createArcade }) => {
      arcade = createArcade({ tv: tvNode, glass, input: canvas });
      return arcade;
    });
    arcadePromise.catch((err) => console.error('TV game failed to load', err));
    return arcadePromise;
  }

  function focusConsole() {
    if (!tv) return;
    saved.position.copy(camera.position);
    saved.target.copy(controls.target);
    saved.fov = camera.fov;
    controls.enabled = false;
    canvas.style.cursor = '';
    posters?.stopAll();
    setView('console');
    // Distance at which the screen fills SCREEN_FILL of the view at SCREEN_FOV,
    // checking height and (for portrait screens) width — same idea as fitFov.
    const tanV = Math.tan(THREE.MathUtils.degToRad(SCREEN_FOV / 2));
    const dist = Math.max(
      screen.h / 2 / SCREEN_FILL / tanV,
      screen.w / 2 / SCREEN_FILL / (tanV * camera.aspect),
    );
    const position = screen.centre.clone().addScaledVector(screen.normal, dist);
    const loading = loadArcade();
    startTween({ position, target: screen.centre.clone(), fov: SCREEN_FOV }, () => {
      loading?.then((a) => {
        if (view === 'console') a.activate();
      });
    });
  }

  function backToRoom() {
    if (view === 'room' || tween) return;
    game?.deactivate();
    arcade?.deactivate();
    startTween({ position: saved.position.clone(), target: saved.target.clone(), fov: saved.fov }, () => {
      setView('room');
      controls.enabled = true;
      controls.update();
    });
  }

  // ── Render loop ─────────────────────────────────────────────────────────
  // THREE.Timer gives frame-rate-independent time; connect(document) stops a
  // huge delta after the tab was in the background.
  const timer = new THREE.Timer();
  timer.connect(document);

  renderer.setAnimationLoop((timestamp) => {
    timer.update(timestamp);
    const dt = timer.getDelta();
    game?.update(dt);
    arcade?.update(dt);
    posters?.update(timer.getElapsed());
    hints?.update(dt, view === 'room' && !tween);
    if (tween) {
      tween.t = Math.min(1, tween.t + dt / FOCUS_SECONDS);
      const k = tween.t < 0.5 ? 4 * tween.t ** 3 : 1 - (-2 * tween.t + 2) ** 3 / 2; // ease in-out
      camera.position.lerpVectors(tween.from.position, tween.to.position, k);
      controls.target.lerpVectors(tween.from.target, tween.to.target, k);
      camera.fov = THREE.MathUtils.lerp(tween.from.fov, tween.to.fov, k);
      camera.updateProjectionMatrix();
      camera.lookAt(controls.target);
      if (tween.t >= 1) {
        const done = tween.onDone;
        tween = null;
        done();
      }
    } else if (view === 'room') {
      // Damping needs controls.update() every frame while orbiting.
      controls.update();
    }
    if (roomHeight > 0) camera.position.clamp(cameraBounds.min, cameraBounds.max);
    renderer.render(scene, camera);
  });

  // ── Teardown (Vite hot reload, or unmount) ──────────────────────────────
  const dispose = () => {
    renderer.setAnimationLoop(null);
    observer.disconnect();
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('keydown', onKeyDown);
    timer.dispose();
    game?.dispose();
    posters?.dispose();
    hints?.dispose();
    arcade?.dispose();
    controls.dispose();
    ktx2.dispose();
    envMap.dispose();
    pmrem.dispose();
    renderer.dispose();
  };

  return { backToRoom, dispose };
}
