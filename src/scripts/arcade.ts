// A small maze game on the TV next to the console: guide a firefly around a
// hedge maze, collect the seeds of light, avoid the moths. A lantern turns the
// tables for a few seconds: the moths flee, and any you catch go back to the
// nest to wait.
//
// How it gets onto the TV: the game draws into an ordinary 2D <canvas> (never
// added to the page). A THREE.CanvasTexture uploads that canvas to the GPU
// whenever we set `needsUpdate`, and a thin plane parented to the TV shows it,
// just in front of the glass. The plane uses MeshBasicMaterial, which ignores
// scene lighting — a screen emits light, it isn't lit by the room.
//
// Loaded with import() once the room is on screen. Until someone clicks the
// console, the TV plays a demo — the firefly steers itself — as the hint that
// it's playable, like an arcade cabinet's attract mode.
import * as THREE from 'three';

// ── Screen ──────────────────────────────────────────────────────────────
const W = 320;
const H = 240; // 4:3, matching the TV's glass (measured: 0.316 × 0.237 local units)
const TILE = 10; // bigger tiles + fewer cells = a simpler, more readable maze
const HUD_H = 16;

// Where the glass is, in the TV mesh's local space. Defined in room.ts (which
// also needs it to aim the camera) and passed in.
export interface Glass {
  cx: number; // centre, local x
  cz: number; // centre, local z (z is up in this mesh)
  y: number; // local y of the plane — just in front of the glass bulge
  w: number;
  h: number;
}

// ── Tuning ──────────────────────────────────────────────────────────────
const MAZE_COLS = 15; // maze cells; the tile grid is 2n+1 so walls are tiles too
const MAZE_ROWS = 10;
const LOOP_CHANCE = 0.3; // extra walls removed so the maze has loops, not just dead ends
const PLAYER_SPEED = 6; // tiles per second
const MOTH_SPEED = 4.6; // tiles per second at level 1
const MOTH_SPEEDUP = 0.06; // +6% per level
const SCARED_SECONDS = 6; // how long a lantern makes the moths catchable
const SCARED_SPEED = 0.55; // fleeing moths move at this fraction of their speed
const CATCH_POINTS = 100; // first catch per lantern; each further catch doubles it
const NEST_WAIT = 4; // seconds a caught moth waits in the nest before coming out
const NEST_STAGGER = 1; // at the start of a life, each moth leaves this much after the last
const LIVES = 3;
const LANTERNS = 4;

type Dir = 0 | 1 | 2 | 3; // up, right, down, left
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const opposite = (d: Dir) => ((d + 2) % 4) as Dir;

interface Mover {
  x: number; // tile coordinates of the tile we're leaving
  y: number;
  dir: Dir | null; // null = standing still
  t: number; // 0..1 progress toward the next tile
  speed: number;
}
interface Moth extends Mover {
  kind: 'chaser' | 'ambusher' | 'wanderer';
  home: { x: number; y: number };
  waitUntil: number; // game time at which it may leave the nest; while waiting it's harmless
  scaredUntil: number; // game time until which it flees and can be caught
}

type State = 'demo' | 'title' | 'play' | 'paused' | 'dead' | 'clear' | 'over';

