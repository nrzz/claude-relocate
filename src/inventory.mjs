// What is in a Claude Code config folder, sorted into the kinds `plan` reports. Only names, sizes and file times
// are read (never the text of a session), except settings.json and settings.local.json, which are read to find
// the hook and status line scripts that live in the folder and the places that mention its path.
import path from "node:path";
import fs from "node:fs";
import { forwardSlashes, listDir, statOf, tryParse } from "./util.mjs";

export const KINDS = ["settings", "sessions", "plugins", "pluginCache", "state", "claudeJson"];
export const KIND_LABEL = { settings: "settings", sessions: "sessions", plugins: "plugins", pluginCache: "plugin cache", state: "state and caches", claudeJson: ".claude.json" };

// User-written configuration. Compared lower-case: Windows and macOS file systems ignore the case.
const SETTINGS_FILES = new Set(["settings.json", "settings.local.json", "keybindings.json", "claude.md"]);
const SETTINGS_DIRS = new Set(["skills", "agents", "commands", "hooks", "rules", "output-styles", "themes"]);
const STATUS_LINE = /^status[-_]?line/i;

// What `move --xdg` puts in the state and the cache folders on Linux and macOS (README, "How it works").
export const STATE_PARTS = ["projects", "file-history", "session-env", "uploads", "tasks", "todos", "shell-snapshots", "backups", "debug"];
export const PLUGIN_CACHE = "plugins/cache";
export const CACHE_PARTS = [PLUGIN_CACHE, "statsig", "usage-data"];

export const MANIFEST_NAME = "relocate-manifest.json";
export const CLAUDE_JSON = ".claude.json";

// The kind of a top-level entry of the config folder. `referenced` holds the names that settings.json points a
// hook or the status line at.
export function kindOf(name, referenced = new Set()) {
  const n = name.toLowerCase();
  if (n === CLAUDE_JSON) return "claudeJson";
  if (n === MANIFEST_NAME) return "ours";
  if (n === "projects") return "sessions";
  if (n === "plugins") return "plugins";
  if (SETTINGS_FILES.has(n) || SETTINGS_DIRS.has(n) || STATUS_LINE.test(n)) return "settings";
  if (referenced.has(n)) return "settings";
  return "state";
}

// Size of a file, or of everything below a folder. Links are counted as links and never followed.
// Returns { bytes, files, links }.
export function measure(p) {
  const st = statOf(p);
  if (!st) return { bytes: 0, files: 0, links: 0 };
  if (st.isSymbolicLink()) return { bytes: 0, files: 0, links: 1 };
  if (!st.isDirectory()) return { bytes: st.size, files: 1, links: 0 };
  let bytes = 0;
  let files = 0;
  let links = 0;
  for (const e of listDir(p)) {
    const m = measure(path.join(p, e.name));
    bytes += m.bytes;
    files += m.files;
    links += m.links;
  }
  return { bytes, files, links };
}

// The session transcripts below a config folder: a session is a .jsonl file directly inside a project folder of
// projects/ (the sub-agent transcripts one level deeper are not sessions). Reads names and file times, never the
// text of a transcript. Follows links, so it also lists a projects/ that --xdg moved behind a link.
//   { path, exists, isLink, readable, projects: [{ name, sessions, newestMs }] newest first, sessions, newestMs }
export function listSessions(configDir) {
  const root = path.join(configDir, "projects");
  const st = statOf(root);
  const out = { path: root, exists: !!st, isLink: !!st && st.isSymbolicLink(), readable: false, projects: [], sessions: 0, newestMs: null };
  if (!st) return out;
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return out; }
  out.readable = true;
  for (const name of dirs) {
    let files;
    try { files = fs.readdirSync(path.join(root, name)); } catch { continue; }
    let sessions = 0;
    let newestMs = null;
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      let s;
      try { s = fs.statSync(path.join(root, name, f)); } catch { continue; }
      if (!s.isFile()) continue;
      sessions++;
      if (newestMs === null || s.mtimeMs > newestMs) newestMs = s.mtimeMs;
    }
    if (!sessions) continue;
    out.projects.push({ name, sessions, newestMs });
    out.sessions += sessions;
    if (out.newestMs === null || newestMs > out.newestMs) out.newestMs = newestMs;
  }
  out.projects.sort((a, b) => b.newestMs - a.newestMs || (a.name < b.name ? -1 : 1));
  return out;
}

// How many sessions a snapshot (see walk.mjs) of a config folder holds, and in how many projects.
export function countSessions(snap) {
  const projects = new Set();
  let sessions = 0;
  for (const [rel, row] of snap.entries) {
    const m = /^projects\/([^/]+)\/[^/]+\.jsonl$/.exec(rel);
    if (m && row.t === "f") { sessions++; projects.add(m[1]); }
  }
  return { sessions, projects: projects.size };
}

// ---------------------------------------------------------------------------------------------
// settings.json: scripts in the folder and mentions of its path
// ---------------------------------------------------------------------------------------------

