// Brain benchmark. Everything here is measured on this machine, on generated sessions (no real history is read).
// Run: node bench/bench.mjs      Output: bench/results.json (also copied to landing/bench.json)
import { mkdirSync, writeFileSync, rmSync, statSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, cpus, platform, arch, totalmem } from "node:os";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";

const WORK = join(tmpdir(), "brain-bench-" + process.pid);
rmSync(WORK, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true });
process.env.BRAIN_CLAUDE_DIR = join(WORK, "projects");
process.env.BRAIN_CACHE = join(WORK, "index.json");
const { listFiles, parseSession, search } = await import("../lib/claude-code.mjs");
const { loadIndex } = await import("../lib/index.mjs");
const { redact, tidyPaths } = await import("../lib/redact.mjs");

const now = () => performance.now();
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
async function time(fn, runs = 5) { const t = []; for (let i = 0; i < runs; i++) { const s = now(); await fn(); t.push(now() - s); } return median(t); }

// Deterministic pseudo-random so every run builds the same corpus.
let seed = 42; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const V = "the a to of and in is it for on with this that we fix add update check run test file function value error null undefined checkout cart price order user token request response config build deploy cache query index route handler session render component state props hook".split(" ");
const words = (n) => Array.from({ length: n }, () => V[Math.floor(rnd() * V.length)]).join(" ");

function sessionLines(i, msgs, tag) {
  const lines = []; const t0 = Date.UTC(2026, 9, 1) + i * 60000;
  for (let m = 0; m < msgs; m++) {
    const user = m % 2 === 0; const ts = new Date(t0 + m * 4000).toISOString();
    const content = user ? [{ type: "text", text: (m === 0 ? `Fix ${tag} ` : "") + words(30) }]
      : [{ type: "text", text: words(60) + (m === 1 ? " " + tag : "") + (rnd() < 0.3 ? " panic: unexpected" : "") }, { type: "tool_use", name: rnd() < 0.5 ? "Read" : "Edit", input: { file_path: `/Users/dev/proj${i % 20}/src/f${m}.js` } }];
    lines.push(JSON.stringify({ type: user ? "user" : "assistant", timestamp: ts, cwd: `/Users/dev/proj${i % 20}`, gitBranch: "main", message: { role: user ? "user" : "assistant", model: "claude-sonnet-5-5", content } }));
  }
  return lines.join("\n") + "\n";
}
function makeCorpus(dir, n, msgs) {
  rmSync(dir, { recursive: true, force: true });
  for (let i = 0; i < n; i++) {
    const d = join(dir, "p" + (i % 20)); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `s${String(i).padStart(6, "0")}.jsonl`), sessionLines(i, msgs, "zq" + i + "x"));
  }
}
const dirSize = (dir) => { let t = 0, f = 0; for (const p of readdirSync(dir)) for (const x of readdirSync(join(dir, p))) { t += statSync(join(dir, p, x)).size; f++; } return { bytes: t, files: f }; };

const out = { meta: { date: new Date().toISOString().slice(0, 10), runtime: typeof Bun !== "undefined" ? "Bun " + Bun.version : "Node " + process.version, cpu: cpus()[0].model.trim(), cores: cpus().length, ramGB: Math.round(totalmem() / 2 ** 30), os: platform() + " " + arch(), note: "Generated sessions of 40 messages, 15 tool calls. No real history is read." }, corpus: [], session: [], redaction: {}, share: {} };

// 1. Corpus scale: many sessions.
for (const n of [100, 1000, 5000]) {
  makeCorpus(process.env.BRAIN_CLAUDE_DIR, n, 40);
  const { bytes, files } = dirSize(process.env.BRAIN_CLAUDE_DIR);
  rmSync(process.env.BRAIN_CACHE, { force: true });
  const cold = await time(async () => { rmSync(process.env.BRAIN_CACHE, { force: true }); loadIndex(); }, 3);
  loadIndex();
  const warm = await time(() => loadIndex(), 5);
  const cacheKB = statSync(process.env.BRAIN_CACHE).size / 1024;
  const f = listFiles();
  const rare = await time(() => search(`zq${n - 1}x`, f), 3);
  const common = await time(() => search("checkout", f), 3);
  const two = await time(() => search("fix null", f), 3);
  const none = await time(() => search("qqqqnomatch", f), 3);
  const list = await time(() => listFiles(), 5);
  const sh = (bin, args) => { const t = now(); const r = spawnSync(bin, args, { stdio: "ignore" }); return r.error ? null : now() - t; };
  const best = (bin, args) => { const a = [sh(bin, args), sh(bin, args), sh(bin, args)]; return a.includes(null) ? null : median(a); };
  const grepRare = best("/usr/bin/grep", ["-rl", `zq${n - 1}x`, process.env.BRAIN_CLAUDE_DIR]);
  const grepCommon = best("/usr/bin/grep", ["-rl", "checkout", process.env.BRAIN_CLAUDE_DIR]);
  const rgRare = best("rg", ["-l", `zq${n - 1}x`, process.env.BRAIN_CLAUDE_DIR]);
  global.gc?.();
  out.corpus.push({ sessions: n, files, totalMB: r1(bytes / 2 ** 20), coldIndexMs: r1(cold), perSessionColdMs: r2(cold / n), warmIndexMs: r1(warm), listFilesMs: r1(list), indexCacheKB: r1(cacheKB), searchRareMs: r1(rare), searchCommonMs: r1(common), searchTwoTermsMs: r1(two), searchNoMatchMs: r1(none), grepRareMs: grepRare && r1(grepRare), grepCommonMs: grepCommon && r1(grepCommon), rgRareMs: rgRare && r1(rgRare), rssMB: Math.round(process.memoryUsage().rss / 2 ** 20) });
}
rmSync(process.env.BRAIN_CLAUDE_DIR, { recursive: true, force: true });

