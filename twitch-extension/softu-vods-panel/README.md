# Softu Twitch Panel Extension (Recent VODs)

This is a Twitch **Panel Extension** frontend that shows the 4 most recent published VODs from the archive and links to the site VOD pages.

## What it does

- Reads VODs from `https://softu.one/data/vods.json`
- Shows the 4 newest published VODs
- Hides unpublished VODs
- Opens the site VOD page on click (`https://softu.one/#/youtube/<vodId>`)

## Files to upload to Twitch

Upload the contents of this folder as your extension ZIP:

- `panel.html`
- `panel.css`
- `panel.js`
- `config.html` (optional but included)

## Twitch Dev Console setup (required)

Create a **Panel** extension and add these allowlisted domains / CSP sources:

- `https://softu.one`
- `https://static-cdn.jtvnw.net`
- `https://i.ytimg.com`

The extension also loads the official Twitch helper script from:

- `https://extension-files.twitch.tv`

## Local preview overrides (optional)

For testing a different site/data source, append query params to `panel.html`:

- `?siteUrl=https://softu.one`
- `?dataUrl=https://softu.one/data/vods.json`

Example:

`panel.html?siteUrl=https://softu.one&dataUrl=https://softu.one/data/vods.json`
