import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { KINDS, countSessions, inventory, kindOf, listSessions, measure, scanSettings } from "../src/inventory.mjs";
import { snapshot } from "../src/walk.mjs";
import { IS_WIN, put, seedConfig, tmpDir, world } from "./helpers.mjs";

test("every named entry of the config folder is sorted into its kind, in any letter case", () => {
  const table = {
    settings: ["settings.json", "settings.local.json", "keybindings.json", "CLAUDE.md", "claude.md", "skills", "agents", "commands", "hooks", "rules", "output-styles", "themes", "statusline.sh", "statusline-command.sh", "status-line.ps1", "StatusLine.js"],
    sessions: ["projects", "Projects"],
    plugins: ["plugins"],
    claudeJson: [".claude.json"],
    ours: ["relocate-manifest.json"],
    state: ["file-history", "session-env", "uploads", "tasks", "todos", "shell-snapshots", "backups", "debug", "statsig", "usage-data", "history.jsonl", "sessions", "ide", "plans", "paste-cache", "cache", "telemetry", ".credentials.json", ".last-cleanup", "whatever", "status.txt"],
  };
  for (const [kind, names] of Object.entries(table)) for (const n of names) assert.equal(kindOf(n), kind, n);
});

test("a folder that a hook or the status line points into counts as settings, whatever it is called", () => {
  assert.equal(kindOf("glow", new Set()), "state");
  assert.equal(kindOf("glow", new Set(["glow"])), "settings");
  assert.equal(kindOf("Glow", new Set(["glow"])), "settings");
});

test("measure adds up files in folders, and a link is a link: its target is not followed or counted", () => {
  const dir = tmpDir();
  put(path.join(dir, "a", "one.txt"), "12345");
  put(path.join(dir, "a", "b", "two.txt"), "1234567890");
  const elsewhere = tmpDir();
  put(path.join(elsewhere, "big.bin"), "x".repeat(100000));
  fs.symlinkSync(elsewhere, path.join(dir, "link"), IS_WIN ? "junction" : "dir");
  assert.deepEqual(measure(path.join(dir, "a")), { bytes: 15, files: 2, links: 0 });
  assert.deepEqual(measure(dir), { bytes: 15, files: 2, links: 1 });
  assert.deepEqual(measure(path.join(dir, "nothing")), { bytes: 0, files: 0, links: 0 });
});

test("inventory of a used config folder: sizes per kind add up to the total, and the manifest is not counted", () => {
  const w = seedConfig(world("inv"));
  put(path.join(w.cfg, "relocate-manifest.json"), "{}");
  const inv = inventory(w.cfg, { referenced: new Set(["tool"]) });
  assert.deepEqual(Object.keys(inv.kinds), KINDS);
  const sum = KINDS.reduce((n, k) => n + inv.kinds[k].bytes, 0);
  assert.equal(sum, inv.total.bytes);
  assert.equal(KINDS.reduce((n, k) => n + inv.kinds[k].files, 0), inv.total.files);
  assert.ok(inv.kinds.settings.entries.includes("hooks"));
  assert.ok(inv.kinds.settings.entries.includes("statusline.sh"));
  assert.ok(inv.kinds.settings.entries.includes("tool"), "the folder the hook runs a script from");
  assert.deepEqual(inv.kinds.sessions.entries, ["projects"]);
  assert.deepEqual(inv.kinds.plugins.entries, ["plugins"]);
  for (const n of ["file-history", "session-env", "todos", "uploads", "tasks", "statsig", "usage-data", "history.jsonl", "ide"]) assert.ok(inv.kinds.state.entries.includes(n), n);
  assert.deepEqual(inv.kinds.claudeJson.entries, [".claude.json"]);
  assert.ok(inv.entries.some((e) => e.name === "relocate-manifest.json" && e.kind === "ours"));
  assert.ok(!KINDS.some((k) => inv.kinds[k].entries.includes("relocate-manifest.json")));
  const plugins = inv.entries.find((e) => e.name === "plugins");
  assert.equal(plugins.type, "dir");
  assert.ok(plugins.bytes < 1000, "plugins/ is counted without its cache");
  const cache = inv.entries.find((e) => e.name === "plugins/cache");
  assert.deepEqual([cache.kind, cache.type, cache.bytes, cache.files], ["pluginCache", "dir", 4000, 1]);
  assert.deepEqual(inv.kinds.pluginCache.entries, ["plugins/cache"]);
});

test("a plugins folder without a cache, or one that is a link, has no plugin cache entry", () => {
  const w = world("inv-nocache");
  put(path.join(w.cfg, "plugins", "installed_plugins.json"), "{}");
  assert.deepEqual(inventory(w.cfg).kinds.pluginCache.entries, []);
  const elsewhere = tmpDir();
  put(path.join(elsewhere, "p", "x.txt"), "x".repeat(500));
  fs.symlinkSync(path.join(elsewhere), path.join(w.cfg, "plugins", "cache"), IS_WIN ? "junction" : "dir");
  const inv = inventory(w.cfg);
  assert.deepEqual(inv.kinds.pluginCache.entries, [], "a linked cache is moved as a link, and what it points to is not counted");
  assert.equal(inv.kinds.plugins.links, 1);
});