export function createArcade(opts: { tv: THREE.Object3D; glass: Glass; input: HTMLElement }) {
  const { tv, glass: GLASS, input } = opts;

  // ── Canvas + texture + plane on the TV ─────────────────────────────────
  const screen = document.createElement('canvas');
  screen.width = W;
  screen.height = H;
  const ctx = screen.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const texture = new THREE.CanvasTexture(screen);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter; // crisp pixels when the camera is close
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(GLASS.w, GLASS.h),
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
  );
  // PlaneGeometry faces +Z with +Y up. The TV's front is −Y and its up is +Z,
  // so rotate +90° about X: +Z → −Y (facing out of the glass), +Y → +Z (up).
  plane.rotation.x = Math.PI / 2;
  plane.position.set(GLASS.cx, GLASS.y, GLASS.cz);
  plane.visible = false;
  tv.add(plane); // parented, so it follows the TV's position, rotation and scale

  // ── Maze ───────────────────────────────────────────────────────────────
  const GW = MAZE_COLS * 2 + 1;
  const GH = MAZE_ROWS * 2 + 1;
  const OX = Math.floor((W - GW * TILE) / 2);
  const OY = HUD_H + Math.floor((H - HUD_H - GH * TILE) / 2);
  let wall: boolean[][] = [];
  let seeds: boolean[][] = [];
  let lanterns: boolean[][] = [];
  let seedsLeft = 0;

  // Recursive-backtracker maze: start with all walls, carve a random spanning
  // tree of cells, then knock out a few extra walls to create loops (a pure
  // tree has dead ends everywhere, which makes being chased unfair).
  function buildMaze() {
    wall = Array.from({ length: GH }, () => Array(GW).fill(true));
    const seen = Array.from({ length: MAZE_ROWS }, () => Array(MAZE_COLS).fill(false));
    const stack: [number, number][] = [[0, 0]];
    seen[0][0] = true;
    wall[1][1] = false;
    while (stack.length) {
      const [cx, cy] = stack[stack.length - 1];
      const options = ([0, 1, 2, 3] as Dir[]).filter((d) => {
        const nx = cx + DX[d];
        const ny = cy + DY[d];
        return nx >= 0 && ny >= 0 && nx < MAZE_COLS && ny < MAZE_ROWS && !seen[ny][nx];
      });
      if (!options.length) {
        stack.pop();
        continue;
      }
      const d = options[Math.floor(Math.random() * options.length)];
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      wall[cy * 2 + 1 + DY[d]][cx * 2 + 1 + DX[d]] = false;
      wall[ny * 2 + 1][nx * 2 + 1] = false;
      seen[ny][nx] = true;
      stack.push([nx, ny]);
    }
    for (let y = 1; y < GH - 1; y++)
      for (let x = 1; x < GW - 1; x++) {
        if (!wall[y][x] || Math.random() > LOOP_CHANCE) continue;
        const horizontal = !wall[y][x - 1] && !wall[y][x + 1] && wall[y - 1][x] && wall[y + 1][x];
        const vertical = !wall[y - 1][x] && !wall[y + 1][x] && wall[y][x - 1] && wall[y][x + 1];
        if (horizontal || vertical) wall[y][x] = false;
      }
    // A small open room in the middle where the moths start.
    const mx = MAZE_COLS;
    const my = MAZE_ROWS;
    for (let y = my - 1; y <= my + 1; y++) for (let x = mx - 2; x <= mx + 2; x++) wall[y][x] = false;

    seeds = wall.map((row) => row.map((w) => !w));
    lanterns = wall.map((row) => row.map(() => false));
    for (let y = my - 1; y <= my + 1; y++) for (let x = mx - 2; x <= mx + 2; x++) seeds[y][x] = false;
    // Lanterns go on the open tiles nearest each corner.
    const corners = [
      [1, 1],
      [GW - 2, 1],
      [1, GH - 2],
      [GW - 2, GH - 2],
    ].slice(0, LANTERNS);
    for (const [x, y] of corners) {
      lanterns[y][x] = true;
      seeds[y][x] = false;
    }
    seeds[spawn.y][spawn.x] = false;
    seedsLeft = seeds.flat().filter(Boolean).length;
  }

  const spawn = { x: MAZE_COLS, y: GH - 2 }; // bottom middle (odd x, always a cell)
  const isOpen = (x: number, y: number) => x >= 0 && y >= 0 && x < GW && y < GH && !wall[y][x];

  // ── Entities ───────────────────────────────────────────────────────────
  const player: Mover = { x: spawn.x, y: spawn.y, dir: null, t: 0, speed: PLAYER_SPEED };
  let wanted: Dir | null = null; // last direction pressed; applied at the next tile centre
  let moths: Moth[] = [];
  const trail: { x: number; y: number }[] = [];

  function resetPositions(level: number) {
    Object.assign(player, { x: spawn.x, y: spawn.y, dir: null, t: 0 });
    wanted = null;
    trail.length = 0;
    const speed = MOTH_SPEED * (1 + MOTH_SPEEDUP * (level - 1));
    const kinds: Moth['kind'][] = ['chaser', 'ambusher', 'wanderer'];
    moths = kinds.map((kind, i) => {
      const home = { x: MAZE_COLS - 2 + i * 2, y: MAZE_ROWS };
      return { kind, home, x: home.x, y: home.y, dir: null, t: 0, speed, waitUntil: time + 1 + i * NEST_STAGGER, scaredUntil: 0 };
    });
  }

  // Exact position for drawing: between the tile we left and the next one.
  const posOf = (m: Mover) => ({
    x: m.x + (m.dir === null ? 0 : DX[m.dir] * m.t),
    y: m.y + (m.dir === null ? 0 : DY[m.dir] * m.t),
  });

  // Advance a mover; `choose` is asked for a direction each time it reaches a
  // tile centre. Movement is tile to tile, so walls are just "can't choose that".
  function step(m: Mover, dt: number, choose: (m: Mover) => Dir | null) {
    let budget = m.speed * dt; // tiles to travel this frame
    while (budget > 0) {
      if (m.dir === null || m.t === 0) {
        m.dir = choose(m);
        if (m.dir === null) return;
      }
      const remaining = 1 - m.t;
      if (budget < remaining) {
        m.t += budget;
        return;
      }
      budget -= remaining;
      m.x += DX[m.dir];
      m.y += DY[m.dir];
      m.t = 0;
      onArrive(m);
    }
  }

  // Demo autopilot: never reverse unless cornered, step away from a nearby moth
  // that isn't scared, otherwise prefer a tile with a seed or lantern on it.
  // Simple on purpose — it only has to look like someone playing.
  function chooseDemo(m: Mover): Dir | null {
    const exits = ([0, 1, 2, 3] as Dir[]).filter((d) => isOpen(m.x + DX[d], m.y + DY[d]));
    const forward = m.dir === null ? exits : exits.filter((d) => d !== opposite(m.dir!));
    let options = forward.length ? forward : exits;
    const danger = moths.filter(
      (o) => time >= o.waitUntil && time >= o.scaredUntil && Math.abs(o.x - m.x) + Math.abs(o.y - m.y) <= 4,
    );
    if (danger.length) {
      const dist = (x: number, y: number, o: Moth) => Math.hypot(x - o.x, y - o.y);
      const safe = exits.filter((d) => danger.every((o) => dist(m.x + DX[d], m.y + DY[d], o) > dist(m.x, m.y, o)));
      if (safe.length) options = safe;
    }
    const tasty = options.filter((d) => seeds[m.y + DY[d]][m.x + DX[d]] || lanterns[m.y + DY[d]][m.x + DX[d]]);
    const pool = tasty.length ? tasty : options;
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  }

  function choosePlayer(m: Mover): Dir | null {
    if (state === 'demo') return chooseDemo(m);
    if (wanted !== null && isOpen(m.x + DX[wanted], m.y + DY[wanted])) return wanted;
    if (m.dir !== null && isOpen(m.x + DX[m.dir], m.y + DY[m.dir])) return m.dir;
    return null;
  }

  // Moths never reverse unless at a dead end. At each junction they take the
  // exit that brings them closest to their target tile.
  function chooseMoth(m: Moth): Dir | null {
    const exits = ([0, 1, 2, 3] as Dir[]).filter((d) => isOpen(m.x + DX[d], m.y + DY[d]));
    const forward = m.dir === null ? exits : exits.filter((d) => d !== opposite(m.dir!));
    const options = forward.length ? forward : exits;
    if (!options.length) return null;
    if (time < m.scaredUntil) {
      // Fleeing: take the exit that ends up farthest from the firefly, with a
      // little randomness so they don't all run the same way.
      if (Math.random() < 0.25) return options[Math.floor(Math.random() * options.length)];
      const away = (d: Dir) => Math.hypot(m.x + DX[d] - player.x, m.y + DY[d] - player.y);
      return options.reduce((best, d) => (away(d) > away(best) ? d : best));
    }
    if (m.kind === 'wanderer' || Math.random() < 0.1) return options[Math.floor(Math.random() * options.length)];
    let tx = player.x;
    let ty = player.y;
    if (m.kind === 'ambusher' && player.dir !== null) {
      tx += DX[player.dir] * 4; // aim where the firefly is heading, not where it is
      ty += DY[player.dir] * 4;
    }
    return options.reduce((best, d) =>
      Math.hypot(m.x + DX[d] - tx, m.y + DY[d] - ty) < Math.hypot(m.x + DX[best] - tx, m.y + DY[best] - ty) ? d : best,
    );
  }

  // ── Game state ─────────────────────────────────────────────────────────
  let state: State = 'title';
  let stateTime = 0;
  let score = 0;
  let lives = LIVES;
  let level = 1;
  let poofs: { x: number; y: number; t: number; label: string }[] = []; // burst + points where a moth was caught
  let chain = 0; // catches since the last lantern; sets the points for the next one
  let time = 0;
  let active = false; // true while the camera is on the TV and input is live
  let sinceDraw = 0;
  const touchOnly = window.matchMedia('(hover: none)').matches;

  function setState(s: State) {
    state = s;
    stateTime = 0;
  }

  function newGame() {
    score = 0;
    lives = LIVES;
    level = 1;
    poofs = [];
    chain = 0;
    buildMaze();
    resetPositions(level);
    setState('play');
  }

  function onArrive(m: Mover) {
    if (m !== player) return;
    if (seeds[m.y][m.x]) {
      seeds[m.y][m.x] = false;
      seedsLeft--;
      score += 10;
      if (seedsLeft === 0) {
        if (state === 'demo') startDemo(); // the demo just starts over on a fresh maze
        else setState('clear');
      }
    }
    if (lanterns[m.y][m.x]) {
      lanterns[m.y][m.x] = false;
      score += 50;
      scareMoths();
    }
  }

  // A lantern makes every moth that's out in the maze catchable for a while.
  // Moths still waiting in the nest aren't affected. Scared moths turn around on
  // the spot, so the player sees the tables turn.
  function scareMoths() {
    chain = 0;
    for (const m of moths) {
      if (time < m.waitUntil) continue;
      m.scaredUntil = time + SCARED_SECONDS;
      if (m.dir === null) continue;
      if (m.t > 0) {
        // Same mid-tile reversal as the player: swap which tile we're leaving.
        m.x += DX[m.dir];
        m.y += DY[m.dir];
        m.t = 1 - m.t;
      }
      m.dir = opposite(m.dir);
    }
  }

  // A caught moth goes back to the nest and waits there before coming out again.
  function catchMoth(m: Moth) {
    const q = posOf(m);
    const points = CATCH_POINTS * 2 ** chain++;
    score += points;
    poofs.push({ x: q.x, y: q.y, t: time, label: String(points) });
    Object.assign(m, { x: m.home.x, y: m.home.y, dir: null, t: 0, waitUntil: time + NEST_WAIT, scaredUntil: 0 });
  }

  function update(dt: number) {
    if (!plane.visible) return;
    dt = Math.min(dt, 0.1); // a very long frame (e.g. a stall) shouldn't teleport anything through walls
    time += dt;
    stateTime += dt;

    if (state === 'play' || state === 'demo') {
      // Reversing is allowed mid-tile (it feels unresponsive otherwise): swap
      // which tile we're "leaving" and flip the progress.
      if (wanted !== null && player.dir !== null && wanted === opposite(player.dir) && player.t > 0) {
        player.x += DX[player.dir];
        player.y += DY[player.dir];
        player.t = 1 - player.t;
        player.dir = wanted;
      }
      step(player, dt, choosePlayer);
      const p = posOf(player);
      trail.unshift(p);
      if (trail.length > 10) trail.pop();
      for (const m of moths) {
        if (time < m.waitUntil) continue; // nesting
        // Slowing a scared moth = giving it less time to move this frame.
        step(m, time < m.scaredUntil ? dt * SCARED_SPEED : dt, (x) => chooseMoth(x as Moth));
      }
      poofs = poofs.filter((f) => time - f.t < 0.9);
      for (const m of moths) {
        if (time < m.waitUntil) continue; // nesting moths are harmless
        const q = posOf(m);
        if (Math.hypot(q.x - p.x, q.y - p.y) >= 0.7) continue;
        if (time < m.scaredUntil) catchMoth(m);
        else if (state === 'demo') {
          resetPositions(level); // no lives in the demo; just put everyone back
          break;
        } else {
          lives--;
          setState(lives > 0 ? 'dead' : 'over');
          break;
        }
      }
    } else if (state === 'dead' && stateTime > 1.2) {
      resetPositions(level);
      setState('play');
    } else if (state === 'clear' && stateTime > 1.5) {
      level++;
      buildMaze();
      resetPositions(level);
      setState('play');
    }

    // While the camera isn't on the TV, it's a small thing in the corner of the
    // room: redraw at 30 fps instead of every frame. Each redraw re-uploads the
    // 320×240 canvas (300 KB) to the GPU.
    sinceDraw += dt;
    if (!active && sinceDraw < 1 / 30) return;
    sinceDraw = 0;
    draw();
    texture.needsUpdate = true; // re-upload the canvas this frame
  }

  function startDemo() {
    level = 1;
    poofs = [];
    chain = 0;
    buildMaze();
    resetPositions(level);
    setState('demo');
    plane.visible = true;
  }

  // ── Drawing ────────────────────────────────────────────────────────────
  const C = {
    bg: '#06110a',
    hedge: '#1c4a23',
    hedgeTop: '#2f6e35',
    seed: '#f4f1c9',
    lantern: '#ffb347',
    fly: '#d8ff6a',
    moth: '#c9b9a0',
    resting: '#7d7466',
    scared: '#8fd3ff',
    text: '#d8ffcf',
  };
  const px = (tx: number) => OX + tx * TILE;
  const py = (ty: number) => OY + ty * TILE;

  function glow(x: number, y: number, r: number, color: string, alpha: number) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'transparent');
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }

  function drawFirefly(cx: number, cy: number, scale = 1) {
    for (let i = trail.length - 1; i > 0; i--) {
      const t = trail[i];
      ctx.globalAlpha = 0.35 * (1 - i / trail.length);
      ctx.fillStyle = C.fly;
      ctx.fillRect(px(t.x) + TILE / 2 - 1, py(t.y) + TILE / 2 - 1, 2, 2);
    }
    ctx.globalAlpha = 1;
    glow(cx, cy, 14 * scale, C.fly, 0.35 + 0.15 * Math.sin(time * 8));
    ctx.fillStyle = C.fly;
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5 * scale, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawMoth(m: Moth) {
    const q = posOf(m);
    const cx = px(q.x) + TILE / 2;
    const resting = time < m.waitUntil;
    // Resting moths bob slowly with folded wings; they flash just before leaving.
    const cy = py(q.y) + TILE / 2 + (resting ? Math.sin(time * 3 + m.home.x) : 0);
    const flap = resting ? 0.45 : 0.6 + 0.4 * Math.abs(Math.sin(time * 14 + m.home.x));
    const leaving = resting && m.waitUntil - time < 1 && Math.floor(time * 8) % 2 === 0;
    // Scared moths turn pale blue, and blink back to normal in their last 1.5 s.
    const left = m.scaredUntil - time;
    const scared = left > 0 && !(left < 1.5 && Math.floor(time * 6) % 2 === 0);
    const col = scared ? C.scared : resting && !leaving ? C.resting : C.moth;
    ctx.fillStyle = col;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx, cy - 1);
      ctx.lineTo(cx + s * 7 * flap, cy - 5);
      ctx.lineTo(cx + s * 6 * flap, cy + 4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#5a4a38';
    ctx.fillRect(cx - 1, cy - 3, 2, 6); // body
  }

  function centeredText(text: string, y: number, size = 10, color = C.text) {
    ctx.font = `bold ${size}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, W / 2, y);
  }

  function draw() {
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    if (state === 'title') {
      const x = W / 2 + Math.sin(time * 1.3) * 60;
      const y = 95 + Math.sin(time * 2.1) * 18;
      trail.unshift({ x: (x - OX - 4) / TILE, y: (y - OY - 4) / TILE });
      if (trail.length > 10) trail.pop();
      drawFirefly(x, y, 1.6);
      if (Math.floor(time * 2) % 2) centeredText('PRESS ANY KEY · TAP', 160, 11);
      centeredText('ARROWS / WASD · SWIPE', 186, 9, '#7fae7a');
      centeredText('COLLECT THE LIGHT · LANTERNS LET YOU CATCH MOTHS', 202, 8, '#7fae7a');
      return finishCRT();
    }

    // Maze
    for (let y = 0; y < GH; y++)
      for (let x = 0; x < GW; x++) {
        if (wall[y][x]) {
          ctx.fillStyle = C.hedge;
          ctx.fillRect(px(x), py(y), TILE, TILE);
          if (!isOpen(x, y - 1) && y > 0) continue;
          ctx.fillStyle = C.hedgeTop; // lighter top edge where a hedge meets a path
          ctx.fillRect(px(x), py(y), TILE, 2);
        } else if (seeds[y][x]) {
          ctx.fillStyle = C.seed;
          ctx.fillRect(px(x) + TILE / 2 - 1, py(y) + TILE / 2 - 1, 2, 2);
        } else if (lanterns[y][x]) {
          glow(px(x) + TILE / 2, py(y) + TILE / 2, 12, C.lantern, 0.5 + 0.2 * Math.sin(time * 5));
          ctx.fillStyle = C.lantern;
          ctx.fillRect(px(x) + TILE / 2 - 2, py(y) + TILE / 2 - 2, 4, 4);
        }
      }

    // Nest: a faint outline around the middle room where moths wait.
    ctx.strokeStyle = 'rgba(201,185,160,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px(MAZE_COLS - 2) + 0.5, py(MAZE_ROWS - 1) + 0.5, TILE * 5 - 1, TILE * 3 - 1);
    for (const f of poofs) {
      const k = (time - f.t) / 0.9; // 0 → 1 over 0.9 s
      const fx = px(f.x) + TILE / 2;
      const fy = py(f.y) + TILE / 2;
      ctx.strokeStyle = `rgba(143,211,255,${Math.max(0, 1 - k * 2)})`;
      ctx.beginPath();
      ctx.arc(fx, fy, 3 + k * 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1 - k;
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = C.text;
      ctx.fillText(f.label, fx, fy - 6 - k * 6); // points float up and fade
      ctx.globalAlpha = 1;
    }
    for (const m of moths) drawMoth(m);
    const p = posOf(player);
    if (state !== 'dead' || Math.floor(stateTime * 10) % 2) drawFirefly(px(p.x) + TILE / 2, py(p.y) + TILE / 2);

    // HUD
    ctx.font = 'bold 10px monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = C.text;
    ctx.fillText(state === 'demo' ? 'DEMO' : `SCORE ${String(score).padStart(6, '0')}`, 6, 8);
    ctx.textAlign = 'center';
    ctx.fillText(`LV ${level}`, W / 2, 8);
    for (let i = 0; i < lives; i++) {
      ctx.fillStyle = C.fly;
      ctx.beginPath();
      ctx.arc(W - 10 - i * 10, 8, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    if (state === 'demo') {
      // A band across the middle, big enough to read from across the room.
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, H / 2 - 16, W, 32);
      if (time % 1.2 < 0.85) centeredText(touchOnly ? 'TAP TO PLAY' : 'CLICK TO PLAY', H / 2, 18, C.fly);
    } else if (state === 'paused') {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, W, H);
      if (active) centeredText('PAUSED · PRESS ANY KEY', H / 2, 11);
      else {
        // Seen from across the room: same readable band as the demo.
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(0, H / 2 - 16, W, 32);
        if (time % 1.2 < 0.85) centeredText(touchOnly ? 'TAP TO RESUME' : 'CLICK TO RESUME', H / 2, 18, C.fly);
      }
    } else if (state === 'clear') centeredText('ALL LIGHT COLLECTED', H / 2, 12);
    else if (state === 'over') {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, W, H);
      centeredText('GAME OVER', H / 2 - 10, 14);
      centeredText(`SCORE ${score}`, H / 2 + 8, 10);
      if (stateTime > 1 && Math.floor(time * 2) % 2) centeredText('PRESS ANY KEY · TAP', H / 2 + 30, 9);
    }
    finishCRT();
  }

  // Old-TV look: dark scanlines on every other row, then a vignette.
  function finishCRT() {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    for (let y = 0; y < H; y += 2) ctx.fillRect(0, y, W, 1);
    const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.65);
    v.addColorStop(0, 'transparent');
    v.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  // ── Input ──────────────────────────────────────────────────────────────
  const KEYS: Record<string, Dir> = {
    ArrowUp: 0, KeyW: 0, ArrowRight: 1, KeyD: 1, ArrowDown: 2, KeyS: 2, ArrowLeft: 3, KeyA: 3,
  };

  function press(dir: Dir | null) {
    if (state === 'title' || (state === 'over' && stateTime > 1)) return newGame();
    if (state === 'paused') return setState('play');
    if (dir !== null) wanted = dir;
  }

  const onKey = (e: KeyboardEvent) => {
    if (!plane.visible || e.key === 'Escape') return; // Escape belongs to room.ts
    const dir = KEYS[e.code];
    if (dir !== undefined || e.code === 'Space') e.preventDefault(); // don't scroll the page
    press(dir ?? null);
  };

  // Swipe: direction of the larger movement between press and release.
  // A tap (tiny movement) counts as "any key" for starting/unpausing.
  const touch = { x: 0, y: 0 };
  const onDown = (e: PointerEvent) => {
    touch.x = e.clientX;
    touch.y = e.clientY;
  };
  const onUp = (e: PointerEvent) => {
    if (!plane.visible) return;
    const dx = e.clientX - touch.x;
    const dy = e.clientY - touch.y;
    if (Math.hypot(dx, dy) < 20) return press(null);
    press(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0);
  };

  return {
    showDemo: startDemo,
    activate() {
      active = true;
      plane.visible = true;
      if (state === 'demo') setState('title');
      window.addEventListener('keydown', onKey);
      input.addEventListener('pointerdown', onDown);
      input.addEventListener('pointerup', onUp);
    },
    deactivate() {
      active = false;
      if (state === 'play' || state === 'dead' || state === 'clear') setState('paused');
      else if (state === 'title' || state === 'over') startDemo(); // nothing to keep: back to the demo
      window.removeEventListener('keydown', onKey);
      input.removeEventListener('pointerdown', onDown);
      input.removeEventListener('pointerup', onUp);
      draw();
      texture.needsUpdate = true; // leave the paused frame on the TV
    },
    update,
    dispose() {
      window.removeEventListener('keydown', onKey);
      input.removeEventListener('pointerdown', onDown);
      input.removeEventListener('pointerup', onUp);
      tv.remove(plane);
      plane.geometry.dispose();
      (plane.material as THREE.Material).dispose();
      texture.dispose();
    },
  };
}

export type Arcade = ReturnType<typeof createArcade>;
