// Day and night: a sky in the window and sunlight that comes in through it.
//
// Three pieces, all driven by one number — `phase`, 0..1 around a day:
//
// 1. The sky. The window is an open hole in the wall (no glass mesh), so it
//    looks out at whatever surrounds the room. A large sphere around the room
//    gets a shader that, for each pixel, takes the direction from the camera
//    and asks "what's outside in this direction?": a sky gradient for the time
//    of day, a glow around the sun, the moon, stars. Because it uses the real
//    view direction, the view shifts as the camera moves, like a real window.
//
// 2. Sunlight through the window. The room has no ceiling and its walls are
//    single planes, so a shadowed light outside would pour in over the top.
//    Instead, the walls don't cast shadows, and an invisible box (5 faces, with a
//    window-shaped hole) sits just outside the room. It is never drawn but does
//    cast shadows, so the one shadowed light only reaches the room through the
//    window. The window frame's bars and the furniture cast shadows inside that
//    patch. As the sun lowers, the patch stretches across the floor and up the
//    side wall and turns orange. At night the same light becomes moonlight.
//
// 3. Ambient + a lamp. The environment light (sky bounce) dims after sunset and
//    a warm room light fades in, so the room stays readable at night.
//
// The day is a fast loop (DAY_SECONDS), with the keyframes below stretching the
// time the sun spends near the horizon: about a third of the loop is twilight.
// For screenshots and tuning, `?phase=0.33` in the URL freezes the time.
import * as THREE from 'three';

// ── Timing ──────────────────────────────────────────────────────────────
const DAY_SECONDS = 240; // one full day/night loop
const START_PHASE = 0.2; // late afternoon: the first sunset arrives ~25 s after load

// Sun elevation (degrees) through the day; phase 0 = noon, 0.5 = midnight.
// Twilight (−8°..+10°) runs 0.25→0.42 and 0.58→0.75: 34% of the loop.
const ELEVATION_KEYS: [number, number][] = [
  [0, 55], [0.25, 10], [0.33, 0], [0.42, -8], [0.5, -35],
  [0.58, -8], [0.67, 0], [0.75, 10], [1, 55],
];

// ── Light levels ────────────────────────────────────────────────────────
const SUN_INTENSITY = 5; // the patch of sunlight through the window
const MOON_INTENSITY = 0.7;
const ENV_DAY = 0.75; // scene.environmentIntensity at full day
const ENV_NIGHT = 0.12;
const FILL_DAY = 0.25; // soft sky light from the window side (no shadows); low, or it flattens the sun patch
const LAMP_INTENSITY = 22; // warm room light at night (candela; falls off with distance²)
const SHADOW_MAP = 2048; // texels across the room: 2048 → ~9 mm per texel
const SHADOW_HZ = 20; // the sun moves slowly; re-render its shadow map 20×/s, not every frame

// Where the outside horizon sits. The camera looks slightly down through the
// window, so a true horizon would fill it with ground; lowering the horizon
// reads as a room a few floors up, with the window mostly sky.
const HORIZON_DROP = 0.22;

const deg = THREE.MathUtils.degToRad;
const smooth = (a: number, b: number, x: number) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function elevationAt(phase: number) {
  const p = ((phase % 1) + 1) % 1;
  for (let i = 1; i < ELEVATION_KEYS.length; i++) {
    const [p1, e1] = ELEVATION_KEYS[i];
    if (p <= p1) {
      const [p0, e0] = ELEVATION_KEYS[i - 1];
      const t = (p - p0) / (p1 - p0);
      return e0 + (e1 - e0) * (1 - Math.cos(t * Math.PI)) / 2; // ease between keys
    }
  }
  return ELEVATION_KEYS[0][1];
}