test("listSessions counts the .jsonl files directly inside each project folder, newest first, and never reads them", () => {
  const w = seedConfig(world("sess"));
  const list = listSessions(w.cfg);
  assert.equal(list.exists && list.readable, true);
  assert.equal(list.sessions, 3);
  assert.deepEqual(list.projects.map((p) => [p.name, p.sessions]), [["-work-shop", 2], ["-work-blog", 1]]);
  assert.equal(list.newestMs, Date.parse("2026-09-01T10:00:00Z") - 3 * 86400000);
  assert.deepEqual(countSessions(snapshot(w.cfg)), { sessions: 3, projects: 2 });
});

test("listSessions says what is missing, and follows a link to projects/", () => {
  const w = world("sess2");
  fs.mkdirSync(w.cfg, { recursive: true });
  assert.deepEqual(listSessions(w.cfg), { path: path.join(w.cfg, "projects"), exists: false, isLink: false, readable: false, projects: [], sessions: 0, newestMs: null });
  const elsewhere = tmpDir();
  put(path.join(elsewhere, "-p", "a.jsonl"), "{}\n", 5000);
  put(path.join(elsewhere, "-p", "b.txt"), "no");
  put(path.join(elsewhere, "-p", "a", "subagents", "agent.jsonl"), "{}\n");
  fs.symlinkSync(elsewhere, path.join(w.cfg, "projects"), IS_WIN ? "junction" : "dir");
  const list = listSessions(w.cfg);
  assert.deepEqual([list.isLink, list.readable, list.sessions, list.projects.length], [true, true, 1, 1], "only a.jsonl is a session");
  fs.rmSync(elsewhere, { recursive: true });
  const gone = listSessions(w.cfg);
  assert.deepEqual([gone.exists, gone.isLink, gone.readable], [true, true, false], "a link that leads nowhere is not readable");
});

test("a .claude.json next to the folder is counted under .claude.json, a link in the folder is listed as a link", () => {
  const w = world("inv2", { variable: false });
  put(path.join(w.cfg, "settings.json"), "{}");
  put(w.claudeJson, "x".repeat(123));
  const elsewhere = tmpDir();
  put(path.join(elsewhere, "f"), "data");
  fs.symlinkSync(elsewhere, path.join(w.cfg, "projects"), IS_WIN ? "junction" : "dir");
  const inv = inventory(w.cfg, { claudeJsonOutside: w.claudeJson });
  assert.equal(inv.kinds.claudeJson.bytes, 123);
  assert.equal(inv.kinds.claudeJson.files, 1);
  const projects = inv.entries.find((e) => e.name === "projects");
  assert.equal(projects.type, "link");
  assert.equal(path.resolve(projects.target).toLowerCase(), path.resolve(elsewhere).toLowerCase());
  assert.equal(inv.kinds.sessions.bytes, 0, "what the link points to is not counted");
  assert.equal(inv.total.links, 1);
});

test("scanSettings finds the lines that spell the config folder, with JSON-escaped backslashes, and the folders hooks run scripts from", () => {
  const w = world("scan");
  const cfg = w.cfg;
  const settings = {
    statusLine: { type: "command", command: `bash ${path.join(cfg, "statusline.sh")}` },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node "${path.join(cfg, "guard", "check.mjs")}"` }] }], SessionStart: [{ hooks: [{ type: "command", command: "node", args: [path.join(cfg, "tool", "run.mjs"), "go"] }] }] },
    env: { FOO: "bar" },
  };
  put(path.join(cfg, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  const r = scanSettings(cfg, { isDefault: false });
  assert.equal(r.references.length, 3);
  assert.ok(r.references.every((x) => x.file === "settings.json" && x.line > 0 && x.text.includes(cfg)));
  assert.deepEqual([...r.entries].sort(), ["guard", "statusline.sh", "tool"]);
});

test("scanSettings counts ~/.claude only when the config folder is the default one, and reads settings.local.json too", () => {
  const w = world("scan2", { variable: false });
  put(path.join(w.cfg, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "sh ~/.claude/hooks/done.sh" }] }] } }, null, 2));
  put(path.join(w.cfg, "settings.local.json"), JSON.stringify({ statusLine: { type: "command", command: "$HOME/.claude/line.sh" } }, null, 2));
  const dflt = scanSettings(w.cfg, { isDefault: true });
  assert.equal(dflt.references.length, 2);
  assert.deepEqual([...dflt.entries].sort(), ["hooks", "line.sh"]);
  const custom = scanSettings(w.cfg, { isDefault: false });
  assert.equal(custom.references.length, 0, "a custom config folder is not ~/.claude");
});

test("scanSettings copes with settings that are not JSON, not an object, missing, or have odd hooks", () => {
  const dir = tmpDir();
  assert.deepEqual(scanSettings(dir).references, []);
  put(path.join(dir, "settings.json"), "{ not json at all " + dir);
  assert.equal(scanSettings(dir).references.length, 1, "a line is a line, valid JSON or not");
  put(path.join(dir, "settings.json"), "[1,2,3]");
  assert.equal(scanSettings(dir).entries.size, 0);
  put(path.join(dir, "settings.json"), JSON.stringify({ hooks: { Stop: "nope", Start: [null, { hooks: "x" }, { hooks: [null, 7, { command: 5 }] }] }, statusLine: 3 }));
  assert.equal(scanSettings(dir).entries.size, 0);
});
