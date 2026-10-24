// Song posters: each poster shows a cover image; click it to play a short
// audio clip, click again to stop. The poster glows gently while it plays.
//
// Covers are ordinary textures, loaded after the room so they never delay the
// first view. Audio is fetched only on the first click of each poster: an
// <audio> element is created on demand and streams, so playback starts after
// the first few KB rather than after the whole file.
import * as THREE from 'three';
import { asset } from './asset';

// Runtime node names → songs. `src` is a path in public/media/ without extension:
// <src>.jpg (cover, 5:7 portrait), <src>.webm (Opus) and <src>.m4a (AAC); the
// browser fetches only the first audio format it can play. `title` and
// `artist` appear on the "now playing" card (an empty artist hides that line).
export interface PosterSong {
  src: string;
  title: string;
  artist?: string;
}
export const POSTER_SONGS: Record<string, PosterSong> = {
  SM_Poster1__5_: { src: asset('media/poster-1'), title: 'Kahin Door', artist: '' },
  SM_Poster1__5_1: { src: asset('media/poster-2'), title: 'Placeholder 2' },
  SM_Poster1__5_2: { src: asset('media/poster-3'), title: 'Placeholder 3' },
};

// What room.ts (via nowplaying.ts) hears about playback.
export interface PosterEvents {
  onPlay?(song: PosterSong & { cover: string }): void;
  onProgress?(fraction: number): void; // 0..1, every frame while playing
  onStop?(): void;
}

const GLOW = { base: 0.12, amount: 0.12, speed: 4 }; // emissive intensity: base ± amount, rad/s
// Idle hint (hints.ts): a slower, softer breath that rolls from poster to poster.
const ATTRACT = { amount: 0.16, speed: 1.6, stagger: 1.1 }; // peak intensity, rad/s, phase offset per poster

interface Poster {
  name: string;
  meshes: THREE.Mesh[];
  materials: THREE.MeshStandardMaterial[];
  cover?: THREE.Texture;
  audio?: HTMLAudioElement;
}

export function createPosters(room: THREE.Object3D, events: PosterEvents = {}, songs = POSTER_SONGS) {
  const posters: Poster[] = [];
  for (const name of Object.keys(songs)) {
    const node = room.getObjectByName(name);
    if (!node) {
      console.warn(`Poster "${name}" not found in the model`);
      continue;
    }
    // A node is a Mesh, or a Group of Meshes when it has several materials.
    const meshes: THREE.Mesh[] = [];
    node.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    posters.push({ name, meshes, materials: meshes.map((m) => m.material as THREE.MeshStandardMaterial) });
  }
  const allMeshes = posters.flatMap((p) => p.meshes);
  let playing: Poster | null = null;
  let attract = false;

  // ── Covers ────────────────────────────────────────────────────────────
  const textureLoader = new THREE.TextureLoader();
  for (const p of posters) {
    textureLoader.load(`${songs[p.name].src}.jpg`, (tex) => {
      // glTF UVs expect images NOT flipped on upload; TextureLoader defaults to
      // flipping, which would put the cover upside down.
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      p.cover = tex;
      for (const m of p.materials) {
        m.map = tex;
        m.emissiveMap = tex; // the glow brightens the cover itself, not a flat colour
        m.emissive.set(0xffffff);
        m.emissiveIntensity = 0;
        m.color.set(0xffffff); // the map is multiplied by this; keep it neutral
        m.needsUpdate = true; // the shader changes when a material gains a map
      }
    });
  }

  // ── Picking ───────────────────────────────────────────────────────────
  function pick(raycaster: THREE.Raycaster): string | null {
    const hit = raycaster.intersectObjects(allMeshes, false)[0];
    if (!hit) return null;
    return posters.find((p) => p.meshes.includes(hit.object as THREE.Mesh))?.name ?? null;
  }

  // ── Audio ─────────────────────────────────────────────────────────────
  function createAudio(p: Poster) {
    const audio = document.createElement('audio');
    for (const [ext, type] of [
      ['webm', 'audio/webm; codecs=opus'],
      ['m4a', 'audio/mp4'],
    ]) {
      const source = document.createElement('source');
      source.src = `${songs[p.name].src}.${ext}`;
      source.type = type;
      audio.append(source);
    }
    audio.preload = 'auto';
    audio.addEventListener('ended', () => stop(p));
    // 'playing' fires once sound actually starts (after buffering), so the card
    // appears in sync with the music, not on the click.
    audio.addEventListener('playing', () => {
      if (playing === p) events.onPlay?.({ ...songs[p.name], cover: `${songs[p.name].src}.jpg` });
    });
    p.audio = audio;
  }

  function play(p: Poster) {
    if (playing && playing !== p) stop(playing);
    if (!p.audio) createAudio(p);
    playing = p;
    p.audio!.currentTime = 0;
    // The click that got us here counts as a user gesture, so sound is allowed.
    p.audio!.play().catch((err: DOMException) => {
      // AbortError = stopped (pause()) before it started; that's expected.
      if (err.name !== 'AbortError') console.error('Poster audio could not play', err);
      stop(p);
    });
  }

  function stop(p: Poster) {
    p.audio?.pause();
    for (const m of p.materials) m.emissiveIntensity = 0;
    if (playing === p) {
      playing = null;
      events.onStop?.();
    }
  }

  function toggle(name: string) {
    const p = posters.find((x) => x.name === name);
    if (!p) return;
    if (playing === p) stop(p);
    else play(p);
  }

  // Called every frame from room.ts with elapsed seconds.
  function update(t: number) {
    if (attract) {
      posters.forEach((p, i) => {
        if (p === playing) return;
        const s = Math.max(0, Math.sin(t * ATTRACT.speed - i * ATTRACT.stagger));
        for (const m of p.materials) m.emissiveIntensity = ATTRACT.amount * s * s; // s² = soft rise, short peak
      });
    }
    if (!playing || playing.audio?.paused) return;
    const a = playing.audio!;
    if (a.duration > 0) events.onProgress?.(a.currentTime / a.duration);
    const k = GLOW.base + GLOW.amount * Math.sin(t * GLOW.speed);
    for (const m of playing.materials) m.emissiveIntensity = k;
  }

  return {
    pick,
    toggle,
    update,
    setAttract(on: boolean) {
      attract = on;
      if (!on) for (const p of posters) if (p !== playing) for (const m of p.materials) m.emissiveIntensity = 0;
    },
    stopAll() {
      if (playing) stop(playing);
    },
    dispose() {
      for (const p of posters) {
        stop(p);
        p.cover?.dispose();
        p.audio?.removeAttribute('src');
        p.audio?.load();
      }
    },
  };
}

export type Posters = ReturnType<typeof createPosters>;
