# Softu Reactions API (Cloudflare Worker + D1)

First-party backend for global VOD reactions (`like` / `dislike`) used by `softu.one`.

This Worker is the only reactions backend. The frontend (`src/vods/vodReactionsApi.js`) reads and writes `REACT_APP_REACTIONS_API_BASE` (default `https://api.softu.one/v1/reactions`) and nothing else: while the Worker is unreachable it shows cached or zero counts, keeps each visitor's vote in their browser's localStorage, and reverts a vote whose save fails instead of sending it anywhere else.

## Endpoints

- `GET /health`
- `GET /v1/reactions/_health`
- `GET /v1/reactions/:vodId`
- `POST /v1/reactions/:vodId`

POST body:

```json
{
  "previousVote": "like",
  "nextVote": null
}
```

## Quick Setup

```bash
npx wrangler whoami
# if not logged in:
npx wrangler login

npx wrangler d1 create softu-reactions
# copy the returned database_id into cloudflare/reactions-api/wrangler.jsonc

npx wrangler d1 execute softu-reactions --remote --file=cloudflare/reactions-api/schema.sql
npx wrangler deploy --config cloudflare/reactions-api/wrangler.jsonc
```

Then attach `api.softu.one` as a custom domain to the Worker in Cloudflare Dashboard.
