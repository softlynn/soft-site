import assert from "node:assert/strict";
import test from "node:test";
import { collectAvailableEmoteSets, mergeEmoteArchive, validateChatExport } from "./pipeline_chat_archive.mjs";

test("one provider outage preserves other providers and marks an emote retry", async () => {
  const incoming = await collectAvailableEmoteSets({
    ffz_emotes: async () => { throw new Error("offline"); },
    bttv_emotes: async () => [{ id: "new" }],
    "7tv_emotes": async () => [],
  });
  const result = mergeEmoteArchive({ ffz_emotes: [{ id: "retained" }], embedded_emotes: [{ id: "embedded" }] }, { ...incoming, embedded_emotes: [] });
  assert.deepEqual(result.ffz_emotes, [{ id: "retained" }]);
  assert.deepEqual(result.bttv_emotes, [{ id: "new" }]);
  assert.deepEqual(result.unavailableProviders, ["ffz_emotes"]);
  assert.deepEqual(result.embedded_emotes, [{ id: "embedded" }]);
});

test("a recovered provider clears the retry marker and newly recovered chat adds embedded emotes", async () => {
  const incoming = await collectAvailableEmoteSets({ ffz_emotes: async () => [], bttv_emotes: async () => [], "7tv_emotes": async () => [] });
  const result = mergeEmoteArchive({ unavailableProviders: ["ffz_emotes"], embedded_emotes: [] }, { ...incoming, embedded_emotes: [{ id: "restored" }] });
  assert.deepEqual(result.unavailableProviders, []);
  assert.deepEqual(result.embedded_emotes, [{ id: "restored" }]);
});

test("a pause is not converted to a recoverable provider outage", async () => {
  const pause = Object.assign(new Error("pause"), { code: "SOFTUCHIVE_PAUSED" });
  await assert.rejects(collectAvailableEmoteSets({ ffz_emotes: async () => { throw pause; }, bttv_emotes: async () => [], "7tv_emotes": async () => [] }), (error) => error === pause);
});

test("missing or truncated chat cannot become a permanently cached empty replay", () => {
  assert.throws(() => validateChatExport({}), /invalid or incomplete/);
  assert.throws(() => validateChatExport({ comments: [null] }), /invalid or incomplete/);
  assert.deepEqual(validateChatExport({ comments: [] }), { comments: [] });
});
