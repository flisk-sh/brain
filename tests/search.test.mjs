import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "brain-search-"));
process.env.BRAIN_CLAUDE_DIR = root;
process.env.BRAIN_NO_RG = "1";
const { listFiles, search } = await import("../lib/claude-code.mjs");

const line = (text, isSidechain = false) => JSON.stringify({ type: "user", isSidechain, timestamp: "2026-10-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
mkdirSync(join(root, "p"), { recursive: true });
for (let i = 0; i < 40; i++) {
  const path = join(root, "p", `s${i}.jsonl`);
  writeFileSync(path, line(`fix checkout ${i}`));
  utimesSync(path, 1_700_000_000 + i, 1_700_000_000 + i);
}

test("a common word returns `limit` hits from the newest files", async () => {
  const hits = await search("checkout", listFiles(), 10);
  assert.equal(hits.length, 10);
  assert.ok(hits.every((h) => /s(3\d)\.jsonl$/.test(h.path)));
});

test("a changed file is read again, not served from the cache", async () => {
  await search("checkout", listFiles(), 5);
  const path = join(root, "p", "s39.jsonl");
  writeFileSync(path, line("fix zebra 39"));
  utimesSync(path, 1_700_000_100, 1_700_000_100);
  assert.equal((await search("checkout", listFiles(), 5)).some((h) => h.path === path), false);
  assert.equal((await search("zebra", listFiles(), 5))[0]?.path, path);
});

test("search ignores sidechain text just like the session reader", async () => {
  const sidechainOnly = join(root, "p", "sidechain-only.jsonl");
  const mixed = join(root, "p", "mixed.jsonl");
  writeFileSync(sidechainOnly, line("cobalt sidechain only", true) + line("unrelated visible message"));
  writeFileSync(mixed, line("cobalt hidden", true) + line("cobalt visible"));

  const hits = await search("cobalt", listFiles());
  assert.deepEqual(hits, [{ id: "mixed", path: mixed, score: 1, snippet: "cobalt visible" }]);
});
