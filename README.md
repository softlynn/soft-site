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

The repo also ships **Softuchive**, a lightweight Electron dashboard for the local pipeline. It controls manual
polls, the scheduled task, OBS-close polling, archive storage, upload throttling, pause/resume, skip, recovery,
queue progress, and local logs without moving those responsibilities into a second backend.

## One-time setup

1. Install Node.js 22.22 or newer, then install dependencies:

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

8. Optional: install local admin API auto-start hook at login:

```bash
npm run admin:task:install
```

If you prefer on-demand only (no login auto-start), remove the hook:

```bash
npm run admin:task:remove
```

## Manual run (for testing)

```bash
npm run archive:run
```

Run the site locally with Vite:

```bash
npm start
```

Run the state tests and create the production site:

```bash
npm test
npm run build
```

Start/stop local admin API on demand:

```bash
npm run admin:api:wake
npm run admin:api:stop
```

Enable auto-wake from the admin page (recommended on Windows, one-time):

```bash
npm run admin:protocol:install
```

Remove the protocol handler:

```bash
npm run admin:protocol:remove
```

You can also double-click:

- `start-admin-api.cmd`
- `stop-admin-api.cmd`

## Scheduled task commands

- Install: `npm run archive:task:install`
- Remove: `npm run archive:task:remove`
- Admin API install: `npm run admin:task:install`
- Admin API remove: `npm run admin:task:remove`

## Softuchive

Run Softuchive from source:

```bash
npm run softuchive:start
```

Build the Windows portable app:

```bash
npm run softuchive:dist
```

The portable executable is written to `softuchive-dist/`. Softuchive locates the surrounding `soft-site`
checkout automatically, or it can use `SOFTUCHIVE_REPO_ROOT` when launched from another location. Its icon
source is `desktop/softuchive/assets/icon.png`; regenerate the Windows `.ico` file after replacing that PNG:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/generate_softuchive_icon.ps1
```

## Files produced by automation

- VOD index: `public/data/vods.json`
- Chat replay per VOD: `public/data/comments/<twitchVodId>.json`
- Emotes per VOD: `public/data/emotes/<twitchVodId>.json`
- Static chat badges: `public/data/badges.json`
- Pipeline state: `scripts/.state/pipeline-state.json`

## YouTube metadata template

Each upload now sets and syncs:

1. title format: `<stream title>`,
2. short chat replay link format: `https://softu.one/<twitchVodId>`,
3. description format:

```text
streamed Feb. 26, 2024 ✦ Chat replay: https://softu.one/<twitchVodId>
Watch live on Twitch! https://twitch.tv/softuwo

Categories:
<category chapter lines>
```

4. category via `YOUTUBE_CATEGORY_ID` (default `20`, Gaming).

To resync the template onto existing YouTube uploads without processing recordings, run:

```bash
npm run archive:sync-metadata
```

The normal archive poll checks YouTube publish visibility at most every `YOUTUBE_VISIBILITY_SYNC_INTERVAL_MINUTES`
minutes (default `180`). Manual visibility sync still runs immediately:

```bash
npm run archive:sync-youtube-visibility
```

## Frontend mode

`REACT_APP_USE_STATIC_ARCHIVE=true` is enabled, so the site serves archive data from `public/data/*` and does not require a custom API endpoint.

## Hidden admin panel use

1. Open the site and click `soft Archive` **3 times** quickly.
2. Enter the admin password in the prompt.
3. After unlock, `/admin` lets you:
   - unpublish a VOD on YouTube + archive listing (Twitch VOD is preserved),
   - unpublish a single YouTube VOD part while keeping the VOD published (remaining parts are renumbered),
   - republish a previously unpublished YouTube VOD part on both YouTube and the archive site,
   - republish an unpublished VOD on YouTube and the archive site,
   - hide the VOD from archive listings,
   - toggle Spotify-muted notice,
   - toggle chat replay availability.

Twitch note: Helix provides delete/list operations for videos, but no official per-VOD unpublish toggle. This admin flow does not delete Twitch VODs.

The admin password is never committed to GitHub; it is read from local `.env.local`.
If a Twitch user token is missing when you unpublish, the admin API now starts an automatic one-time Twitch device authorization flow and stores the token locally.
Optional advanced fallback: set `TWITCH_USER_ACCESS_TOKEN` / `TWITCH_USER_REFRESH_TOKEN` in `.env.local` to seed the token file automatically.
No Twitch redirect URI setup is required for this flow.
The local admin API process is no longer watchdog-managed; it starts via a one-shot launcher and can auto-stop after inactivity (`ADMIN_API_IDLE_TIMEOUT_MINUTES` in `.env.local`, default `30`).
Default local admin API port is `49731` (`ADMIN_API_PORT` in `.env.local`).
When `soft-archive-admin://` protocol is installed, the admin page can wake the local API automatically if it is not running.
If admin login from GitHub Pages is blocked by CORS on your machine, add your site origin to `ADMIN_ALLOWED_ORIGINS` in `.env.local` (comma-separated).

## Deploy

GitHub Pages deploy workflow:
`.github/workflows/deploy-pages.yml`

The frontend uses Vite and Node 24 in CI. Production output remains in `build/`, so the GitHub Pages artifact
and archive pipeline paths are unchanged.

In GitHub repo settings:
`Settings -> Pages -> Source: GitHub Actions`

## Important policy note

This setup can upload your local recording audio to YouTube, but it does not bypass copyright rules.  
If uploaded audio includes content you do not have rights to publish (for example Spotify tracks), YouTube can still claim, block, or strike videos.
