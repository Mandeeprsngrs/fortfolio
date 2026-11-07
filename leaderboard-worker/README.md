# Leaderboard Worker

The API behind the two leaderboards in the room (darts, maze). A Cloudflare
Worker with a D1 database (SQLite). Free tier.

- `POST /score` `{ "game": "darts" | "maze", "name": "ABC", "score": 140 }` saves a score
  after checking it (3 letters A–Z, a darts total that three darts can make,
  a maze score ≤ 1,000,000, a short blocklist, 20 submissions/hour per visitor).
- `GET /leaderboard` returns the published top 10 for each game.
- A cron trigger republishes the boards every 8 hours (00:00, 08:00, 16:00 UTC).
  A player sees their own new score immediately (the site keeps it locally);
  everyone else sees it after the next republish.

## First deploy (once, about 5 minutes)

From this folder (`site/leaderboard-worker`):

```bash
npm install
npx wrangler login                              # opens the browser; log in to Cloudflare
npx wrangler d1 create mandeep-leaderboard      # prints a database_id
#   → paste that id into wrangler.jsonc, replacing REPLACE_WITH_DATABASE_ID
npm run db:init:remote                          # creates the tables
npx wrangler secret put IP_SALT                 # paste any long random string
npm run deploy                                  # prints https://mandeep-leaderboard.<you>.workers.dev
```

Then put that URL in `site/src/scripts/leaderboard.ts`:

```ts
export const LEADERBOARD_API = 'https://mandeep-leaderboard.<you>.workers.dev';
```

…and commit + push the site as usual. Until it's set, the boards show "Coming soon".

## Day to day

- See scores: `npx wrangler d1 execute mandeep-leaderboard --remote --command "SELECT * FROM scores ORDER BY id DESC LIMIT 20"`
- Remove one: `... --command "DELETE FROM scores WHERE id = 123"` (it disappears at the next republish)
- Republish now instead of waiting: Cloudflare dashboard → Workers → mandeep-leaderboard → Settings → Triggers → run the cron, or redeploy.

## Local testing

```bash
npm run db:init:local
npx wrangler dev --test-scheduled               # http://localhost:8787
curl "http://localhost:8787/__scheduled?cron=0+*/8+*+*+*"   # simulate the 8-hour republish
```

Open the site with `?lbapi=http://localhost:8787` added to its URL to use the local API.