// Every string a hook or the status line would run: statusLine.command and each hook's command and args.
function commandStrings(settings) {
  const out = [];
  const push = (v) => { if (typeof v === "string") out.push(v); };
  if (settings && typeof settings === "object") {
    if (settings.statusLine && typeof settings.statusLine === "object") push(settings.statusLine.command);
    const hooks = settings.hooks;
    if (hooks && typeof hooks === "object") {
      for (const groups of Object.values(hooks)) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) {
            if (!h || typeof h !== "object") continue;
            push(h.command);
            if (Array.isArray(h.args)) h.args.forEach(push);
          }
        }
      }
    }
  }
  return out;
}

// The ways a settings file can name the config folder.
function needlesFor(configDir, isDefault) {
  const list = [configDir, forwardSlashes(configDir)];
  if (isDefault) list.push("~/.claude", "$HOME/.claude", "${HOME}/.claude", "%USERPROFILE%\\.claude", "%USERPROFILE%/.claude", "$USERPROFILE/.claude", "$env:USERPROFILE\\.claude");
  return [...new Set(list)];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// { references: [{ file, line, text }], entries: Set of top-level names a hook or the status line points into }.
// A reference is a line of settings.json or settings.local.json that spells the config folder's path.
export function scanSettings(configDir, { isDefault = false } = {}) {
  const needles = needlesFor(configDir, isDefault);
  const flags = process.platform === "win32" || process.platform === "darwin" ? "i" : "";
  const nameRe = new RegExp(`(?:${needles.map(escapeRe).join("|")})[\\\\/]+([^\\\\/\\s"'\`)]+)`, flags);
  const anyRe = new RegExp(needles.map(escapeRe).join("|"), flags);
  const references = [];
  const entries = new Set();
  for (const file of ["settings.json", "settings.local.json"]) {
    let raw;
    try { raw = fs.readFileSync(path.join(configDir, file), "utf8"); } catch { continue; }
    const lines = raw.replace(/^﻿/, "").split(/\r?\n/);
    lines.forEach((line, i) => {
      const plain = line.replace(/\\\\/g, "\\");
      if (anyRe.test(plain)) references.push({ file, line: i + 1, text: plain.trim().slice(0, 160) });
    });
    const settings = tryParse(raw.replace(/^﻿/, ""));
    for (const cmd of commandStrings(settings)) {
      const m = nameRe.exec(cmd);
      if (m) entries.add(m[1].toLowerCase());
    }
  }
  return { references, entries };
}

// ---------------------------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------------------------

// Reads the top level of a config folder.
//   entries  [{ name, type: "dir"|"file"|"link", kind, bytes, files, links, target? }] sorted by name. The plugin
//            cache, plugins/cache, is its own entry of the kind pluginCache (it is by far the biggest part of
//            plugins/ and the part --xdg sends to the cache folder); plugins/ is counted without it.
//   kinds    { settings|sessions|plugins|pluginCache|state|claudeJson: { bytes, files, links, entries: [name] } }
//   total    { bytes, files, links }
// `claudeJsonOutside` is the .claude.json that sits next to the folder (the variable is not set); it is counted
// under claudeJson. relocate-manifest.json (this tool's own file) is listed with the kind "ours" and not counted.
export function inventory(configDir, { referenced = new Set(), claudeJsonOutside = "" } = {}) {
  const entries = [];
  for (const e of listDir(configDir)) {
    const p = path.join(configDir, e.name);
    const st = statOf(p);
    if (!st) continue;
    const m = measure(p);
    const row = {
      name: e.name,
      type: st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file",
      kind: kindOf(e.name, referenced),
      bytes: m.bytes, files: m.files, links: m.links,
    };
    if (row.type === "link") { try { row.target = fs.readlinkSync(p); } catch { /* unreadable link */ } }
    entries.push(row);
    if (row.kind === "plugins" && row.type === "dir") {
      const cache = statOf(path.join(p, "cache"));
      if (cache && cache.isDirectory() && !cache.isSymbolicLink()) {
        const c = measure(path.join(p, "cache"));
        row.bytes -= c.bytes; row.files -= c.files; row.links -= c.links;
        entries.push({ name: PLUGIN_CACHE, type: "dir", kind: "pluginCache", bytes: c.bytes, files: c.files, links: c.links });
      }
    }
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (claudeJsonOutside) {
    const st = statOf(claudeJsonOutside);
    if (st) entries.push({ name: CLAUDE_JSON, type: st.isSymbolicLink() ? "link" : "file", kind: "claudeJson", bytes: st.isSymbolicLink() ? 0 : st.size, files: st.isSymbolicLink() ? 0 : 1, links: st.isSymbolicLink() ? 1 : 0, outside: true });
  }
  const kinds = Object.fromEntries(KINDS.map((k) => [k, { bytes: 0, files: 0, links: 0, entries: [] }]));
  const total = { bytes: 0, files: 0, links: 0 };
  for (const r of entries) {
    if (r.kind === "ours") continue;
    const k = kinds[r.kind];
    k.bytes += r.bytes; k.files += r.files; k.links += r.links; k.entries.push(r.name);
    total.bytes += r.bytes; total.files += r.files; total.links += r.links;
  }
  return { entries, kinds, total };
}
