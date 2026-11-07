// Motion posters: one looping video shown on the dresser TV's screen and inside
// the two white frames on the window wall.
//
// One <video> element, one THREE.VideoTexture: the video is decoded once and
// uploaded to the GPU once per frame, however many surfaces show it. Each
// surface is a plane whose UVs are cropped so the video *covers* it (like CSS
// object-fit: cover): a 16:9 clip in a squarer frame loses a little at the
// sides instead of being squashed.
//
// Browsers only autoplay video that is muted, so it starts muted; clicking any
// of the three surfaces toggles the sound (room.ts wires that up, and makes the
// song posters and this pause each other).
//
// To swap the clip: put an H.264 .mp4 in public/motion-posters/ and point
// MOTION_POSTER_SRC at it. Keep it small: 960×540 at ~1 Mbit/s is about 1 MB
// for 8 seconds (see the README for an ffmpeg command).
import * as THREE from 'three';
import { asset } from './asset';
import type { Glass } from './arcade';

export const MOTION_POSTER_SRC = asset('motion-posters/placeholder.mp4');

export interface Panel {
  centre: THREE.Vector3; // world
  normal: THREE.Vector3; // facing into the room
  w: number; // world width / height of the area to fill
  h: number;
}

// Flat panels inside a frame mesh: connected pieces of geometry with ~zero
// thickness along one axis (the frame's borders are thicker bars). Found from
// the geometry itself, so a re-export with moved frames still works.
export function flatPanels(mesh: THREE.Mesh, intoRoom: THREE.Vector3): Panel[] {
  mesh.updateMatrixWorld(true);
  const g = mesh.geometry;
  const pos = g.attributes.position;
  const index = g.index ? g.index.array : Array.from({ length: pos.count }, (_, i) => i);
  const parent = Int32Array.from({ length: pos.count }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let i = 0; i < index.length; i += 3) {
    const a = find(index[i]);
    parent[find(index[i + 1])] = a;
    parent[find(index[i + 2])] = a;
  }
  const boxes = new Map<number, THREE.Box3>();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const r = find(i);
    if (!boxes.has(r)) boxes.set(r, new THREE.Box3());
    boxes.get(r)!.expandByPoint(v);
  }
  const panels: Panel[] = [];
  for (const b of boxes.values()) {
    const s = b.getSize(new THREE.Vector3());
    const thin = s.x < 0.005 ? 'x' : s.y < 0.005 ? 'y' : s.z < 0.005 ? 'z' : null;
    if (!thin) continue;
    const normal = new THREE.Vector3();
    normal[thin] = Math.sign(intoRoom[thin]) || 1;
    const [w, h] = thin === 'x' ? [s.z, s.y] : thin === 'z' ? [s.x, s.y] : [s.x, s.z];
    panels.push({ centre: b.getCenter(new THREE.Vector3()), normal, w, h });
  }
  return panels;
}

export function createMotionPosters(opts: {
  scene: THREE.Scene;
  tv: THREE.Object3D | null; // the dresser TV
  tvGlass: Glass | null; // its glass, in its mesh space (same model as the game TV)
  panels: Panel[];
}) {
  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true; // iOS: play in place, not fullscreen
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  let started = false;

  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  // A screen glows; it isn't lit by the room, and tone mapping would dull it.
  const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  const surfaces: { mesh: THREE.Mesh; aspect: number }[] = [];

  function addPlane(w: number, h: number, place: (m: THREE.Mesh) => void) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    place(mesh);
    mesh.name = 'motion-poster';
    surfaces.push({ mesh, aspect: w / h });
    return mesh;
  }

  if (opts.tv && opts.tvGlass) {
    const g = opts.tvGlass;
    const tvPlane = addPlane(g.w, g.h, (m) => {
      // Same placement as the game TV's screen (see arcade.ts).
      m.rotation.x = Math.PI / 2;
      m.position.set(g.cx, g.y, g.cz);
    });
    opts.tv.add(tvPlane);
    // The plane is in TV mesh space, so its aspect needs the TV's world scale.
    const s = new THREE.Vector3().setFromMatrixScale(opts.tv.matrixWorld);
    surfaces[surfaces.length - 1].aspect = (g.w * s.x) / (g.h * s.z);
  }
  for (const p of opts.panels) {
    const m = addPlane(p.w, p.h, (mesh) => {
      mesh.position.copy(p.centre).addScaledVector(p.normal, 0.004); // just in front of the frame's backing
      mesh.lookAt(mesh.position.clone().add(p.normal)); // the plane's front (+Z) faces into the room
    });
    opts.scene.add(m);
  }

  // Crop UVs so the video covers each surface without stretching.
  function cover() {
    const va = video.videoWidth / video.videoHeight;
    if (!va) return;
    for (const { mesh, aspect } of surfaces) {
      const uv = mesh.geometry.attributes.uv as THREE.BufferAttribute;
      const fu = aspect < va ? aspect / va : 1; // fraction of the video's width shown
      const fv = aspect > va ? va / aspect : 1; // fraction of its height
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i) > 0.5 ? 1 : 0;
        const v = uv.getY(i) > 0.5 ? 1 : 0;
        uv.setXY(i, 0.5 + (u - 0.5) * fu, 0.5 + (v - 0.5) * fv);
      }
      uv.needsUpdate = true;
    }
  }
  video.addEventListener('loadedmetadata', cover);

  return {
    meshes: surfaces.map((s) => s.mesh),
    /** Start loading and playing (muted). Called once the visitor enters the room. */
    start() {
      if (started) return;
      started = true;
      video.src = MOTION_POSTER_SRC;
      video.play().catch(() => {
        /* autoplay refused (e.g. data saver): it shows the first frame instead */
      });
    },
    get muted() {
      return video.muted;
    },
    /** Toggle sound. Returns true if it is now audible. Must run inside a click (user gesture). */
    toggleSound() {
      video.muted = !video.muted;
      if (video.paused) video.play().catch(() => {});
      return !video.muted;
    },
    mute() {
      video.muted = true;
    },
    dispose() {
      video.pause();
      video.removeAttribute('src');
      video.load();
      texture.dispose();
      material.dispose();
      for (const { mesh } of surfaces) {
        mesh.removeFromParent();
        mesh.geometry.dispose();
      }
    },
  };
}

export type MotionPosters = ReturnType<typeof createMotionPosters>;
