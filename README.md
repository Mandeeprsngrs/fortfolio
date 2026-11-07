# Mandeep — portfolio site

Astro 7 (static output) + three.js r186. One page: Mandeep's room, orbitable from its open side.

```bash
npm install
npm run dev       # http://localhost:4321
npm run build     # static files in dist/ — upload these anywhere
npm run preview   # serve dist/ locally
npx astro check   # type-check .astro and .ts files
```

Requires Node ≥ 22.12.

## Layout

```
public/models/mandeep.glb      the room (copied verbatim, fetched by URL at runtime)
src/pages/index.astro          the page shell
src/components/Room.astro      <canvas> + its CSS + the <script> that mounts it
src/scripts/room.ts            all three.js code: renderer, lights, camera, loading
```

`mandeep.glb` is `../models/mandeep-textured-512.glb` (meshopt geometry + KTX2/Basis textures). To swap models, replace the file. Framing is computed from the `pPlane5` room shell, not the asset's units.

## Measured (2026-10-07, `npm run build`)

| file | bytes | brotli-11 |
|---|---:|---:|
| `_astro/Room…js` (three.js, GLTFLoader, KTX2Loader, OrbitControls, RoomEnvironment) | 722 KB | ~155 KB |
| `_astro/basis_transcoder.wasm` + `.js` (bundled automatically, see `room.ts`) | 585 KB | 217 KB |
| `models/mandeep.glb` | 2,712,600 | 1,533,204 |
| **total transferred (brotli)** | | **≈ 1.91 MB** |

Budget target is ~1.5 MB. The model is 80% of it; see `../models/README.md` for the levers.

Headless Chromium (SwiftShader, software GPU) reached `data-state="ready"` in 7–9 s at 1280×720 and 390×844 with no console errors. A real GPU will be faster; that number hasn't been measured.

## Loading state

`#room` carries `data-state="loading" | "ready" | "error"`. Use it from CSS (e.g. a fade-in) or tests.

## Editing the content

- **About / Projects / Contact** (the desk computer): `src/components/Computer.astro`.
  Text marked *Placeholder* is meant to be replaced; projects and links are small
  lists at the top of the file.
- **Title screen** (name, role, intro line): the `#intro` block in `src/components/Room.astro`.
- **Song posters**: titles/artists in `POSTER_SONGS` at the top of `src/scripts/posters.ts`;
  files in `public/media/`.
- **Motion poster** (dresser TV + the two frames by the window): `MOTION_POSTER_SRC` in
  `src/scripts/motionposters.ts`, file in `public/motion-posters/`. Use Mandeep's own
  renders (not film/TV clips). Make it small and muted-friendly:

  ```bash
  ffmpeg -i render.mp4 -t 10 -vf "scale=960:-2,fps=30" -c:v libx264 -preset slow -crf 26 \
         -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 96k motion.mp4
  ```

  (≈ 1–1.5 MB for 10 s; add `-an` instead of the audio options for a silent clip.)
- **Leaderboards**: `src/scripts/leaderboard.ts` (set `LEADERBOARD_API` once the
  Worker in `leaderboard-worker/` is deployed — see its README).

## Not done yet

- 10 materials have no texture (white) — files missing from Mandeep's folder
- Stray mesh `polySurface196` sits ~540 units outside the room; harmless here because framing ignores it
