// Leaderboard API for the two games in Mandeep's room (darts, maze).
//
//   POST /score        { game, name, score }  → 201 saved | 4xx with a reason
//   GET  /leaderboard  → { updatedAt, nextUpdateAt, darts: Entry[], maze: Entry[] }
//
// The boards are published, not live: a cron trigger (wrangler.jsonc) rebuilds
// them every 8 hours into a one-row `snapshot` table, and GET just returns that
// row. So a visit costs one row read, and the board changes on a fixed
// schedule everywhere. The site shows a player's own new score immediately on
// their screen; everyone else sees it after the next rebuild.
//
// Scores come from the browser, so they can be faked by anyone determined.
// The checks below stop casual abuse: three capital letters only, darts scores
// must be totals three real darts can make, a sane maze ceiling, a short
// blocklist, and 20 submissions per hour per visitor.

export interface Env {
  DB: D1Database;
  ALLOWED_ORIGINS: string;
  IP_SALT?: string;
}

interface Entry {
  name: string;
  score: number;
}

const TOP = 10;
const UPDATE_HOURS = 8;
const PER_HOUR_LIMIT = 20;
const MAZE_MAX = 1_000_000;

// Totals three darts can make. One dart: 0 (miss), 1–20 single/double/treble,
// 25 (outer bull), 50 (bull). Some totals under 180 are impossible
// (179, 178, 176, 175, 173, 172, 169, 166, 163), so a "179" was not thrown.
const DART_VALUES = (() => {
  const one = new Set<number>([0, 25, 50]);
  for (let n = 1; n <= 20; n++) [n, 2 * n, 3 * n].forEach((v) => one.add(v));
  const totals = new Set<number>();
  for (const a of one) for (const b of one) for (const c of one) totals.add(a + b + c);
  return totals;
})();

// Initials that shouldn't appear on someone's portfolio. Short on purpose.
const BLOCKED = new Set(['ASS', 'FUK', 'FUC', 'FCK', 'SEX', 'KKK', 'NIG', 'FAG', 'CUM', 'DIK', 'TIT', 'XXX', 'WTF', 'GAY', 'KYS']);

function validate(body: unknown): { game: 'darts' | 'maze'; name: string; score: number } | string {
  if (!body || typeof body !== 'object') return 'Expected a JSON object';
  const { game, name, score } = body as Record<string, unknown>;
  if (game !== 'darts' && game !== 'maze') return 'Unknown game';
  if (typeof name !== 'string' || !/^[A-Z]{3}$/.test(name)) return 'Name must be 3 letters A–Z';
  if (BLOCKED.has(name)) return 'Please choose other initials';
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0) return 'Score must be a whole number';
  if (game === 'darts' && !DART_VALUES.has(score)) return 'Not a possible 3-dart total';
  if (game === 'maze' && score > MAZE_MAX) return 'Score out of range';
  return { game, name, score };
}

// ── CORS: only the portfolio (and local dev) may call this from a browser ──
function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  return allowed.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' }
    : { Vary: 'Origin' };
}

function json(data: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

async function ipHash(req: Request, env: Env) {
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const bytes = new TextEncoder().encode(`${env.IP_SALT ?? 'mandeep-room'}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Rebuild the published boards (cron, or first read if none exists yet) ──
async function rebuild(env: Env) {
  // Best score per initials, highest first; ties go to whoever got there first.
  const top = (game: string) =>
    env.DB.prepare(
      `SELECT name, MAX(score) AS score, MIN(created_at) AS first
         FROM scores WHERE game = ?1
        GROUP BY name ORDER BY score DESC, first ASC LIMIT ?2`,
    )
      .bind(game, TOP)
      .all<Entry & { first: string }>();
  const [darts, maze] = await Promise.all([top('darts'), top('maze')]);
  const strip = (rows: (Entry & { first: string })[]) => rows.map(({ name, score }) => ({ name, score }));
  const data = JSON.stringify({ darts: strip(darts.results), maze: strip(maze.results) });
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO snapshot (id, data, updated_at) VALUES (1, ?1, ?2)
     ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  )
    .bind(data, updatedAt)
    .run();
  return { data, updatedAt };
}

function nextUpdate(from: Date) {
  const next = new Date(from);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours((Math.floor(from.getUTCHours() / UPDATE_HOURS) + 1) * UPDATE_HOURS);
  return next.toISOString();
}

export default {
  async fetch(req, env): Promise<Response> {
    const cors = corsHeaders(req, env);
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (req.method === 'GET' && pathname === '/leaderboard') {
      let row = await env.DB.prepare('SELECT data, updated_at AS updatedAt FROM snapshot WHERE id = 1').first<{ data: string; updatedAt: string }>();
      if (!row) row = await rebuild(env); // first ever request, before the first cron run
      const boards = JSON.parse(row.data);
      // Browsers may reuse it for 10 minutes; it only changes every 8 hours.
      return json({ updatedAt: row.updatedAt, nextUpdateAt: nextUpdate(new Date()), ...boards }, 200, { ...cors, 'Cache-Control': 'public, max-age=600' });
    }

    if (req.method === 'POST' && pathname === '/score') {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'Expected JSON' }, 400, cors);
      }
      const v = validate(body);
      if (typeof v === 'string') return json({ error: v }, 400, cors);

      const hash = await ipHash(req, env);
      const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM scores WHERE ip_hash = ?1 AND created_at > datetime('now', '-1 hour')`)
        .bind(hash)
        .first<{ n: number }>();
      if ((recent?.n ?? 0) >= PER_HOUR_LIMIT) return json({ error: 'Too many scores this hour' }, 429, cors);

      await env.DB.prepare('INSERT INTO scores (game, name, score, ip_hash) VALUES (?1, ?2, ?3, ?4)').bind(v.game, v.name, v.score, hash).run();
      return json({ ok: true, nextUpdateAt: nextUpdate(new Date()) }, 201, cors);
    }

    return json({ error: 'Not found' }, 404, cors);
  },

  // Cron trigger (wrangler.jsonc): publish fresh boards every 8 hours.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(rebuild(env));
  },
} satisfies ExportedHandler<Env>;
