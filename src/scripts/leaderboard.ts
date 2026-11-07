// Two leaderboards on the wall above the TV: darts (best 3-dart round) and the
// maze (final score). They replace the nine blank picture frames there.
//
// Data comes from the Cloudflare Worker in ../../leaderboard-worker, which
// republishes the top 10 every 8 hours. A player who makes the top 10 is asked
// for 3-letter initials; the score is sent to the Worker and added to *their*
// board straight away (remembered in localStorage until the next publish), so
// they see it now while everyone else sees it after the 8-hour update.
//
// Each board is a thin box on the wall whose front face is a canvas texture:
// we draw the table with the 2D canvas API and re-upload it when it changes
// (rarely), so the boards cost nothing per frame.
import * as THREE from 'three';

// The deployed Worker's URL, e.g. 'https://mandeep-leaderboard.<you>.workers.dev'.
// Empty = boards show "coming soon" and no initials are asked for.
// For local testing, `?lbapi=http://localhost:8787` in the page URL overrides it.
export const LEADERBOARD_API = '';

export type Game = 'darts' | 'maze';
interface Entry {
  name: string;
  score: number;
  mine?: boolean; // submitted from this browser, not yet in a published board
}
interface Pending extends Entry {
  game: Game;
  at: number; // ms timestamp
}

const TOP = 10;
const PENDING_KEY = 'leaderboard-pending';
const INITIALS_KEY = 'leaderboard-initials';
const PENDING_MS = 9 * 3600 * 1000; // a bit over 8 h: until the next publish includes it
const BLOCKED = new Set(['ASS', 'FUK', 'FUC', 'FCK', 'SEX', 'KKK', 'NIG', 'FAG', 'CUM', 'DIK', 'TIT', 'XXX', 'WTF', 'GAY', 'KYS']); // same list as the Worker

// Board size on the wall (scene units) and canvas resolution (same aspect).
const BOARD_W = 1.15;
const BOARD_H = 1.6;
const BOARD_GAP = 0.3;
const CANVAS_W = 512;
const CANVAS_H = Math.round((CANVAS_W * BOARD_H) / BOARD_W);

// localStorage can throw (private mode, blocked storage): never let it break the page.
function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

// ── Drawing ───────────────────────────────────────────────────────────────
interface Style {
  title: string;
  subtitle: string;
  bg: string;
  border: string;
  text: string;
  dim: string;
  accent: string;
  font: string;
  scanlines: boolean;
}
const STYLES: Record<Game, Style> = {
  // A pub chalkboard, like the scoreboard next to a real dartboard.
  darts: {
    title: 'DARTS',
    subtitle: 'BEST ROUND · 3 DARTS',
    bg: '#1f3326',
    border: '#6b4a2b',
    text: '#f1ede2',
    dim: 'rgba(241,237,226,0.55)',
    accent: '#e8c547',
    font: '"Trebuchet MS", "Segoe UI", system-ui, sans-serif',
    scanlines: false,
  },
  // The maze's own CRT look: green on near-black, monospace, scanlines.
  maze: {
    title: 'MAZE',
    subtitle: 'HIGH SCORES',
    bg: '#06110a',
    border: '#1c4a23',
    text: '#d8ffcf',
    dim: '#7fae7a',
    accent: '#d8ff6a',
    font: 'monospace',
    scanlines: true,
  },
};

