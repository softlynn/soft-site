# Softuchive 2.2 and the soft archive

This release concentrates on preserving finished OBS recordings, recovering interrupted work, and making the archive comfortable to use on a phone. The active Twitch channel is `softxu`; the display name remains `soft`.

## Archiving and recovery

Uploads use the YouTube resumable protocol with bounded media reads and 8 MiB chunks. Private local checkpoints record the session, source identity, confirmed position, final-request intent, and returned video ID. The worker queries the existing session after a lost response. It can restart an expired session only when its saved state excludes a potentially completed final request; uncertain completion requires verification before another upload can begin.

FFmpeg copies encoded video and the first audio stream into a reusable upload file. It does not resize or re-encode them, and does not remove the original recording. Prepared media and its manifest are flushed before use. Resume requires the original cached file; missing or changed cache evidence cannot trigger replacement while a saved upload session refers to it. Reuse checks the saved path, size, and file timestamps without hashing the entire recording on each retry. Paused, failed, and uncertain uploads retain their evidence. Only eligible terminal states release verified generated copies; a manual skip with uncertain final-request status retains its cache and session.

Returned video IDs are journaled before metadata work. Recovery and ordinary finalization consult current archive visibility and metadata, including admin edits made during a long upload. The archive index is saved before the recording becomes complete. Chat export can retry independently of video preservation. Unmatched recordings no longer consume the successful-plan limit, transient probe failures remain retryable, and the current live Twitch stream is deferred.

Archive-index writes share a cross-process lock and a three-way merge. Admin publication journals the requested changes so remote additions and unrelated local uploads survive. Pipeline publication records intent before data writes and retries pending changes on a later poll even if no new recording exists. Conflicting remote changes to files other than the index stop publication and leave it queued for reconciliation. Only the process holding the run lock may update runtime state, including error reporting.

YouTube updates and archive-file writes remain separate operations. Finalization rereads admin decisions, but a visibility edit after its last read can still race the remote privacy update and need reconciliation.

Critical JSON writes flush file contents before atomic replacement. POSIX additionally flushes supported directory metadata. Windows does not expose equivalent directory flushing through this Node API; this is not a guarantee against every storage or power failure.

## Desktop and website

The desktop opens on the current transfer and queue. Settings and Activity use compact tabs; recovery and utilities are secondary controls. Existing scheduling, OBS-close, bandwidth, pause/resume, skip, folder and log actions remain. Hidden or minimized windows skip periodic view polling; enabled OBS-close monitoring continues while the app is running. Disabled OBS monitoring avoids process checks, and media preparation runs below normal priority where supported. Electron remains the runtime; the visual simplification is not a claim of a substantially smaller executable or zero resource usage.

The website retains its desktop identity. Phone layouts use direct navigation, search with optional filters, readable cards and titles, larger touch targets, and a more compact chat view. The supplied voxel image replaces the old fallback thumbnail without cropping the figure. Mobile viewer expansion uses a viewport overlay with safe-area padding and cleanup, rather than depending on element fullscreen support. Copying a timestamp offers a selectable link if clipboard access is unavailable.

Replay mapping accounts for hidden parts before visible part numbers are assigned. Known offsets drive player time, chat, chapters and copied links consistently. Unknown offsets do not invent a chat timeline. Existing archives still have two data limitations: aggregate duration cannot distinguish a late recording start from unpublished trailing media, and previously merged adjacent VODs lack complete per-part chat provenance.

## Operating notes

- Choose **Resume** for a paused run, or **Check recordings** after a stopped or failed run. If a stale processing marker keeps a recording out of the queue, open **Activity → Recover an interrupted archive** and confirm **Restart interrupted run**. This requires no active run, clears processing/paused markers, and retains completed records and the separate upload-session/cache files.
- Retain `scripts/.state` and `scripts/.tmp`, or the directories configured through `PIPELINE_STATE_PATH` and `PIPELINE_TMP_DIR`; these contain recovery information. A checkpoint or cached-media verification error needs investigation using the retained state and YouTube result. Restarting the poll does not resolve uncertain completion or replace that evidence.
- **Pause** stops at the next safe point. **Skip VOD** deliberately excludes that recording version from future automatic attempts; use Pause when you intend to resume.
- Original recordings remain the quality master. YouTube creates its own playback encodings after upload.
- Matching currently examines the 20 recent Twitch archives returned by the existing lookup. Legacy completed records without source fingerprints stay completed; the new checkpoints do not reconstruct missing recovery evidence for past uploads.
- Archiving runs locally while the PC is available. No PC-off service or remote upload worker was introduced.
- The Windows portable app requires the configured repository and its dependencies, credentials, and media tools. Keep it inside that repository tree or set `SOFTUCHIVE_REPO_ROOT`; the executable does not bundle the archive pipeline. The existing unsigned build configuration remains.
- Dependencies include compatible security updates, including Electron 43.7.6. The existing tracked npm configuration remains in effect. The pull-request workflow is configured to run tests on Windows and Ubuntu and build the site on Ubuntu.

## Validation

Local validation completed on Windows:

- Regression suite: 218 tests total, 216 passed, 0 failed, and 2 expected skips for POSIX directory-fsync behavior unavailable on Windows.
- Production site build: passed.
- Root dependency audit and desktop production dependency audit: 0 reported vulnerabilities.
- Real FFmpeg synthetic-media check: all 90 H.264 video packets and 142 first-track AAC packets retained identical payload hashes, sizes, timestamps, and durations. The original file hash stayed unchanged and the next preparation reused the cache. Container duration metadata differed by 8 ms; the retained packet timeline did not change.

Final Chromium/WebKit browser verification is pending. No live upload, production publication, or scheduler enablement is used as a test.

The rebuilt Windows portable is 93,893,100 bytes and contains Electron 43.7.6. Six packaged source files and both icon assets match the source checkout; the ASAR extracted from the portable matches the tested archive. All 17 packaged controller tests and the mocked Electron renderer checks pass. The renderer checks load packaged content in an isolated profile; they do not exercise a production archive job. Mobile browser emulation does not substitute for physical iPhone testing.
