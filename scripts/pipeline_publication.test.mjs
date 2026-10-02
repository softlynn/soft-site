import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { applyArchivePublicationToWorktree, mergePublicationContents, queueArchivePublication, publishPendingArchive } from "./pipeline_publication.mjs";

test("publishing an archive addition retains remote additions and admin edits", () => {
  const base = JSON.stringify([{ id: "old", title: "Original", youtube: [] }]);
  const proposed = JSON.stringify([{ id: "old", title: "Original", youtube: [] }, { id: "upload", youtube: [{ id: "yt-new", type: "vod" }] }]);
  const latest = JSON.stringify([{ id: "old", title: "Admin edited", youtube: [] }, { id: "remote", title: "Remote addition" }]);
  const merged = JSON.parse(mergePublicationContents({ base, proposed, latest, isVodIndex: true }));
  assert.equal(merged.find(({ id }) => id === "old").title, "Admin edited");
  assert.deepEqual(merged.map(({ id }) => id).sort(), ["old", "remote", "upload"]);
});

const withDirectory = async (run) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "archive-publication-"));
  try { return await run(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
};
const readJournal = async (journal) => JSON.parse(await fs.readFile(journal, "utf8"));
const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout.trim();
};
const setIdentity = (cwd) => {
  git(cwd, "config", "user.name", "Publication test");
  git(cwd, "config", "user.email", "publication@example.invalid");
  git(cwd, "config", "core.autocrlf", "false");
};
const commitFiles = (cwd, message) => {
  git(cwd, "add", "--all");
  git(cwd, "commit", "-m", message);
};

test("publication freezes legacy path intent before a failure and retries after its source disappears", () => withDirectory(async (directory) => {
  const journal = path.join(directory, "pending.json");
  const sourcePath = path.join(directory, "chat.json");
  await fs.writeFile(sourcePath, '{"comments":[1]}');
  const entry = { gitPath: "public/data/comments/1.json", sourcePath, baseRevision: "initial" };
  // Existing journals have no snapshot fields and migrate on first publish.
  await fs.writeFile(journal, JSON.stringify({ entries: [entry] }));
  let snapshotPath;
  await assert.rejects(publishPendingArchive(journal, async (entries) => {
    snapshotPath = entries[0].snapshotPath;
    assert.equal((await readJournal(journal)).entries[0].snapshotPath, snapshotPath);
    await fs.unlink(sourcePath);
    throw new Error("connection lost");
  }, { snapshotSources: true }), /connection lost/);
  assert.equal(await fs.readFile(snapshotPath, "utf8"), '{"comments":[1]}');
  await publishPendingArchive(journal, async (entries) => {
    assert.equal(entries[0].snapshotPath, snapshotPath);
    assert.equal(await fs.readFile(entries[0].snapshotPath, "utf8"), '{"comments":[1]}');
  }, { snapshotSources: true });
  assert.deepEqual((await readJournal(journal)).entries, []);
  assert.equal((await readJournal(journal)).baselines[0].snapshotPath, snapshotPath);
  assert.equal(await fs.readFile(snapshotPath, "utf8"), '{"comments":[1]}');
}));

test("requeue after a failed publish refreshes proposed contents while retaining the first merge base", () => withDirectory(async (directory) => {
  const journal = path.join(directory, "pending.json");
  const sourcePath = path.join(directory, "vods.json");
  const entry = { gitPath: "public/data/vods.json", sourcePath, baseRevision: "before-first-edit" };
  await fs.writeFile(sourcePath, '[{"id":"first"}]');
  await queueArchivePublication(journal, [entry]);
  await assert.rejects(publishPendingArchive(journal, async () => { throw new Error("offline"); }, { snapshotSources: true }), /offline/);
  await queueArchivePublication(journal, [{ ...entry, baseRevision: "after-local-commit" }]);
  await fs.writeFile(sourcePath, '[{"id":"first"},{"id":"second"}]');
  await publishPendingArchive(journal, async ([pending]) => {
    assert.equal(pending.baseRevision, "before-first-edit");
    assert.equal(await fs.readFile(pending.snapshotPath, "utf8"), '[{"id":"first"},{"id":"second"}]');
  }, { snapshotSources: true });
}));

