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

1. a password-protected local admin console, opened directly from Softuchive,
2. unpublishing or republishing a VOD on YouTube and the archive (Twitch is preserved),
3. toggling per-VOD Spotify muted notice,
4. toggling per-VOD chat replay availability.

The repo also ships **Softuchive**, a compact Electron controller for the local pipeline. It controls manual
polls, the scheduled task, OBS-close polling, archive storage, upload throttling, pause/resume, skip, recovery,
queue progress, and local logs without moving those responsibilities into a second backend.

Softuchive 2.2 keeps the upload queue on its first screen, with settings and activity one tab away.
Hidden or minimized windows skip periodic view refreshes, and disabled OBS monitoring does not launch process checks.
Enabled OBS-close monitoring continues while the app is running; closing the app stops that monitor.
The pipeline and ffmpeg run below normal priority where the operating system allows it.

Phone layouts provide direct archive navigation, search with optional filters, and a compact video/chat
viewer designed around touch controls and iOS safe areas. Missing VOD thumbnails use soft's voxel image.
See [the 2.2 release notes](docs/release-2.2.md) for recovery behavior, validation, and known limits.

## Reliable local archiving

- Completed recordings are matched to `softxu`. An unmatched file cannot block newer streams, temporary
  probe failures are retried, and the currently live Twitch stream is deferred until it finishes.
- ffmpeg copies the original video and first audio track without re-encoding. A completed preparation
  copy is reused when its saved identity still matches, so resume does not need another full disk copy.
- YouTube uploads use bounded resumable chunks and private local checkpoints. After interruption, the
  worker asks YouTube which bytes it accepted and continues there. An uncertain final response is checked
  against the existing session. If completion remains uncertain, the worker retains the session and
  requires verification before creating another upload.
- Returned video IDs are saved before metadata finalization. The archive index is saved before a recording
  is marked complete, and pending site publication is retried even when there are no new recordings.
- Chat export failures leave a retryable backfill while video preservation continues.
- Pipeline and admin updates share a cross-process transaction store, preserving concurrent flags, parts,
  and newly archived videos. Interrupted locks are recoverable without admitting two archive workers.

Original recordings are retained. Prepared copies and upload checkpoints remain available while an upload
is interrupted; preserve `scripts/.tmp` and `scripts/.state` (or your configured locations) for recovery.
Reuse verifies saved file identity and timestamps without hashing the whole recording on each retry.
Uploads still use disk and network bandwidth; the app's speed limit lets you reserve bandwidth for streaming.

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

4. Set admin password locally in `.env.local` (gitignored):

```ini
ADMIN_PANEL_PASSWORD=<your-private-admin-password>
```

5. Configure your local `.env.local` values (`TWITCH_CHANNEL_LOGIN=softxu`, Twitch app credentials,
   recording paths, site URL, etc.). The current archive worker uses Twitch app authentication;
   a Twitch user OAuth token is not required for these archive/admin flows.

6. Install local pipeline scheduled task (every 15 minutes):

```bash
npm run archive:task:install
```

7. Optional: install local admin API auto-start hook at login:

```bash
npm run admin:task:install
```

If you prefer on-demand only (no login auto-start), remove the hook:

```bash
npm run admin:task:remove
```

## Manual archive run

This command uses the configured Twitch, YouTube, and Git services and can upload recordings and publish
archive data. Use the regression tests below for checks without running the real archive pipeline.

```bash
npm run archive:run
```

Run the site locally with Vite:

```bash
npm start
```

Run the regression tests and create the production site:

```bash
npm test
npm run build
```

Start/stop local admin API on demand:

```bash
npm run admin:api:wake
npm run admin:api:stop
```

Enable the explicit Start local bridge button on the public admin page (optional, one-time):

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

