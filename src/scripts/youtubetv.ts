// A YouTube video playing on a TV in the room, muted and looping, like a TV
// left on in a teenager's room.
//
// A browser can't paint a YouTube <iframe> into WebGL (cross-origin pixels
// are off limits), so this uses the "hole punch" technique:
//   1. The real YouTube player sits in a layer BEHIND the 3D canvas, moved
//      and skewed with CSS 3D transforms (three's CSS3DRenderer) so it lines
//      up exactly with the TV's glass from the current camera.
//   2. In the 3D scene, the glass gets a mesh that writes transparent pixels
//      (alpha 0, NoBlending). The canvas is transparent there, so the player
//      behind shows through. Depth testing still applies: anything in front of
//      the TV (the bed, from some angles) draws over the hole as normal.
//
// Loaded lazily: the iframe (~1.2 MB of YouTube player code, then the video
// stream) is only created once the room has finished loading.
//
// Note: in the room view the TV is far smaller than YouTube's 200×200 px
// minimum for embedded players, and objects can pass in front of it, which
// YouTube's embed terms don't allow. Set YOUTUBE_TV.enabled = false to turn
// it off (the TV then shows the local motion-poster video instead).
import * as THREE from 'three';
import { CSS3DObject, CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js';
import type { Glass } from './arcade';

export const YOUTUBE_TV = {
  enabled: true,
  videoId: 'irVNGjRFZGk', // Marvel Entertainment — "Avengers: Doomsday | Official Trailer"
};

// The iframe is laid out at this pixel size, then scaled down to the glass.
// 4:3 like the TV; YouTube letterboxes the 16:9 trailer inside it.
const PX_W = 480;
const PX_H = 360;

export function createYouTubeTV(opts: {
  scene: THREE.Scene;
  tv: THREE.Object3D;
  glass: Glass; // in the TV mesh's space
  layer: HTMLElement; // positioned behind the WebGL canvas, same size
}) {
  const { tv, glass, layer } = opts;

  // ── The hole in the WebGL image ──
  const hole = new THREE.Mesh(
    new THREE.PlaneGeometry(glass.w, glass.h),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, blending: THREE.NoBlending }),
  );
  hole.rotation.x = Math.PI / 2; // same placement as the TV screens elsewhere (see arcade.ts)
  hole.position.set(glass.cx, glass.y, glass.cz);
  hole.name = 'youtube-tv-hole';
  tv.add(hole);

  // ── The CSS 3D layer with the player ──
  const css = new CSS3DRenderer({ element: layer });
  const cssScene = new THREE.Scene();
  const frame = document.createElement('div');
  frame.style.width = `${PX_W}px`;
  frame.style.height = `${PX_H}px`;
  frame.style.background = '#000';
  frame.style.pointerEvents = 'none'; // clicks go to the canvas (room.ts handles them)
  const object = new CSS3DObject(frame);
  cssScene.add(object);

  // Place the CSS object exactly on the glass, in world space.
  function place() {
    tv.updateWorldMatrix(true, false);
    hole.updateWorldMatrix(false, false);
    hole.matrixWorld.decompose(object.position, object.quaternion, object.scale);
    // CSS3D units are pixels: scale PX_W px down to the glass's world width.
    const worldScale = new THREE.Vector3().setFromMatrixScale(tv.matrixWorld);
    object.scale.set((glass.w * worldScale.x) / PX_W, (glass.h * worldScale.z) / PX_H, 1);
  }
  place();

  let iframe: HTMLIFrameElement | null = null;
  function start() {
    if (iframe) return;
    const id = YOUTUBE_TV.videoId;
    const params = new URLSearchParams({
      autoplay: '1',
      mute: '1', // browsers only autoplay muted video
      loop: '1',
      playlist: id, // `loop` only works with a playlist, even of one
      controls: '0',
      playsinline: '1',
      rel: '0',
      enablejsapi: '1', // lets us unmute it on click via postMessage
      origin: location.origin,
    });
    iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube-nocookie.com/embed/${id}?${params}`;
    iframe.title = 'Avengers: Doomsday — official trailer (YouTube)';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    Object.assign(iframe.style, { width: '100%', height: '100%', border: '0', display: 'block' });
    frame.append(iframe);
  }

  let muted = true;
  function command(func: string) {
    iframe?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*');
  }

  return {
    pickTargets: [tv],
    start,
    /** Toggle sound (call from a click). Returns true if it is now audible. */
    toggleSound() {
      if (!iframe) return false;
      muted = !muted;
      command(muted ? 'mute' : 'unMute');
      if (!muted) command('playVideo');
      return !muted;
    },
    mute() {
      if (!muted) {
        muted = true;
        command('mute');
      }
    },
    setSize(w: number, h: number) {
      css.setSize(w, h);
    },
    render(camera: THREE.Camera) {
      css.render(cssScene, camera);
    },
    dispose() {
      iframe?.remove();
      hole.removeFromParent();
      hole.geometry.dispose();
      (hole.material as THREE.Material).dispose();
    },
  };
}

export type YouTubeTV = ReturnType<typeof createYouTubeTV>;