// Direction *towards* the body (unit vector). The window is in the −X wall, so
// the sun is always outside on the −X side; its azimuth swings from one side
// wall to the other through the day (±60° at sunrise/sunset), so the light
// patch sweeps across the room and climbs the side walls at twilight.
function bodyDirection(phase: number, out: THREE.Vector3) {
  const el = deg(elevationAt(phase));
  const wrapped = ((phase + 0.5) % 1) - 0.5; // −0.5..0.5, 0 = noon
  const az = wrapped * Math.PI; // sunset (0.33) → 60°, sunrise → −60°
  return out.set(-Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
}

// Sunlight colour by elevation: warm white at noon → orange near the horizon.
const SUN_HIGH = new THREE.Color(0xfff2df);
const SUN_LOW = new THREE.Color(0xff8a3d);
const MOON = new THREE.Color(0x9fb6ff);

// ── Sky shader for the dome seen through the window ─────────────────────
const skyVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const skyFragment = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform float uDay;   // 1 at full day
  uniform float uDusk;  // peaks with the sun at the horizon
  uniform float uNight; // 1 at full night
  uniform float uTime;
  uniform float uHorizonDrop;
  varying vec3 vWorld;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  void main() {
    vec3 d = normalize(vWorld - cameraPosition);
    // Re-centre the horizon (see HORIZON_DROP) for the sky's vertical axis.
    vec3 s = normalize(vec3(d.x, d.y + uHorizonDrop, d.z));
    float h = s.y;

    vec3 dayZen = vec3(0.24, 0.50, 0.86), dayHor = vec3(0.70, 0.84, 0.96);
    vec3 duskZen = vec3(0.16, 0.20, 0.45), duskHor = vec3(1.00, 0.52, 0.28);
    vec3 nightZen = vec3(0.012, 0.02, 0.06), nightHor = vec3(0.05, 0.08, 0.16);

    vec3 zen = mix(nightZen, dayZen, uDay);
    vec3 hor = mix(nightHor, dayHor, uDay);
    zen = mix(zen, duskZen, uDusk * 0.7);
    hor = mix(hor, duskHor, uDusk);
    vec3 col = mix(hor, zen, smoothstep(0.0, 0.55, h));

    // Glow around the sun: wide and orange at dusk, faint by day.
    vec3 sunS = normalize(vec3(uSunDir.x, uSunDir.y, uSunDir.z));
    float toSun = max(dot(s, sunS), 0.0);
    col += vec3(1.0, 0.55, 0.25) * pow(toSun, 6.0) * uDusk * 0.9;
    col += vec3(1.0, 0.9, 0.7) * pow(toSun, 40.0) * (uDay + uDusk) * 0.5;
    col += vec3(1.0, 0.95, 0.85) * smoothstep(0.9990, 0.9995, toSun) * step(-0.03, uSunDir.y);

    // Moon disc and a faint halo.
    float toMoon = dot(s, normalize(uMoonDir));
    col += vec3(0.85, 0.9, 1.0) * smoothstep(0.9993, 0.9996, toMoon) * uNight;
    col += vec3(0.25, 0.3, 0.45) * pow(max(toMoon, 0.0), 60.0) * uNight;

    // Stars: one random point per small patch of sky, twinkling.
    vec3 cell = floor(s * 260.0);
    float r = hash(cell);
    float tw = 0.6 + 0.4 * sin(uTime * 3.0 + r * 40.0);
    col += vec3(0.9, 0.92, 1.0) * step(0.9975, r) * tw * uNight * smoothstep(0.02, 0.2, h);

    // Below the horizon: distant ground/rooftops, lit by the sky.
    vec3 ground = mix(vec3(0.02, 0.025, 0.04), vec3(0.20, 0.22, 0.20), uDay) + vec3(0.18, 0.08, 0.03) * uDusk;
    col = mix(col, ground, smoothstep(0.0, -0.02, h));

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export interface DayNightOptions {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  room: THREE.Object3D; // already scaled/positioned
  aperture: THREE.Object3D | null; // the window's frame/bars: its bounds = the hole in the wall
  noShadowCast: THREE.Object3D[]; // the room shell and curtains: don't cast
  roomBox: THREE.Box3; // the room's interior bounds (world space)
}

export function createDayNight(o: DayNightOptions) {
  const { scene, renderer, room, aperture, roomBox } = o;
  const frozen = new URLSearchParams(location.search).get('phase');
  let phase = frozen !== null ? Number(frozen) : START_PHASE;

  // ── Shadows: everything receives; furniture and the window frame cast ──
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const skip = new Set<THREE.Object3D>();
  for (const root of o.noShadowCast) root.traverse((x) => skip.add(x));
  room.traverse((x) => {
    const m = x as THREE.Mesh;
    if (!m.isMesh) return;
    m.receiveShadow = true;
    m.castShadow = !skip.has(m);
  });

  // ── The invisible shell with a window hole ──
  const occluder = new THREE.Group();
  occluder.name = 'daynight-occluder';
  const occMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide });
  occMat.shadowSide = THREE.DoubleSide;
  const pad = 0.12; // just outside the walls
  const lo = roomBox.min.clone().subScalar(pad);
  const hi = roomBox.max.clone().addScalar(pad);
  const big = 3; // overhang so no light leaks round the edges
  function quad(w: number, h: number, pos: THREE.Vector3, rot: THREE.Euler) {
    if (w <= 0 || h <= 0) return;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), occMat);
    m.position.copy(pos);
    m.rotation.copy(rot);
    m.castShadow = true;
    m.receiveShadow = false;
    m.frustumCulled = false;
    occluder.add(m);
  }
  const yLo = lo.y - big, yHi = hi.y + big;
  const zLo = lo.z - big, zHi = hi.z + big;
  // −X wall, in the plane x = lo.x, with the window's hole cut out.
  const faceX = new THREE.Euler(0, Math.PI / 2, 0); // plane's local X → world −Z, local Y → world Y
  if (aperture) {
    const g = new THREE.Box3().setFromObject(aperture);
    const wy0 = g.min.y, wy1 = g.max.y, wz0 = g.min.z, wz1 = g.max.z;
    const cy = (a: number, b: number) => (a + b) / 2;
    // below and above the window (full width)
    quad(zHi - zLo, wy0 - yLo, new THREE.Vector3(lo.x, cy(yLo, wy0), cy(zLo, zHi)), faceX);
    quad(zHi - zLo, yHi - wy1, new THREE.Vector3(lo.x, cy(wy1, yHi), cy(zLo, zHi)), faceX);
    // either side of the window (window height)
    quad(wz0 - zLo, wy1 - wy0, new THREE.Vector3(lo.x, cy(wy0, wy1), cy(zLo, wz0)), faceX);
    quad(zHi - wz1, wy1 - wy0, new THREE.Vector3(lo.x, cy(wy0, wy1), cy(wz1, zHi)), faceX);
  } else {
    quad(zHi - zLo, yHi - yLo, new THREE.Vector3(lo.x, cy2(yLo, yHi), cy2(zLo, zHi)), faceX);
  }
  // The two side walls and the open top, starting at the −X wall so rays
  // reaching the window from outside never cross them.
  const xSpan = hi.x + big - lo.x;
  const xMid = lo.x + xSpan / 2;
  quad(xSpan, yHi - yLo, new THREE.Vector3(xMid, cy2(yLo, yHi), lo.z), new THREE.Euler());
  quad(xSpan, yHi - yLo, new THREE.Vector3(xMid, cy2(yLo, yHi), hi.z), new THREE.Euler());
  quad(xSpan, hi.z - lo.z, new THREE.Vector3(xMid, hi.y, cy2(lo.z, hi.z)), new THREE.Euler(-Math.PI / 2, 0, 0));
  scene.add(occluder);

  // ── Lights ──
  const centre = roomBox.getCenter(new THREE.Vector3());
  const size = roomBox.getSize(new THREE.Vector3());
  const reach = size.length(); // big enough to cover the room from any angle

  // The sun (and, at night, the moon): the only shadowed light.
  const sky = new THREE.DirectionalLight(0xffffff, 0);
  sky.castShadow = true;
  sky.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  const cam = sky.shadow.camera;
  cam.left = cam.bottom = -reach / 2;
  cam.right = cam.top = reach / 2;
  cam.near = 0.5;
  cam.far = reach * 2.5;
  sky.shadow.bias = -0.0004;
  sky.shadow.normalBias = 0.02;
  sky.shadow.autoUpdate = false; // re-rendered at SHADOW_HZ below
  sky.target.position.copy(centre);
  scene.add(sky, sky.target);

  // Soft daylight from the window side, everywhere (no shadows): the light a
  // bright sky bounces in. Off at night.
  const fill = new THREE.DirectionalLight(0xe6eeff, 0);
  fill.position.set(-1, 1.6, 0.2);
  scene.add(fill);

  // A warm room light for the evening, hung near the ceiling.
  const lamp = new THREE.PointLight(0xffb46b, 0, 0, 2);
  lamp.position.set(centre.x + size.x * 0.1, roomBox.max.y - 0.6, centre.z);
  scene.add(lamp);

  // ── Sky dome ──
  const uniforms = {
    uSunDir: { value: new THREE.Vector3() },
    uMoonDir: { value: new THREE.Vector3() },
    uDay: { value: 1 },
    uDusk: { value: 0 },
    uNight: { value: 0 },
    uTime: { value: 0 },
    uHorizonDrop: { value: HORIZON_DROP },
  };
  // Inside-out sphere around the room (BackSide = we see its inner face). It
  // replaces the flat background colour wherever the outside is visible.
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(reach * 4, 32, 16),
    new THREE.ShaderMaterial({ uniforms, vertexShader: skyVertex, fragmentShader: skyFragment, side: THREE.BackSide, depthWrite: false }),
  );
  dome.position.copy(centre);
  dome.renderOrder = -1; // draw first; everything else draws over it
  dome.frustumCulled = false;
  scene.add(dome);

  const sunDir = new THREE.Vector3();
  const moonDir = new THREE.Vector3();
  const tmpColor = new THREE.Color();
  let sinceShadow = Infinity;
  let elapsed = 0;

  function apply() {
    const elSun = elevationAt(phase);
    const elMoon = elevationAt(phase + 0.5);
    bodyDirection(phase, sunDir);
    bodyDirection(phase + 0.5, moonDir);

    const day = smooth(-8, 12, elSun); // 0 night … 1 day
    const dusk = Math.max(0, 1 - Math.abs(elSun - 1) / 9); // peaks at the horizon
    const night = 1 - smooth(-10, -2, elSun);

    // The shadowed light follows the sun while it's up, then (after a gap
    // where neither is lit, so the direction change isn't visible) the moon.
    const wSun = smooth(-3, 3, elSun);
    const wMoon = smooth(-4, -9, elSun) * smooth(0, 10, elMoon);
    if (wSun > 0) {
      sky.position.copy(centre).addScaledVector(sunDir, reach);
      tmpColor.copy(SUN_LOW).lerp(SUN_HIGH, smooth(2, 25, elSun));
      sky.color.copy(tmpColor);
      // Low sun: boost a little so the long twilight patch reads clearly.
      sky.intensity = SUN_INTENSITY * wSun * (1 + 0.8 * dusk);
    } else {
      sky.position.copy(centre).addScaledVector(moonDir, reach);
      sky.color.copy(MOON);
      sky.intensity = MOON_INTENSITY * wMoon;
    }

    scene.environmentIntensity = ENV_NIGHT + (ENV_DAY - ENV_NIGHT) * day;
    fill.intensity = FILL_DAY * day;
    fill.color.setHex(0xe6eeff).lerp(SUN_LOW, dusk * 0.5);
    lamp.intensity = LAMP_INTENSITY * (1 - smooth(-6, 6, elSun));

    uniforms.uSunDir.value.copy(sunDir);
    uniforms.uMoonDir.value.copy(moonDir);
    uniforms.uDay.value = day;
    uniforms.uDusk.value = dusk;
    uniforms.uNight.value = night;
    uniforms.uTime.value = elapsed;
  }
  apply();
  sky.shadow.needsUpdate = true;

  return {
    update(dt: number) {
      elapsed += dt;
      if (frozen === null) phase = (phase + dt / DAY_SECONDS) % 1;
      apply();
      sinceShadow += dt;
      if (sinceShadow >= 1 / SHADOW_HZ) {
        sinceShadow = 0;
        sky.shadow.needsUpdate = true;
      }
    },
    get phase() {
      return phase;
    },
    dispose() {
      scene.remove(occluder, sky, sky.target, fill, lamp, dome);
      dome.geometry.dispose();
      (dome.material as THREE.Material).dispose();
      for (const m of occluder.children) (m as THREE.Mesh).geometry.dispose();
      occMat.dispose();
      sky.dispose();
    },
  };
}

function cy2(a: number, b: number) {
  return (a + b) / 2;
}

export type DayNight = ReturnType<typeof createDayNight>;