test("queueing before file creation never turns a crash into a deletion", () => withDirectory(async (directory) => {
  const journal = path.join(directory, "pending.json");
  const sourcePath = path.join(directory, "not-written-yet.json");
  await queueArchivePublication(journal, [{ gitPath: "public/data/emotes/1.json", sourcePath, baseRevision: "initial" }]);
  let called = false;
  await assert.rejects(publishPendingArchive(journal, async () => { called = true; }, { snapshotSources: true }), { code: "ENOENT" });
  assert.equal(called, false);
  assert.equal((await readJournal(journal)).entries.length, 1);
  await fs.writeFile(sourcePath, '{"emotes":[]}');
  await publishPendingArchive(journal, async ([entry]) => {
    assert.equal(await fs.readFile(entry.snapshotPath, "utf8"), '{"emotes":[]}');
  }, { snapshotSources: true });
}));

test("an interrupted requeue keeps the previous durable snapshot until replacement capture succeeds", () => withDirectory(async (directory) => {
  const journal = path.join(directory, "pending.json");
  const sourcePath = path.join(directory, "chat.json");
  const entry = { gitPath: "public/data/comments/1.json", sourcePath, baseRevision: "initial" };
  await fs.writeFile(sourcePath, "original chat");
  await queueArchivePublication(journal, [entry]);
  await assert.rejects(publishPendingArchive(journal, async () => { throw new Error("offline"); }, { snapshotSources: true }), /offline/);
  const previousSnapshot = (await readJournal(journal)).entries[0].snapshotPath;
  await fs.unlink(sourcePath);
  await queueArchivePublication(journal, [entry]);
  assert.equal((await readJournal(journal)).entries[0].snapshotPath, previousSnapshot);
  assert.equal(await fs.readFile(previousSnapshot, "utf8"), "original chat");
  await assert.rejects(publishPendingArchive(journal, async () => { assert.fail("must wait for refreshed source"); }, { snapshotSources: true }), { code: "ENOENT" });
  assert.equal(await fs.readFile(previousSnapshot, "utf8"), "original chat");
  await fs.writeFile(sourcePath, "refreshed chat");
  await publishPendingArchive(journal, async ([pending]) => {
    assert.notEqual(pending.snapshotPath, previousSnapshot);
    assert.equal(await fs.readFile(pending.snapshotPath, "utf8"), "refreshed chat");
  }, { snapshotSources: true });
  await assert.rejects(fs.stat(previousSnapshot), { code: "ENOENT" });
}));

test("an abrupt publisher process exit leaves a recoverable snapshot and releases stale ownership", () => withDirectory(async (directory) => {
  const journal = path.join(directory, "pending.json");
  const sourcePath = path.join(directory, "chat.json");
  await fs.writeFile(sourcePath, "durable chat");
  await queueArchivePublication(journal, [{ gitPath: "public/data/comments/1.json", sourcePath, baseRevision: "initial" }]);
  const script = `import { publishPendingArchive } from ${JSON.stringify(new URL("./pipeline_publication.mjs", import.meta.url).href)};
    await publishPendingArchive(process.argv[1], async () => process.exit(33), {snapshotSources:true});`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, journal], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 33, child.stderr);
  await fs.unlink(sourcePath);
  await publishPendingArchive(journal, async ([pending]) => {
    assert.equal(await fs.readFile(pending.snapshotPath, "utf8"), "durable chat");
  }, { snapshotSources: true });
  assert.deepEqual((await readJournal(journal)).entries, []);
}));

test("a damaged frozen snapshot is retained and never silently replaced by live data", () => withDirectory(async (directory) => {
  const journal = path.join(directory, "pending.json");
  const sourcePath = path.join(directory, "chat.json");
  await fs.writeFile(sourcePath, "original");
  await queueArchivePublication(journal, [{ gitPath: "public/data/comments/1.json", sourcePath, baseRevision: "initial" }]);
  await assert.rejects(publishPendingArchive(journal, async () => { throw new Error("offline"); }, { snapshotSources: true }), /offline/);
  const before = await fs.readFile(journal, "utf8");
  const snapshotPath = (await readJournal(journal)).entries[0].snapshotPath;
  await fs.writeFile(snapshotPath, "damaged");
  await fs.writeFile(sourcePath, "newer live contents");
  await assert.rejects(publishPendingArchive(journal, async () => { assert.fail("must not publish"); }, { snapshotSources: true }), /snapshot is corrupt/);
  assert.equal(await fs.readFile(journal, "utf8"), before);
  assert.equal(await fs.readFile(snapshotPath, "utf8"), "damaged");
}));

