# Softuchive 2.1 and site polish

Validated locally on September 12, 2026. Source: `C:\StreamAdmin\soft-site`, a junction to
`C:\Users\Softu\soft-site-refresh`, branch `agent/softuchive-modernization`.
Upstream: https://github.com/softlynn/soft-site; public site: https://softu.one.

## Delivered

- Softuchive: compact Archive, Settings and Activity views; retained scheduling, OBS-close polling,
  storage, pause/resume, throttle, skip, recovery and logs. Reduced redundant Windows process checks.
- Admin: searchable VOD list, explicit saves, clearer errors, and an on-demand same-origin local
  console. Open it from Softuchive, or run `npm run admin:api:wake` then visit
  `http://127.0.0.1:49731/console/admin`. The launcher verified healthy on this PC.
  A second wake completed in 0.27 seconds and reused the same server process.
- Pipeline: atomic state replacement, coalesced progress writes, safer run ownership, and pause/skip
  handling that does not mistake an intentional pause for a stalled upload.
- Site: preserved current upstream branding, theme, sponsor, card previews and viewer features;
  improved filters, loading states, chat replay rendering and player cleanup.
- Public page rendering no longer loads the design editor runtime. The design-config chunk dropped
  from 604.7 KB to 208.1 KB uncompressed (164.98 to 61.86 KB gzip) in the measured local builds.
  Remote Feathers libraries are also loaded only when remote archive mode is used.
- Header animation: preserved the original source, added a 708-pixel/30-fps web version with alpha.
  The animated download is 475,737 bytes instead of 7,295,333 bytes (93.5% smaller); a 42,790-byte
  still frame covers loading, reduced motion and video errors. Browser playback and reduced-motion
  fallback were checked. Fullscreen logo transition remains available.
- Visible VOD cards share one reaction-backend health check and its retry chain. Separate regression
  tests cover concurrent discovery and recovery from an expired fallback.
- Deployment workflow now runs regression tests before building.

## Validation

- `npm test`: 42 passed, 0 failed.
- `npm run build`: passed, including builds through the Windows junction.
- Real admin server in an isolated temporary Git repository: authentication, origin checks, concurrent
  flag writes and synthetic VOD publication passed. No real YouTube IDs or live archive writes used.
- Browser checks: public search, date/game filters, card preview controls, viewer navigation and chat
  visibility; admin login, flags, refresh, synthetic publication, design access and logout.
- Mobile checks at 390 px: no horizontal overflow in tested archive, viewer and admin routes.
- Desktop: nine controller tests and hidden Electron renderer smoke passed, also against packaged
  production files. Packaged source matches the working tree; QA/tests excluded from the ASAR.
- Portable build: `softuchive-dist/2.1.0/Softuchive-2.1.0-x64.exe` (90,129,018 bytes).
  SHA-256: `0e790fff2d51fa249ecb63b316f4582ded8d6645c0c30043dfc322055e68ecc1`.

## Boundaries and remaining checks

- This pass is local; it has not pushed, merged or deployed these edits to GitHub Pages.
  Existing draft PR: https://github.com/softlynn/soft-site/pull/5. Its remote contents predate this pass.
- No real upload, schedule change, reaction vote or YouTube publication action was performed.
- The selected YouTube embed reported unavailable, so playable-video audio, seeking and synchronized
  chat playback still need an end-to-end check with a playable VOD. Reaction Worker health and VOD
  reads returned 200 with the production `https://softu.one` origin; local preview origins are not
  in that Worker's CORS allowlist and fall back to a legacy counter service returning 410. No votes
  were sent. Unit tests cover chat seek boundaries and multipart selection.
- The portable self-extracting bootstrap was not launched. Its packaged renderer/preload and main
  controller were tested in isolation with production task launches disabled.
- File-update queues are process-local. A separate long-running pipeline can still overwrite admin
  VOD metadata edits made during that run. Until cross-process merge coordination is added, make
  admin metadata changes between archive runs. Atomic files alone do not resolve this conflict.
- Existing OBS music integration work was preserved, including unrelated unstaged and untracked files.
- Old 2.0.0 portable retained. Cleanup was blocked by the execution policy, so two generated failed-build
  folders remain: `softuchive-dist/win-unpacked.tmp` and `softuchive-dist/2.1.0/win-unpacked.tmp`
  (about 695 MiB combined). They contain reproducible build output, not source or recordings.
  The isolated admin browser fixture `C:\Users\Softu\AppData\Local\Temp\soft-admin-browser-SCkcbH`
  also remains; its processes are stopped. It contains junctions; do not delete their live targets.

Screenshots are under `tmp/qa-admin-*.png`, `tmp/qa-vods-*.png`, and
`%TEMP%\softuchive-packaged-preview`. Rebuild the site after frontend edits to refresh the local console.
