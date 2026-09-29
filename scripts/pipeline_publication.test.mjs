import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergePublicationContents, queueArchivePublication, publishPendingArchive } from "./pipeline_publication.mjs";

test("publishing an archive addition retains remote additions and admin edits", () => {
  const base = JSON.stringify([{ id: "old", title: "Original", youtube: [] }]);
  const proposed = JSON.stringify([{ id: "old", title: "Original", youtube: [] }, { id: "upload", youtube: [{ id: "yt-new", type: "vod" }] }]);
  const latest = JSON.stringify([{ id: "old", title: "Admin edited", youtube: [] }, { id: "remote", title: "Remote addition" }]);
  const merged = JSON.parse(mergePublicationContents({ base, proposed, latest, isVodIndex: true }));
  assert.equal(merged.find(({ id }) => id === "old").title, "Admin edited");
  assert.deepEqual(merged.map(({ id }) => id).sort(), ["old", "remote", "upload"]);
});

test("a concurrently changed non-index archive file is never overwritten", () => {
  assert.throws(() => mergePublicationContents({ base: '{"comments":[]}', proposed: '{"comments":[1]}', latest: '{"comments":[2]}' }), /changed remotely/);
  assert.equal(mergePublicationContents({ base: "same", proposed: "same", latest: "remote" }), "remote");
  assert.throws(() => mergePublicationContents({ base: "old", proposed: null, latest: "remote" }), /changed remotely/);
});

test("a failed publish stays queued and an otherwise empty next poll retries it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-publish-test-"));
  const journalPath = path.join(dir, "pending.json");
  try {
    await queueArchivePublication(journalPath, [{ gitPath: "public/data/vods.json", sourcePath: "/source/vods.json", baseRevision: "initial" }]);
    await assert.rejects(publishPendingArchive(journalPath, async () => { throw new Error("network unavailable"); }), /network unavailable/);
    const afterFailure = JSON.parse(await fs.readFile(journalPath, "utf8"));
    assert.equal(afterFailure.entries.length, 1);
    // A later run may add another change; the original merge base must survive.
    await queueArchivePublication(journalPath, [{ gitPath: "public/data/vods.json", sourcePath: "/source/vods.json", baseRevision: "new-local-commit" }]);
    let published;
    await publishPendingArchive(journalPath, async (entries) => { published = entries; });
    assert.equal(published[0].baseRevision, "initial");
    assert.deepEqual(JSON.parse(await fs.readFile(journalPath, "utf8")).entries, []);
    assert.equal(await publishPendingArchive(journalPath, async () => { throw new Error("must not republish"); }), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