The build prepares the pinned Electron runtime and installs the desktop app's production dependencies.
The unsigned Windows executable is written to `softuchive-dist/`. It requires the configured `soft-site`
checkout, its installed dependencies, credentials, and media tools; the archive pipeline is not bundled
into the executable. Keep it within the checkout's folder tree, or set `SOFTUCHIVE_REPO_ROOT` when launching
from another location. Its icon
source is `desktop/softuchive/assets/icon.png`; regenerate the Windows `.ico` file after replacing that PNG:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/generate_softuchive_icon.ps1
```

Uploads shows the active transfer and queue; Settings contains scheduling, storage and speed limits; Activity contains
recent events and recovery tools. The More actions menu opens logs, the recording folder, and admin.
Open admin starts the local bridge on demand, verifies it is ready, and opens
the console. Run `npm run build` after website changes so the local console serves the current UI.

For a paused run, choose **Resume**. After a stopped or failed run, choose **Check recordings**. If a stale
processing marker keeps a recording out of the queue, open **Activity → Recover an interrupted archive**,
then click **Restart interrupted run** and **Confirm restart**. Recovery refuses an active run and clears
processing/paused markers while retaining completed entries and the separate upload-session/cache files.
A missing cache or uncertain final upload still requires verification; this action cannot resolve it.
**Pause** stops at the next safe point. **Skip VOD** excludes that recording version from future automatic
attempts, so use Pause when you intend to continue later.

## Files produced by automation

These are the default locations; `PIPELINE_STATE_PATH` and `PIPELINE_TMP_DIR` can move pipeline recovery files.

- VOD index: `public/data/vods.json`
- Chat replay per VOD: `public/data/comments/<twitchVodId>.json`
- Emotes per VOD: `public/data/emotes/<twitchVodId>.json`
- Static chat badges: `public/data/badges.json`
- Pipeline state: `scripts/.state/pipeline-state.json`
- Pending pipeline publication: `scripts/.state/pipeline-state.json.publish-pending.json`
- Pending admin VOD publication changes: `scripts/.state/admin-publication.json`
- Private resumable upload checkpoints: `scripts/.state/upload-sessions/*.json`
- Prepared stream-copy uploads and manifests: `scripts/.tmp/youtube-upload-audio1/`

## YouTube metadata template

Each upload now sets and syncs:

1. title format: `<stream title>`,
2. short chat replay link format: `https://softu.one/<twitchVodId>`,
3. description format:

```text
streamed Feb. 26, 2024 ✦ Chat replay: https://softu.one/<twitchVodId>
Watch live on Twitch! https://twitch.tv/softxu

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

## Admin console

1. In Softuchive, choose **Open admin**. Alternatively run `npm run admin:api:wake` and open
   `http://127.0.0.1:49731/console/admin` (use your configured port if different).
2. Sign in with the password from your local `.env.local`.
3. Search or filter the archive, select a VOD, and use the controls to:
   - unpublish a VOD on YouTube + archive listing (Twitch VOD is preserved),
   - unpublish a single YouTube VOD part while keeping the VOD published (remaining parts are renumbered),
   - republish a previously unpublished YouTube VOD part on both YouTube and the archive site,
   - republish an unpublished VOD on YouTube and the archive site,
   - hide the VOD from archive listings,
   - toggle Spotify-muted notice,
   - toggle chat replay availability.

Twitch note: Helix provides delete/list operations for videos, but no official per-VOD unpublish toggle. This admin flow does not delete Twitch VODs.

The admin password is never committed to GitHub; it is read from local `.env.local`. New login sessions
use tab-scoped storage. YouTube publication changes require YouTube credentials, not Twitch authorization.
The local admin API process is no longer watchdog-managed; it starts via a one-shot launcher and can auto-stop after inactivity (`ADMIN_API_IDLE_TIMEOUT_MINUTES` in `.env.local`, default `30`).
Default local admin API port is `49731` (`ADMIN_API_PORT` in `.env.local`).
The public site's footer copyright label opens `/admin` with one click.
When the `soft-archive-admin://` protocol is installed, its **Start local bridge** button can wake the API.
Use the local console if your browser blocks access from the public HTTPS site to localhost; both the UI
and API then share the same origin. Additional public origins must be explicitly listed in
`ADMIN_ALLOWED_ORIGINS` in `.env.local` (comma-separated). The default listener is loopback only.

The browser does not replay admin requests after an uncertain network response. Refresh the VOD before
retrying, because YouTube or the local archive may already have accepted the change. If a Git push fails,
saved VOD publication changes remain queued locally and are retried with the next admin VOD change.
Admin metadata edits and pipeline saves are serialized across processes and merge independent changes.
Signing out revokes that session, and expired sessions return to sign-in without discarding an open design draft.
The local design editor uses fallback fonts when external font services are unavailable.

## Deploy

GitHub Pages deploy workflow:
`.github/workflows/deploy-pages.yml`

The frontend uses Vite and Node 24 in CI, with regression tests before deployment. Production output remains in `build/`, so the GitHub Pages artifact
and archive pipeline paths are unchanged.

In GitHub repo settings:
`Settings -> Pages -> Source: GitHub Actions`

## Important policy note

This setup can upload your local recording audio to YouTube, but it does not bypass copyright rules.  
If uploaded audio includes content you do not have rights to publish (for example Spotify tracks), YouTube can still claim, block, or strike videos.
