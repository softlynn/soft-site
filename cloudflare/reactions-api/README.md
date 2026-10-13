# Softu Reactions API (Cloudflare Worker + D1)

First-party public backend for `softu.one`:

- global VOD reactions (`like` / `dislike`), voted anonymously by visitors,
- live upload progress reported by the local archive pipeline and shown as placeholders on the site.

Everything stored here is public data. The Worker never stores request bodies, headers, or client
addresses; the rate limiter only keys on the client address in memory at the edge.

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/health`, `/v1/reactions/_health`, `/v1/uploads/_health` | none | Checks the D1 binding. |
| `GET` | `/v1/reactions/:vodId` | none | `{ vodId, likes, dislikes, updatedAt }`. |
| `POST` | `/v1/reactions/:vodId` | none, rate limited | Body `{ "previousVote": "like" \| "dislike" \| null, "nextVote": ... }`. |
| `GET` | `/v1/uploads/active` | none | Active upload sessions; served from a 2.5 s in-memory cache. Never writes. |
| `POST` | `/v1/uploads/report` | `X-Upload-Status-Secret` | Upsert from the pipeline; also prunes expired sessions. |

VOD ids must match `[A-Za-z0-9_-]{1,128}`; JSON bodies are limited to 16 KB. Client errors return
`{ "error": "..." }` with a 4xx status. Internal failures return a generic 500 and are logged only in the
Worker's logs.

## Quick setup

```bash
npx wrangler whoami
# if not logged in:
npx wrangler login

npx wrangler d1 create softu-reactions
# copy the returned database_id into cloudflare/reactions-api/wrangler.jsonc

npx wrangler d1 execute softu-reactions --remote --file=cloudflare/reactions-api/schema.sql

# Shared secret used by the local pipeline (UPLOAD_STATUS_API_SECRET in .env.local).
npx wrangler secret put UPLOAD_STATUS_WRITE_SECRET --config cloudflare/reactions-api/wrangler.jsonc

npx wrangler deploy --config cloudflare/reactions-api/wrangler.jsonc
```

Then attach `api.softu.one` as a custom domain to the Worker in the Cloudflare dashboard, or keep using
the `workers.dev` address configured in `.env`.

## Rate limiting

`wrangler.jsonc` declares a [Workers rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
named `REACTION_WRITE_LIMITER` (30 anonymous writes per client address per minute). It applies to
reaction votes and to upload reports with a wrong secret. Reads and correctly authenticated pipeline
reports are never throttled. If your wrangler version does not accept the `ratelimits` key, remove that
block: the Worker detects the missing binding and simply stops limiting.

## Tests

The Worker's SQL runs against Node's built-in SQLite in `src/uploads.test.mjs`, as part of `npm test`.
