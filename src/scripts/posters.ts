// Clickable posters: click one and its 10-second clip plays on the poster itself.
//
// How video gets onto a 3D surface: a hidden <video> element decodes the clip,
// and THREE.VideoTexture uploads its current frame to the GPU whenever a new
// frame is ready. Swap that texture into the poster's material and the poster
// becomes a screen. When the clip ends, the original material map goes back.
//
// Nothing is downloaded until the first click: the <video> element is created
// on demand, so clips cost nothing on page load.
import * as THREE from 'three';

// Runtime node names (GLTFLoader strips dots; these had none) → clip files in
// public/media/. Each clip is offered as WebM (VP9 + Opus) first and MP4
// (H.264 + AAC) second; the browser downloads only the first one it can play.
// The current files are placeholders — replace them, keeping the names.
export const POSTER_CLIPS: Record<string, string> = {
  SM_Poster1__5_: '/media/poster-1',
  SM_Poster1__5_1: '/media/poster-2',
  SM_Poster1__5_2: '/media/poster-3',
};

interface Poster {
  name: string;
  meshes: THREE.Mesh[];
  materials: THREE.MeshStandardMaterial[];
  originalMaps: (THREE.Texture | null)[];
  video?: HTMLVideoElement;
  texture?: THREE.VideoTexture;
}

export function createPosters(room: THREE.Object3D, clips = POSTER_CLIPS) {
  const posters: Poster[] = [];
  for (const name of Object.keys(clips)) {
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
    const materials = meshes.map((m) => m.material as THREE.MeshStandardMaterial);
    posters.push({ name, meshes, materials, originalMaps: materials.map((m) => m.map) });
  }
  const allMeshes = posters.flatMap((p) => p.meshes);
  let playing: Poster | null = null;

  // Which poster (if any) a ray hits. Only the poster meshes are tested.
  function pick(raycaster: THREE.Raycaster): string | null {
    const hit = raycaster.intersectObjects(allMeshes, false)[0];
    if (!hit) return null;
    return posters.find((p) => p.meshes.includes(hit.object as THREE.Mesh))?.name ?? null;
  }

  function createVideo(p: Poster) {
    const video = document.createElement('video');
    for (const [ext, type] of [
      ['webm', 'video/webm'],
      ['mp4', 'video/mp4'],
    ]) {
      const source = document.createElement('source');
      source.src = `${clips[p.name]}.${ext}`;
      source.type = type;
      video.append(source);
    }
    video.playsInline = true; // iOS would otherwise go fullscreen
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.addEventListener('ended', () => stop(p));
    // Swap the texture in only once frames are actually arriving. Swapping on
    // click shows a black poster for however long the clip takes to start.
    video.addEventListener('playing', () => {
      if (playing === p) showVideo(p);
    });

    const texture = new THREE.VideoTexture(video);
    // glTF's UVs assume images are NOT flipped on upload (its textures use
    // flipY = false). VideoTexture defaults to true, which would play upside down.
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    p.video = video;
    p.texture = texture;
  }

  function showVideo(p: Poster) {
    for (const m of p.materials) {
      m.map = p.texture!;
      m.color.set(0xffffff); // the map is multiplied by this; keep it neutral
      m.needsUpdate = true; // the shader changes when a material gains a map
    }
  }

  function play(p: Poster) {
    if (playing && playing !== p) stop(playing);
    if (!p.video) createVideo(p);
    playing = p;
    p.video!.currentTime = 0;
    // The click that got us here counts as a user gesture, so sound is allowed.
    p.video!.play().catch((err: DOMException) => {
      // AbortError = stopped (pause()) before it started; that's expected.
      if (err.name !== 'AbortError') console.error('Poster clip could not play', err);
      stop(p);
    });
  }

  function stop(p: Poster) {
    p.video?.pause();
    p.materials.forEach((m, i) => {
      m.map = p.originalMaps[i];
      m.needsUpdate = true;
    });
    if (playing === p) playing = null;
  }

  // Click a poster: play it. Click the one already playing: stop it.
  function toggle(name: string) {
    const p = posters.find((x) => x.name === name);
    if (!p) return;
    if (playing === p) stop(p);
    else play(p);
  }

  return {
    pick,
    toggle,
    stopAll() {
      if (playing) stop(playing);
    },
    dispose() {
      for (const p of posters) {
        stop(p);
        p.texture?.dispose();
        p.video?.removeAttribute('src');
        p.video?.load();
      }
    },
  };
}

export type Posters = ReturnType<typeof createPosters>;