function drawBoard(ctx: CanvasRenderingContext2D, s: Style, entries: Entry[] | null, status: string) {
  const W = CANVAS_W;
  const H = CANVAS_H;
  ctx.fillStyle = s.border;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = s.bg;
  ctx.fillRect(18, 18, W - 36, H - 36);

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillStyle = s.accent;
  ctx.font = `bold 64px ${s.font}`;
  ctx.fillText(s.title, W / 2, 84);
  ctx.fillStyle = s.dim;
  ctx.font = `bold 22px ${s.font}`;
  ctx.fillText(s.subtitle, W / 2, 132);

  const top = 182;
  const row = (H - top - 90) / TOP;
  if (!entries) {
    ctx.fillStyle = s.dim;
    ctx.font = `bold 28px ${s.font}`;
    ctx.fillText(status, W / 2, top + row * 4);
  } else {
    for (let i = 0; i < TOP; i++) {
      const y = top + row * (i + 0.5);
      const e = entries[i];
      ctx.font = `bold 34px ${s.font}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = s.dim;
      ctx.fillText(String(i + 1).padStart(2, ' '), 56, y);
      ctx.fillStyle = e?.mine ? s.accent : s.text;
      ctx.fillText(e ? e.name : '---', 128, y);
      ctx.textAlign = 'right';
      ctx.fillText(e ? String(e.score) : '', W - 56, y);
    }
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = s.dim;
  ctx.font = `20px ${s.font}`;
  ctx.fillText(entries ? status : '', W / 2, H - 52);

  if (s.scanlines) {
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = 18; y < H - 18; y += 4) ctx.fillRect(18, y, W - 36, 2);
  }
}

// ── Initials prompt (markup in Room.astro) ──────────────────────────────────
function promptInitials(form: HTMLFormElement, game: Game, score: number, send: (name: string) => Promise<string | null>) {
  const input = form.querySelector<HTMLInputElement>('input[name="initials"]')!;
  const msg = form.querySelector<HTMLElement>('.hs-msg')!;
  const skip = form.querySelector<HTMLButtonElement>('.hs-skip')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  form.querySelector<HTMLElement>('.hs-game')!.textContent = game === 'darts' ? 'Darts' : 'Maze';
  form.querySelector<HTMLElement>('.hs-score')!.textContent = String(score);
  input.value = load<string>(INITIALS_KEY, '');
  msg.textContent = '';
  submit.disabled = false;
  form.hidden = false;
  input.focus();
  input.select();

  return new Promise<void>((resolve) => {
    const close = () => {
      form.hidden = true;
      form.removeEventListener('submit', onSubmit);
      form.removeEventListener('keydown', onKey);
      skip.removeEventListener('click', close);
      input.removeEventListener('input', onInput);
      resolve();
    };
    const onInput = () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
    };
    const onKey = (e: KeyboardEvent) => {
      // Keep keys away from the games and room.ts (Escape = back to room).
      e.stopPropagation();
      if (e.key === 'Escape') close();
    };
    const onSubmit = async (e: SubmitEvent) => {
      e.preventDefault();
      const name = input.value;
      if (!/^[A-Z]{3}$/.test(name)) return void (msg.textContent = 'Three letters, A–Z.');
      if (BLOCKED.has(name)) return void (msg.textContent = 'Please choose other initials.');
      submit.disabled = true;
      msg.textContent = 'Saving…';
      const error = await send(name);
      if (error) {
        msg.textContent = error;
        submit.disabled = false;
        return;
      }
      save(INITIALS_KEY, name);
      close();
    };
    form.addEventListener('submit', onSubmit);
    form.addEventListener('keydown', onKey);
    skip.addEventListener('click', close);
    input.addEventListener('input', onInput);
  });
}

// ── The boards ───────────────────────────────────────────────────────────────
export function createLeaderboards(opts: {
  scene: THREE.Scene;
  wallArea: THREE.Box3; // where the boards go (the old frames' bounds), on a wall facing +Z
  form: HTMLFormElement | null;
}) {
  const api = new URLSearchParams(location.search).get('lbapi') ?? LEADERBOARD_API;
  const published: Record<Game, Entry[] | null> = { darts: null, maze: null };
  let status = api ? 'Loading…' : 'Coming soon';
  let nextUpdateAt: string | null = null;
  let busy = false; // an initials prompt is open

  const area = opts.wallArea;
  const centre = area.getCenter(new THREE.Vector3());
  const backZ = area.min.z; // the frames' back = (almost) the wall surface
  const boards = (['darts', 'maze'] as Game[]).map((game, i) => {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d')!;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4; // seen at an angle from across the room
    const side = new THREE.MeshStandardMaterial({ color: STYLES[game].border, roughness: 0.8 });
    // The maze board glows a little (it's a screen); the chalkboard is lit by the room.
    const front =
      game === 'maze'
        ? new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.6 })
        : new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95 });
    // BoxGeometry face order: +x, −x, +y, −y, +z (front, into the room), −z.
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, BOARD_H, 0.04), [side, side, side, side, front, side]);
    const x = centre.x + (i === 0 ? -1 : 1) * (BOARD_W + BOARD_GAP) / 2;
    mesh.position.set(x, centre.y + 0.15, backZ + 0.02);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = `leaderboard-${game}`;
    opts.scene.add(mesh);
    return { game, ctx, texture, mesh, materials: [side, front] };
  });

  function pending(): Pending[] {
    const now = Date.now();
    return load<Pending[]>(PENDING_KEY, []).filter((p) => now - p.at < PENDING_MS);
  }

  // Published top 10, plus this browser's own unpublished scores, best per name.
  function merged(game: Game): Entry[] {
    const best = new Map<string, Entry>();
    for (const e of [...(published[game] ?? []), ...pending().filter((p) => p.game === game).map((p) => ({ name: p.name, score: p.score, mine: true }))]) {
      const prev = best.get(e.name);
      if (!prev || e.score > prev.score) best.set(e.name, e);
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, TOP);
  }

  function redraw() {
    for (const b of boards) {
      drawBoard(b.ctx, STYLES[b.game], published[b.game] ? merged(b.game) : null, status);
      b.texture.needsUpdate = true;
    }
  }

  function updatedLabel() {
    if (!nextUpdateAt) return 'Updates every 8 hours';
    const h = Math.max(0, (new Date(nextUpdateAt).getTime() - Date.now()) / 3600e3);
    return h < 1 ? 'Next update in under an hour' : `Next update in ${Math.round(h)} h`;
  }

  async function refresh() {
    if (!api) return redraw();
    try {
      const res = await fetch(`${api}/leaderboard`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      published.darts = data.darts;
      published.maze = data.maze;
      nextUpdateAt = data.nextUpdateAt;
      status = updatedLabel();
      // Drop pending scores the published board now includes.
      save(PENDING_KEY, pending().filter((p) => !(published[p.game] ?? []).some((e) => e.name === p.name && e.score >= p.score)));
    } catch (err) {
      console.warn('Leaderboard unavailable', err);
      status = 'Scores unavailable right now';
    }
    redraw();
  }

  function qualifies(game: Game, score: number) {
    if (!api || score <= 0 || !published[game]) return false;
    const list = merged(game);
    return list.length < TOP || score > list[list.length - 1].score;
  }

  async function send(game: Game, name: string, score: number): Promise<string | null> {
    try {
      const res = await fetch(`${api}/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game, name, score }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return body.error ?? `Couldn't save (error ${res.status}).`;
      }
      save(PENDING_KEY, [...pending(), { game, name, score, at: Date.now() }]);
      redraw();
      return null;
    } catch {
      return "Couldn't reach the leaderboard. Try again?";
    }
  }

  redraw();
  refresh();

  return {
    /** Called by the games when a score is final. Prompts for initials if it makes the top 10. */
    offer(game: Game, score: number) {
      if (busy || !opts.form || !qualifies(game, score)) return;
      busy = true;
      promptInitials(opts.form, game, score, (name) => send(game, name, score)).finally(() => (busy = false));
    },
    dispose() {
      for (const b of boards) {
        opts.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.materials.forEach((m) => m.dispose());
        b.texture.dispose();
      }
    },
  };
}

export type Leaderboards = ReturnType<typeof createLeaderboards>;
