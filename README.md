# soft Archive Site

Archive frontend rebranded for `soft`, based on OP Archives.

The frontend behavior and VOD/chat model are kept compatible with the original OP archive design.  
This repo now includes a **local Windows automation pipeline** for:

1. detecting finished OBS recordings,
2. matching them to Twitch VODs,
3. uploading the recording to YouTube,
4. exporting Twitch chat replay and static emote data (7TV/BTTV/FFZ + embedded third-party emotes),
5. updating `public/data/vods.json`, `public/data/comments/*.json`, and `public/data/emotes/*.json`,
6. pushing updates to `main` for GitHub Pages deployment.

It also includes a **local admin bridge** for:

1. hidden admin panel unlock from the site (triple-click `soft Archive` + password prompt),
2. unpublishing a VOD on YouTube + Twitch,
3. toggling per-VOD Spotify muted notice,
4. toggling per-VOD chat replay availability.

## One-time setup

1. Install dependencies:

```bash
npm ci --include=dev
```

2. Ensure local automation config exists at `.env.local` (gitignored).  
   Start from `.env.local.example` if needed.

3. Generate YouTube OAuth token (opens browser once):

```bash
npm run youtube:auth
```

Token is saved to:
`./secrets/youtube_token.json`

4. Generate Twitch user OAuth token (opens browser once):

```bash
npm run twitch:auth
```

Token is saved to:
`./secrets/twitch_user_token.json`

5. Set admin password locally in `.env.local` (gitignored):

```ini
ADMIN_PANEL_PASSWORD=<your-private-admin-password>
```

6. Configure your local `.env.local` values (`TWITCH_CHANNEL_LOGIN`, paths, site URL, etc.).

7. Install local pipeline scheduled task (every 15 minutes):

```bash
npm run archive:task:install
```

8. Install local admin API task (starts at login and immediately):

```bash
npm run admin:task:install
```

## Manual run (for testing)

```bash
npm run archive:run
```

## Scheduled task commands

- Install: `npm run archive:task:install`
- Remove: `npm run archive:task:remove`
- Admin API install: `npm run admin:task:install`
- Admin API remove: `npm run admin:task:remove`

## Files produced by automation

- VOD index: `public/data/vods.json`
- Chat replay per VOD: `public/data/comments/<twitchVodId>.json`
- Emotes per VOD: `public/data/emotes/<twitchVodId>.json`
- Pipeline state: `scripts/.state/pipeline-state.json`

## YouTube metadata template

Each upload now sets and syncs:

1. title format: `<stream title> - <YYYY-MM-DD> - Part X` (part suffix only when multiple parts exist),
2. clickable `Chat Replay` link to the GitHub Pages VOD route,
3. clickable `Original VOD` Twitch link,
4. category via `YOUTUBE_CATEGORY_ID` (default `20`, Gaming),
5. part links in description when a VOD has multiple YouTube parts.

## Frontend mode

`REACT_APP_USE_STATIC_ARCHIVE=true` is enabled, so the site serves archive data from `public/data/*` and does not require a custom API endpoint.

## Hidden admin panel use

1. Open the site and click `soft Archive` **3 times** quickly.
2. Enter the admin password in the prompt.
3. After unlock, `/admin` lets you:
   - unpublish a VOD on YouTube and Twitch,
   - hide the VOD from archive listings,
   - toggle Spotify-muted notice,
   - toggle chat replay availability.

The admin password is never committed to GitHub; it is read from local `.env.local`.
If a Twitch user token is missing when you unpublish, the admin API now starts an automatic one-time Twitch OAuth browser flow and stores the token locally.
Optional advanced fallback: set `TWITCH_USER_ACCESS_TOKEN` / `TWITCH_USER_REFRESH_TOKEN` in `.env.local` to seed the token file automatically.
If Twitch returns `redirect_mismatch`, set `TWITCH_AUTH_REDIRECT_URI` in `.env.local` to one of the exact redirect URLs registered in your Twitch app.
If admin login from GitHub Pages is blocked by CORS on your machine, add your site origin to `ADMIN_ALLOWED_ORIGINS` in `.env.local` (comma-separated).

## Deploy

GitHub Pages deploy workflow:
`.github/workflows/deploy-pages.yml`

In GitHub repo settings:
`Settings -> Pages -> Source: GitHub Actions`

## Important policy note

This setup can upload your local recording audio to YouTube, but it does not bypass copyright rules.  
If uploaded audio includes content you do not have rights to publish (for example Spotify tracks), YouTube can still claim, block, or strike videos.