test("failed acknowledgement preserves the old baseline and exact pending proposal for retry", () => withDirectory(async (directory) => {
  const journal = path.join(directory, "pending.json");
  const sourcePath = path.join(directory, "chat.json");
  const entry = { gitPath: "chat.json", sourcePath, baseRevision: "initial" };
  await fs.writeFile(sourcePath, "first proposal");
  await queueArchivePublication(journal, [entry]);
  await publishPendingArchive(journal, async () => {}, { snapshotSources: true });
  const originalBaseline = (await readJournal(journal)).baselines[0].snapshotPath;
  await queueArchivePublication(journal, [entry]);
  await fs.writeFile(sourcePath, "second proposal");
  const originalRename = fs.rename;
  let failAcknowledgement = false;
  try {
    fs.rename = async (...args) => {
      if (failAcknowledgement && args[1] === journal) {
        failAcknowledgement = false;
        throw Object.assign(new Error("acknowledgement disk failure"), { code: "EIO" });
      }
      return originalRename(...args);
    };
    await assert.rejects(publishPendingArchive(journal, async () => { failAcknowledgement = true; }, { snapshotSources: true }), /acknowledgement disk failure/);
  } finally { fs.rename = originalRename; }
  const pending = await readJournal(journal);
  assert.equal(pending.baselines[0].snapshotPath, originalBaseline);
  assert.equal(pending.entries[0].baseSnapshotPath, originalBaseline);
  await fs.writeFile(sourcePath, "unrelated newer content");
  await publishPendingArchive(journal, async ([retry]) => {
    assert.equal(await fs.readFile(retry.snapshotPath, "utf8"), "second proposal");
    assert.equal(await fs.readFile(retry.baseSnapshotPath, "utf8"), "first proposal");
  }, { snapshotSources: true });
  const acknowledged = await readJournal(journal);
  assert.deepEqual(acknowledged.entries, []);
  assert.equal(await fs.readFile(acknowledged.baselines[0].snapshotPath, "utf8"), "second proposal");
  await assert.rejects(fs.stat(originalBaseline), { code: "ENOENT" });
}));

test("invalid journals and path traversal are rejected without clearing pending work", () => withDirectory(async (directory) => {
  const journal = path.join(directory, "pending.json");
  const valid = { gitPath: "public/data/vods.json", sourcePath: "/source/vods.json", baseRevision: "initial" };
  for (const entries of [[{}], [valid, valid], [{ ...valid, gitPath: "../escape.json" }], [{ ...valid, gitPath: ".git/config" }]]) {
    const contents = JSON.stringify({ entries });
    await fs.writeFile(journal, contents);
    await assert.rejects(publishPendingArchive(journal, async () => { assert.fail("must not publish"); }), /publication journal/);
    assert.equal(await fs.readFile(journal, "utf8"), contents);
  }
}));