// 2. One session, growing size.
for (const msgs of [10, 100, 1000, 10000]) {
  const dir = join(WORK, "one"); rmSync(dir, { recursive: true, force: true }); mkdirSync(join(dir, "p"), { recursive: true });
  const path = join(dir, "p", "a.jsonl"); writeFileSync(path, sessionLines(1, msgs, "zq1x"));
  const bytes = statSync(path).size;
  const parse = await time(() => parseSession(path), 5);
  const s = parseSession(path);
  const body = JSON.stringify(s);
  out.session.push({ messages: msgs, fileKB: r1(bytes / 1024), parseMs: r2(parse), parseMBps: r1((bytes / 2 ** 20) / (parse / 1000)), sharePayloadKB: r1(body.length / 1024), shareGzipKB: r1(gzipSync(body).length / 1024), underShareLimit: body.length < 5 * 2 ** 20 });
}

// 3. Redaction: planted secrets (all fake), how many are hidden, how fast.
const planted = [
  ["aws access key", "AKIA" + "ABCDEFGHIJKLMNOP"], ["github token", "ghp_" + "a".repeat(36)], ["github oauth", "gho_" + "b".repeat(36)], ["anthropic key", "sk-ant-" + "c".repeat(30)],
  ["stripe live", "sk_live_" + "d".repeat(24)], ["stripe test", "sk_test_" + "e".repeat(24)], ["openai-style key", "sk-" + "f".repeat(40)], ["private key", "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----"],
  ["bearer token", "Bearer " + "g".repeat(40)], ["email", "jane.doe@example.com"], ["home path (mac)", "/Users/jane/work"], ["home path (linux)", "/home/jane/work"], ["url", "https://internal.example.com/a?token=1"], ["markdown link", "[docs](https://example.com/x)"],
];
let hidden = 0; const detail = [];
for (const [name, secret] of planted) { const o = redact("see " + secret + " end"); const ok = !o.includes(secret.slice(0, 12)) || name === "markdown link"; if (name === "markdown link" ? o.includes("docs") && !o.includes("example.com") : ok) hidden++; detail.push({ name, hidden: name === "markdown link" ? o.includes("docs") && !o.includes("example.com") : ok }); }
const big = (words(2000) + " ghp_" + "a".repeat(36) + " user@example.com /Users/jane/x ").repeat(60);
const rt = await time(() => redact(big), 5);
out.redaction = { planted: planted.length, hidden, detail, textKB: r1(big.length / 1024), redactMs: r2(rt), redactMBps: r1((big.length / 2 ** 20) / (rt / 1000)) };
const tp = await time(() => tidyPaths("edit /Users/jane/proj/src/a.js and /etc/hosts and /Users/jane/proj/b.js", "/Users/jane/proj"), 50);
out.share = { limitMB: 5, tidyPathsMicros: Math.round(tp * 1000), tidyExample: tidyPaths("edit /Users/jane/proj/src/a.js and /etc/hosts", "/Users/jane/proj") };

writeFileSync(join(new URL("..", import.meta.url).pathname, "bench", "results.json"), JSON.stringify(out, null, 2));
copyFileSync(join(new URL("..", import.meta.url).pathname, "bench", "results.json"), join(new URL("..", import.meta.url).pathname, "landing", "bench.json"));
rmSync(WORK, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1).slice(0, 6000));

// North star (read by `gel north-star`): common-word search over 5,000 saved sessions, Brain vs `grep -rl`.
const big5 = out.corpus.at(-1);
writeFileSync(join(new URL("..", import.meta.url).pathname, "docs", "north-star", "result.json"), JSON.stringify({ value: big5.searchCommonMs, baseline: big5.grepCommonMs, unit: "ms", measuredAt: new Date().toISOString(), sessions: big5.sessions }, null, 2) + "\n");
