# Softu Reactions API (Cloudflare Worker + D1)

First-party backend for global VOD reactions (`like` / `dislike`) used by `softu.one`.

The frontend is already configured to prefer `https://api.softu.one/v1/reactions` and fall back to CounterAPI until this Worker is live.

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