test("a concurrent process queues after publication acknowledgement without losing its new entry", () => withDirectory(async (directory) => {
  const journal = path.join(directory, "pending.json");
  const marker = path.join(directory, "child-started");
  const entry = { gitPath: "public/data/vods.json", sourcePath: "/source/vods.json", baseRevision: "initial" };
  await queueArchivePublication(journal, [entry]);
  let childDone;
  await publishPendingArchive(journal, async () => {
    const script = `import fs from 'node:fs/promises';
      import { queueArchivePublication } from ${JSON.stringify(new URL("./pipeline_publication.mjs", import.meta.url).href)};
      await fs.writeFile(process.argv[2], 'started');
      await queueArchivePublication(process.argv[1], [{gitPath:'public/data/emotes/2.json',sourcePath:'/source/emotes.json',baseRevision:'later'}]);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, journal, marker], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    childDone = new Promise((resolve, reject) => {
      let stderr = "";
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
    });
    for (let i = 0; i < 200; i += 1) {
      if (await fs.stat(marker).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await fs.readFile(marker, "utf8"), "started");
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.deepEqual((await readJournal(journal)).entries.map((item) => item.gitPath), [entry.gitPath]);
  });
  await childDone;
  assert.deepEqual((await readJournal(journal)).entries.map((item) => item.gitPath), ["public/data/emotes/2.json"]);
}));

test("a real Git roundtrip preserves remote admin changes and exact frozen retry intent", () => withDirectory(async (directory) => {
  const remote = path.join(directory, "remote.git");
  const local = path.join(directory, "local");
  const publisher = path.join(directory, "publisher");
  const admin = path.join(directory, "admin");
  const journal = path.join(directory, "pending.json");
  git(directory, "init", "--bare", "--initial-branch=main", remote);
  git(directory, "clone", remote, local);
  setIdentity(local);
  const sourcePath = path.join(local, "public", "data", "vods.json");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, JSON.stringify([{ id: "1", title: "Original", durationSeconds: 1, youtube: [] }]));
  commitFiles(local, "initial");
  git(local, "push", "origin", "main");
  const baseRevision = git(local, "rev-parse", "HEAD");
  git(directory, "clone", remote, admin);
  setIdentity(admin);
  await fs.writeFile(path.join(admin, "public", "data", "vods.json"), JSON.stringify([
    { id: "1", title: "Admin title", hidden: true, durationSeconds: 1, youtube: [] }, { id: "remote", youtube: [] },
  ]));
  commitFiles(admin, "concurrent admin changes");
  git(admin, "push", "origin", "main");
  await queueArchivePublication(journal, [{ gitPath: "public/data/vods.json", sourcePath, baseRevision }]);
  await fs.writeFile(sourcePath, JSON.stringify([{ id: "1", title: "Original", durationSeconds: 2, youtube: [{ id: "uploaded", type: "vod" }] }]));
  git(directory, "clone", remote, publisher);
  setIdentity(publisher);
  const applyAndPush = async (entries) => {
    await applyArchivePublicationToWorktree({ entries, repoRoot: local, worktreeDir: publisher, vodsDataPath: sourcePath });
    if (git(publisher, "status", "--porcelain")) {
      commitFiles(publisher, "publish archive");
      git(publisher, "push", "origin", "main");
    }
  };
  await assert.rejects(publishPendingArchive(journal, async (entries) => {
    await applyAndPush(entries);
    // Simulate an accepted push whose acknowledgement never reached the caller.
    throw new Error("push acknowledgement lost");
  }, { snapshotSources: true }), /acknowledgement lost/);
  await fs.writeFile(sourcePath, JSON.stringify([{ id: "1", title: "Original", durationSeconds: 3, youtube: [
    { id: "uploaded", type: "vod" }, { id: "later-upload", type: "vod" },
  ] }]));
  const publishedHead = git(remote, "rev-parse", "main");
  await publishPendingArchive(journal, applyAndPush, { snapshotSources: true });
  assert.equal(git(remote, "rev-parse", "main"), publishedHead, "retry should be an idempotent no-op");
  const rows = JSON.parse(git(remote, "show", "main:public/data/vods.json"));
  assert.equal(rows.find(({ id }) => id === "1").title, "Admin title");
  assert.equal(rows.find(({ id }) => id === "1").hidden, true);
  assert.equal(rows.find(({ id }) => id === "1").durationSeconds, 2);
  assert.deepEqual(rows.find(({ id }) => id === "1").youtube, [{ id: "uploaded", type: "vod" }]);
  assert.deepEqual(rows.map(({ id }) => id).sort(), ["1", "remote"]);
  assert.deepEqual((await readJournal(journal)).entries, []);
  // Frozen publication must not commit newer live files locally: that would
  // make their unpublished contents the next merge base and silently drop them.
  assert.equal(git(local, "rev-parse", "HEAD"), baseRevision);
  await queueArchivePublication(journal, [{ gitPath: "public/data/vods.json", sourcePath, baseRevision: git(local, "rev-parse", "HEAD") }]);
  await publishPendingArchive(journal, applyAndPush, { snapshotSources: true });
  const laterRows = JSON.parse(git(remote, "show", "main:public/data/vods.json"));
  assert.deepEqual(laterRows.find(({ id }) => id === "1").youtube, [
    { id: "uploaded", type: "vod" }, { id: "later-upload", type: "vod" },
  ]);
  assert.equal(laterRows.find(({ id }) => id === "1").title, "Admin title");
  assert.equal(laterRows.find(({ id }) => id === "1").hidden, true);
  assert.equal(laterRows.find(({ id }) => id === "1").durationSeconds, 3, "the same field must advance from its acknowledged proposal");
  assert.deepEqual((await readJournal(journal)).entries, []);
  assert.equal((await readJournal(journal)).baselines.length, 1);
  assert.equal((await fs.readdir(`${journal}.snapshots`)).length, 1, "superseded baseline snapshots must be collected");
}));

test("acknowledged chat baselines allow repeated edits, explicit deletion, and recreation without local commits", () => withDirectory(async (directory) => {
  const repo = path.join(directory, "repo");
  const worktree = path.join(directory, "worktree");
  const journal = path.join(directory, "pending.json");
  git(directory, "init", "--initial-branch=main", repo);
  setIdentity(repo);
  const sourcePath = path.join(repo, "chat.json");
  await fs.writeFile(sourcePath, "first");
  commitFiles(repo, "initial");
  const baseRevision = git(repo, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "--detach", worktree, "HEAD");
  const publish = async (entries) => {
    await applyArchivePublicationToWorktree({ entries, repoRoot: repo, worktreeDir: worktree, vodsDataPath: path.join(repo, "vods.json") });
    commitFiles(worktree, "publish chat");
  };
  for (const contents of ["second", "third"]) {
    await queueArchivePublication(journal, [{ gitPath: "chat.json", sourcePath, baseRevision }]);
    await fs.writeFile(sourcePath, contents);
    await publishPendingArchive(journal, publish, { snapshotSources: true });
    assert.equal(await fs.readFile(path.join(worktree, "chat.json"), "utf8"), contents);
  }
  await queueArchivePublication(journal, [{ gitPath: "chat.json", sourcePath, baseRevision, deleted: true }]);
  await fs.unlink(sourcePath);
  await publishPendingArchive(journal, publish, { snapshotSources: true });
  assert.equal((await readJournal(journal)).baselines[0].snapshotPath, null);
  await assert.rejects(fs.stat(path.join(worktree, "chat.json")), { code: "ENOENT" });
  await queueArchivePublication(journal, [{ gitPath: "chat.json", sourcePath, baseRevision }]);
  await fs.writeFile(sourcePath, "recreated");
  await publishPendingArchive(journal, publish, { snapshotSources: true });
  assert.equal(await fs.readFile(path.join(worktree, "chat.json"), "utf8"), "recreated");
  assert.equal(git(repo, "rev-parse", "HEAD"), baseRevision);
  assert.equal((await fs.readdir(`${journal}.snapshots`)).length, 1);
}));

test("Git base failures and concurrent chat changes remain errors with publication queued", () => withDirectory(async (directory) => {
  const repo = path.join(directory, "repo");
  const worktree = path.join(directory, "worktree");
  git(directory, "init", "--initial-branch=main", repo);
  setIdentity(repo);
  const sourcePath = path.join(repo, "chat.json");
  await fs.writeFile(sourcePath, "base");
  commitFiles(repo, "initial");
  const baseRevision = git(repo, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "--detach", worktree, "HEAD");
  await fs.writeFile(path.join(worktree, "chat.json"), "remote edit");
  commitFiles(worktree, "remote change");
  await fs.writeFile(sourcePath, "local edit");
  const journal = path.join(directory, "pending.json");
  await queueArchivePublication(journal, [{ gitPath: "chat.json", sourcePath, baseRevision }]);
  await assert.rejects(publishPendingArchive(journal, async (entries) => {
    await applyArchivePublicationToWorktree({ entries, repoRoot: repo, worktreeDir: worktree, vodsDataPath: path.join(repo, "vods.json") });
  }, { snapshotSources: true }), /changed remotely/);
  assert.equal((await readJournal(journal)).entries.length, 1);
  assert.equal(await fs.readFile(path.join(worktree, "chat.json"), "utf8"), "remote edit");
  await assert.rejects(applyArchivePublicationToWorktree({
    entries: [{ gitPath: "chat.json", sourcePath, baseRevision: "missing-commit" }],
    repoRoot: repo, worktreeDir: worktree, vodsDataPath: sourcePath,
  }), /git rev-parse failed/);
  assert.equal(await fs.readFile(path.join(worktree, "chat.json"), "utf8"), "remote edit");
}));

test("malformed VOD indexes are rejected even when Git would take the direct copy path", () => withDirectory(async (directory) => {
  const repo = path.join(directory, "repo");
  const worktree = path.join(directory, "worktree");
  git(directory, "init", "--initial-branch=main", repo);
  setIdentity(repo);
  const sourcePath = path.join(repo, "vods.json");
  await fs.writeFile(sourcePath, "[]");
  commitFiles(repo, "initial");
  const baseRevision = git(repo, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "--detach", worktree, "HEAD");
  for (const malformed of ["{broken", '{"vods":[]}']) {
    await fs.writeFile(sourcePath, malformed);
    await assert.rejects(applyArchivePublicationToWorktree({
      entries: [{ gitPath: "vods.json", sourcePath, baseRevision }],
      repoRoot: repo, worktreeDir: worktree, vodsDataPath: sourcePath,
    }));
    assert.equal(await fs.readFile(path.join(worktree, "vods.json"), "utf8"), "[]");
    assert.throws(() => mergePublicationContents({ base: "[]", proposed: malformed, latest: "[]", isVodIndex: true }));
  }
}));

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
