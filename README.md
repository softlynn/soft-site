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

## Current configured accounts

- GitHub repo: `https://github.com/softlynn/soft-site`
- Twitch channel: `softu1`
- YouTube channel link: `https://www.youtube.com/channel/UCSbqIDbEWTHlD0xVuRJk_QA`
- Twitter/X: `https://x.com/lx_hyze`
- Discord: `https://discord.com/invite/33JbkQ5R`

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
`C:/Users/Alex2/Documents/soft-site/secrets/youtube_token.json`

4. Install local scheduled task (every 15 minutes):

```bash
npm run archive:task:install
```

## Manual run (for testing)

```bash
npm run archive:run
```

## Scheduled task commands

- Install: `npm run archive:task:install`
- Remove: `npm run archive:task:remove`

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

## Deploy

GitHub Pages deploy workflow:
`.github/workflows/deploy-pages.yml`

In GitHub repo settings:
`Settings -> Pages -> Source: GitHub Actions`

## Important policy note

This setup can upload your local recording audio to YouTube, but it does not bypass copyright rules.  
If uploaded audio includes content you do not have rights to publish (for example Spotify tracks), YouTube can still claim, block, or strike videos.
