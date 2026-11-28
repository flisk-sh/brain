// Adapter: Claude Code (~/.claude/projects/*/*.jsonl) -> Brain's common session format.
import { readdirSync, statSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { redact } from "./redact.mjs";

export const ROOT = process.env.BRAIN_CLAUDE_DIR || join(homedir(), ".claude", "projects");

export function listFiles(root = ROOT) {
  const out = [];
  let dirs = [];
  try { dirs = readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    const dir = join(root, d);
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const path = join(dir, f);
      const st = statSync(path);
      out.push({ id: basename(f, ".jsonl"), path, size: st.size, mtime: st.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function blocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

// Drop harness noise so a session reads like a conversation.
function cleanUserText(t) {
  return t
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, "$1")
    .trim();
}

export function parseSession(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  const s = { id: basename(path, ".jsonl"), agent: "claude-code", model: null, cwd: null, branch: null, start: null, end: null, title: null, messages: [], files: [] };
  const files = new Set();
  for (const line of lines) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "custom-title" && d.customTitle) s.title = d.customTitle;
    if (d.type !== "user" && d.type !== "assistant") continue;
    if (d.isSidechain) continue;
    if (d.timestamp) { s.start ??= d.timestamp; s.end = d.timestamp; }
    s.cwd ??= d.cwd; s.branch = d.gitBranch || s.branch;
    const m = d.message || {};
    if (m.model && m.model !== "<synthetic>") s.model = m.model;
    const msg = { role: d.type, time: d.timestamp, text: "", tools: [] };
    for (const b of blocks(m.content)) {
      if (b.type === "text") msg.text += (msg.text ? "\n" : "") + (d.type === "user" ? cleanUserText(b.text) : b.text);
      else if (b.type === "tool_use") {
        const inp = b.input || {};
        const f = inp.file_path || inp.path || inp.notebook_path;
        if (f && /^(Edit|Write|NotebookEdit|MultiEdit)$/.test(b.name)) files.add(f);
        msg.tools.push({ name: b.name, summary: redact(String(inp.command || inp.file_path || inp.pattern || inp.description || inp.url || "").slice(0, 300)) });
      }
    }
    msg.text = redact(msg.text);
    if (msg.text || msg.tools.length) s.messages.push(msg);
  }
  s.files = [...files];
  const firstUser = s.messages.find((m) => m.role === "user" && m.text);
  s.title ||= shortTitle(firstUser?.text || "(empty session)");
  return s;
}

export function summarize(f) {
  // Light pass for the list: the first prompt, project, times. Full parse only on open.
  const s = parseSession(f.path);
  return { id: s.id, agent: s.agent, model: s.model, cwd: s.cwd, branch: s.branch, start: s.start, end: s.end, title: s.title,
    messages: s.messages.length, tools: s.messages.reduce((n, m) => n + m.tools.length, 0), files: s.files.length };
}

// Files that contain `term` anywhere, found by ripgrep when it is installed (about 6x faster than scanning in JS).
// Returns null when ripgrep is missing or fails, so the caller falls back to its own scan.
function ripgrepCandidates(term, files) {
  const dirs = [...new Set(files.map((f) => dirname(f.path)))];
  if (!dirs.length || dirs.length > 2000) return null;
  const r = spawnSync("rg", ["-l", "-i", "-F", "--glob", "*.jsonl", "--", term, ...dirs], { encoding: "utf8", maxBuffer: 64 * 2 ** 20 });
  if (r.error || (r.status !== 0 && r.status !== 1)) return null;
  return new Set(r.stdout.split("\n").filter(Boolean));
}

// Recently read files, so repeat searches in a long-running `brain serve` skip the disk. Keyed by path, mtime and size
// (a changed file is read again) and capped at 32 MB, oldest entry out first.
// A file's score counts matching messages up to this many; past it, more matches no longer change the order shown.
const SCORE_CAP = 5;
const RAW = new Map(); let rawBytes = 0;
function readCached(f) {
  const key = `${f.path}:${f.mtime}:${f.size}`;
  let raw = RAW.get(key);
  if (raw !== undefined) return raw;
  raw = readFileSync(f.path, "utf8");
  RAW.set(key, raw); rawBytes += raw.length;
  for (const [k, v] of RAW) { if (rawBytes <= 32 * 2 ** 20) break; RAW.delete(k); rawBytes -= v.length; }
  return raw;
}

export async function search(query, files, limit = 30) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  if (!terms.length) return hits;
  // A common word fills the result list from the newest files, so scan those directly. Only when the list is still
  // short after 150 files (a rare word) is it worth asking ripgrep which of the remaining files contain it.
  const re = new RegExp(terms[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  let candidates = null, seen = 0;
  for (const f of files) {
    if (hits.length >= limit) break;
    if (++seen === 150 && !process.env.BRAIN_NO_RG) candidates = ripgrepCandidates(terms[0], files.slice(149));
    if (candidates && !candidates.has(f.path)) continue;
    let raw;
    try { raw = readCached(f); } catch { continue; }
    // Find lines through a case-insensitive scan of the whole file for the first word (fast), then check only those lines.
    re.lastIndex = 0;
    let score = 0, snippet = null, m;
    while (score < SCORE_CAP && (m = re.exec(raw))) {
      const start = raw.lastIndexOf("\n", m.index) + 1;
      let end = raw.indexOf("\n", m.index);
      if (end < 0) end = raw.length;
      re.lastIndex = end;
      const line = raw.slice(start, end);
      const low = line.toLowerCase();
      if (!terms.every((t) => low.includes(t))) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (d.type !== "user" && d.type !== "assistant") continue;
      if (d.isSidechain) continue;
      const text = blocks(d.message?.content).map((b) => b.text || "").join(" ");
      const lt = text.toLowerCase();
      if (!terms.every((t) => lt.includes(t))) continue;
      score++;
      if (!snippet) {
        const i = lt.indexOf(terms[0]);
        snippet = redact(text.slice(Math.max(0, i - 80), i + 160).replace(/\s+/g, " "));
      }
    }
    if (score) hits.push({ id: f.id, path: f.path, score, snippet });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// First line of the prompt, cut at a word with an ellipsis (never mid-word, never an open bracket).
export function shortTitle(text, max = 90) {
  const t = String(text).replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max).replace(/\s+\S*$/, "").replace(/[\s(\[{"'`,;:-]+$/, "");
  return (cut || t.slice(0, max)) + "…";
}
