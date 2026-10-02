# Pipeline reliability — October 2026

The local archive pipeline now preserves more recovery evidence and makes interruption and publication failures explicit.

## Recording and upload preservation

- Original recordings remain intact. Prepared upload copies retain the original video with stream copying, without encoding or quality conversion, and select the first available audio track.
- The worker confirms the configured Twitch channel and active-stream identity before planning uploads. Recordings overlapping a live stream are deferred. Matching uses actual recording/VOD overlap and rejects ambiguous or foreign-channel matches.
- Source identity is checked during discovery and preparation. Unresolved uploads whose source changed, whose identity is missing, or whose prepared-media location changed are deferred with an actionable error. They do not silently start a replacement upload.
- Orphaned processing markers retain their source and prepared-copy evidence. The prepared-copy location is saved before upload starts. Private upload checkpoints and uncertain final requests remain available for recovery; cleanup requires a safe terminal outcome.
- Desktop Restart and a changed minimum-duration policy preserve unresolved upload evidence. Restart refuses invalid recovery state and holds the worker's shared ownership lock while durably replacing valid state, then releases it before launching another poll.
- A completed archive write must actually contain the uploaded video before its checkpoint becomes completed. Failed writes preserve a recoverable uploaded checkpoint. Concurrent archive edits and visibility choices remain authoritative.

## Controls, failures, and progress

HTTP lookups have deadlines, bounded JSON bodies, and limited retries for transient failures. Rate-limit responses respect the server's delay; excessively long delays defer the request. Recording probes and chat exports run asynchronously so pause checks can continue. Child termination escalates when necessary, and the worker retains ownership until the child closes. Worker Git commands also have finite deadlines.

Malformed recovery state and unsafe numeric configuration fail explicitly. Control updates use shared locking, and clearing an old skip request cannot erase a newer request. Error reporting avoids serializing authenticated request objects or private checkpoint contents.

Badge and individual emote-provider outages are optional failures. Existing data is retained, successful providers can update independently, and failed emote refreshes remain eligible for retry. Failed chat exports do not create a false empty replay; chat backfill retries after its cooldown and restores embedded emotes alongside comments. Cached replay data is retained when all video parts are skipped.

Progress reporting keeps one active request and coalesces pending updates. Stage ordering prevents late progress from reopening a finalizing or completed upload. Unknown progress remains `null`, rather than appearing as zero. Queued entries become the corresponding active upload, and completion counts reflect successfully archived parts.

## Recovery and publication

For an ordinary pause or network interruption, retain the recording, prepared copy, and private checkpoints, then resume the pipeline. Upload recovery uses the same prepared media and YouTube-confirmed progress. A source/cache mismatch requires restoring the previous source/cache configuration or verifying the earlier YouTube upload before deciding how to reconcile it. Do not discard recovery evidence merely to make the next poll start.

A specifically unavailable uploaded video can remain pending while other recordings continue. Its checkpoint is retained and the run reports the pending finalization. Authentication failures, corrupted state, and persistence failures still stop work where continuing cannot be shown safe.

Publication freezes file contents before attempting a push. Retries reuse those snapshots, and an acknowledged baseline ledger records what was successfully published per file. Later updates compare against that baseline rather than assuming the local Git commit represents the published state. Remote conflicts remain queued for reconciliation; missing or corrupt snapshots do not become implicit deletions.

An initial publication failure does not prevent unrelated local recovery from starting. Outstanding publication failures remain visible at the end of the run. Publication commits are created in an isolated worktree, so local archive JSON files may remain modified after a successful publish; that alone does not indicate a failed publish. Preserve the publication journal, snapshots, and baseline ledger when diagnosing a discrepancy.

## Known limits

- A crash can occur after the private upload session saves YouTube's video ID but before the worker saves its archive checkpoint. If the original recording or Twitch match subsequently disappears, automatic indexing may require manual recovery. Preserve the saved evidence and verify the existing video before attempting another upload.
- Legacy runs that already deleted their processing checkpoint cannot conclusively associate a changed original recording with an older prepared-media session. The new guard detects matching relocated sessions and retains future evidence, but cannot reconstruct identity information that was previously lost.
- YouTube, the local archive, and Git publication do not share one atomic transaction. Durable checkpoints, snapshot baselines, and bounded rereads narrow these failure windows; they do not make the services atomic.

## Validation

The final local Windows suite passed 370 tests, with two expected skips for POSIX directory synchronization. The production site build and Worker deployment dry run passed. Validation uses temporary Git repositories, SQLite executing the real status API SQL, interrupted writers, and isolated spawned-worker fixtures with external services and child processes blocked or simulated. A real FFmpeg remux test confirms identical encoded video and first-audio packet hashes and an unchanged original recording.

No live archive upload or publication of recording data is used for these checks. Cross-platform CI validates the final commit before release.
