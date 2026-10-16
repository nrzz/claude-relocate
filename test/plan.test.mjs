import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildPlan, describeProcesses } from "../src/plan.mjs";
import { KINDS } from "../src/inventory.mjs";
import { VERSION } from "../src/version.mjs";
import { IS_WIN, everything, noFileLinks, put, run, runJson, seedConfig, secondDriveAt, tmpDir, world } from "./helpers.mjs";

const plan = (w, opts = {}, sys) => buildPlan({ env: w.env, cwd: w.base, sys: sys || w.sys(), opts });
const codes = (model) => model.problems.map((p) => p.code);
// The platform the POSIX-only logic is tried on when the machine is Windows: the files are real, the platform is the sys's.
const LINUX = IS_WIN ? "linux" : process.platform;

test("plan with no destination reads the config folder: sizes per kind, the total, the files by name, nothing written", async () => {
  const w = seedConfig(world("plan1"));
  const before = everything(w);
  const m = plan(w);
  assert.equal(m.destination, null);
  assert.deepEqual(m.problems, []);
  assert.equal(m.origin.configDir, w.cfg);
  assert.equal(m.origin.source, "CLAUDE_CONFIG_DIR");
  assert.equal(m.origin.exists, true);
  assert.equal(m.origin.claudeJsonInside, true);
  assert.deepEqual(m.kinds.map((k) => k.kind), KINDS);
  const kind = Object.fromEntries(m.kinds.map((k) => [k.kind, k]));
  assert.deepEqual(kind.sessions.entries, ["projects"]);
  assert.equal(kind.sessions.files, 4);
  assert.equal(kind.pluginCache.bytes, 4000, "the plugin cache is its own kind");
  assert.deepEqual(kind.pluginCache.entries, ["plugins/cache"]);
  assert.equal(kind.claudeJson.files, 1);
  assert.equal(m.kinds.reduce((n, k) => n + k.bytes, 0), m.total.bytes, "the kinds add up to the total");
  assert.equal(m.kinds.reduce((n, k) => n + k.files, 0), m.total.files);
  assert.deepEqual(everything(w), before, "plan changes nothing");
  assert.ok(kind.settings.entries.includes("tool"), "the folder a hook runs a script from is settings");
});

test("plan prints the kinds as a table with sizes, a total and what to do next", async () => {
  const w = seedConfig(world("plan2"));
  const r = await run(["plan"], w);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^claude-relocate 1\.0\.0 {2}what would move$/m);
  assert.match(r.out, new RegExp(`^config folder {3}${w.cfg.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")} {2}\\(from CLAUDE_CONFIG_DIR\\)$`, "m"));
  assert.match(r.out, /^ {2}KIND +SIZE +FILES +WHAT$/m);
  for (const label of ["settings", "sessions", "plugins", "plugin cache", "state and caches", ".claude.json", "total"]) assert.match(r.out, new RegExp(`^ {2}${label.replace(".", "\\.")} `, "m"), label);
  assert.match(r.out, /sessions +\d+ KB +4 +projects\//);
  assert.match(r.out, /plugin cache +4 KB +1 +plugins\/cache\//);
  assert.match(r.out, /Pass --to <folder> or --xdg to see where it would go/);
  assert.equal(r.err, "");
  assert.ok(!/\p{Extended_Pictographic}/u.test(r.out), "no emoji");
  assert.ok(!r.out.includes("\x1b["), "no colour codes when not on a terminal");
});

test("plan --json is one document with the fields the setup page reads", async () => {
  const w = seedConfig(world("plan3"));
  const r = await runJson(["plan", "--to", w.dest], w);
  assert.equal(r.code, 0, r.all);
  const j = r.json;
  assert.deepEqual(Object.keys(j).sort(), ["command", "destination", "entries", "env", "home", "kinds", "links", "ok", "origin", "platform", "problems", "processes", "references", "schema", "space", "tool", "total", "version", "warnings"]);
  assert.deepEqual([j.schema, j.tool, j.version, j.command, j.ok, j.platform], [1, "claude-relocate", VERSION, "plan", true, process.platform]);
  assert.deepEqual(Object.keys(j.origin).sort(), ["claudeJson", "claudeJsonExists", "claudeJsonInside", "claudeJsonIsLink", "configDir", "exists", "isLink", "linkTarget", "relocated", "source"]);
  assert.deepEqual(Object.keys(j.kinds[0]).sort(), ["bytes", "destination", "entries", "files", "kind", "label", "links"]);
  assert.deepEqual(Object.keys(j.destination).sort(), ["cache", "cacheExisted", "claudeJson", "config", "existedBefore", "groups", "method", "mode", "parts", "requested", "state", "stateExisted"]);
  assert.equal(j.destination.config, w.dest);
  assert.equal(j.destination.requested, "to");
  assert.deepEqual(Object.keys(j.space[0]).sort(), ["copy", "freeBytes", "needBytes", "ok", "path", "paths"]);
  assert.deepEqual(Object.keys(j.env).sort(), ["notWritten", "profiles", "registry", "skipped", "variable"]);
  assert.equal(r.err, "");
});

test("plan exits 1 and says why when the config folder is missing, with or without the variable", async () => {
  const w = world("plan4");
  for (const variable of [true, false]) {
    const x = variable ? w : world("plan4b", { variable: false });
    const r = await runJson(["plan"], x);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.deepEqual(r.json.problems.map((p) => p.code), ["no-config"]);
    assert.match(r.json.problems[0].message, /^There is no Claude Code config folder at /);
    assert.equal(/CLAUDE_CONFIG_DIR is not set, so ~\/\.claude is used/.test(r.json.problems[0].message), !variable);
  }
});

test("plan refuses a config folder that is itself a link, naming where it points", () => {
  const w = world("plan5");
  const real = tmpDir();
  put(path.join(real, "settings.json"), "{}");
  fs.symlinkSync(real, w.cfg, IS_WIN ? "junction" : "dir");
  const m = plan(w);
  assert.deepEqual(codes(m), ["origin-is-link"]);
  assert.equal(m.origin.isLink, true);
  assert.equal(path.resolve(m.origin.linkTarget).toLowerCase(), real.toLowerCase());
  assert.match(m.problems[0].message, /Move the folder it points to instead/);
});

test("plan refuses a ~/.claude.json that is a link: moving it would replace the link", { skip: noFileLinks() }, () => {
  const w = seedConfig(world("plan6", { variable: false }), { claudeJson: false });
  const real = put(path.join(w.base, "dotfiles", "claude.json"), "{}");
  fs.symlinkSync(real, w.claudeJson, "file");
  const m = plan(w, { to: w.dest });
  assert.ok(codes(m).includes("claude-json-is-link"));
  assert.equal(m.origin.claudeJsonIsLink, true);
});

test("without the variable, .claude.json is next to the folder, counted with it, and --to puts it inside the new folder", () => {
  const w = seedConfig(world("plan7", { variable: false }));
  const m = plan(w, { to: w.dest });
  assert.equal(m.origin.configDir, path.join(w.home, ".claude"));
  assert.equal(m.origin.source, "default");
  assert.equal(m.origin.claudeJson, path.join(w.home, ".claude.json"));
  assert.equal(m.origin.claudeJsonInside, false);
  assert.equal(m.kinds.find((k) => k.kind === "claudeJson").files, 1);
  assert.equal(m.destination.claudeJson, path.join(w.dest, ".claude.json"));
  assert.deepEqual(m.problems, []);
});

test("--to: a new folder on the same drive is planned as a rename that needs almost no room", () => {
  const w = seedConfig(world("plan8"));
  const m = plan(w, { to: w.dest });
  assert.deepEqual(m.problems, []);
  const T = m.destination;
  assert.deepEqual([T.requested, T.mode, T.method, T.existedBefore, T.state, T.cache, T.parts], ["to", "single", "rename", false, null, null, []]);
  assert.equal(T.groups.length, 1);
  assert.equal(m.space.length, 1);
  assert.deepEqual([m.space[0].copy, m.space[0].ok, m.space[0].needBytes], [false, true, 1048576]);
  assert.ok(m.space[0].freeBytes > 0);
  assert.ok(m.kinds.every((k) => !k.entries.length || k.destination === "config"));
});

test("--to resolves a relative folder against the working folder, and ~ against the home folder", () => {
  const w = seedConfig(world("plan9"));
  assert.equal(plan(w, { to: path.join("out", "claude data") }).destination.config, path.join(w.base, "out", "claude data"));
  assert.equal(plan(w, { to: "~/moved" }).destination.config, path.join(w.home, "moved"));
  assert.equal(plan(w, { to: "~" }).destination.config, w.home, "the home folder itself resolves; it is not empty or outside the origin problems that decide");
});

test("--to a folder with spaces and non-ASCII letters is fine", () => {
  const w = seedConfig(world("plan10"));
  const dest = path.join(w.base, "Mein Ordner", "Café Données 日本");
  const m = plan(w, { to: dest });
  assert.deepEqual(m.problems, []);
  assert.equal(m.destination.config, dest);
  assert.equal(m.env.variable, dest);
});

test("--to an empty existing folder is allowed and noted; a folder with anything in it is refused", () => {
  const w = seedConfig(world("plan11"));
  fs.mkdirSync(w.dest);
  const m = plan(w, { to: w.dest });
  assert.deepEqual(m.problems, []);
  assert.equal(m.destination.existedBefore, true);
  put(path.join(w.dest, "something.txt"), "x");
  const n = plan(w, { to: w.dest });
  assert.deepEqual(codes(n), ["destination-not-empty"]);
  assert.match(n.problems[0].message, /exists and is not empty \(1 item\)\. Choose a new or empty folder\.$/);
});

test("--to a folder holding an unfinished copy says what that file is", () => {
  const w = seedConfig(world("plan12"));
  put(path.join(w.dest, ".claude-relocate-incomplete"), "x");
  put(path.join(w.dest, "projects", "a"), "x");
  const m = plan(w, { to: w.dest });
  assert.deepEqual(codes(m), ["destination-not-empty"]);
  assert.match(m.problems[0].message, /\(2 items\); it holds an unfinished copy from an earlier run \(\.claude-relocate-incomplete\), which you can delete\./);
});

test("--to the config folder itself, inside it, or a folder that contains it is refused", () => {
  const w = seedConfig(world("plan13"));
  assert.deepEqual(codes(plan(w, { to: w.cfg })), ["same-folder"]);
  assert.deepEqual(codes(plan(w, { to: path.join(w.cfg, "inner", "claude") })), ["destination-in-origin"]);
  assert.match(plan(w, { to: path.join(w.cfg, "inner") }).problems[0].message, /^The destination .* is inside the config folder .*\. Choose a folder outside it\.$/);
  assert.deepEqual(codes(plan(w, { to: w.base })), ["origin-in-destination"], "the folder that holds the config folder");
  assert.match(plan(w, { to: w.base }).problems[0].message, /^The config folder .* is inside the destination .*\. Choose a folder that does not contain it\.$/);
});

test("--to a place that reaches the config folder through a link is seen for what it is", () => {
  const w = seedConfig(world("plan14"));
  const alias = path.join(w.base, "alias");
  fs.symlinkSync(w.cfg, alias, IS_WIN ? "junction" : "dir");
  assert.ok(codes(plan(w, { to: path.join(alias, "deeper") })).includes("destination-in-origin"), "below a link to the config folder");
  assert.ok(codes(plan(w, { to: alias })).includes("destination-is-link") || codes(plan(w, { to: alias })).includes("same-folder"));
});

test("--to a file, a link, the top of a drive, or below a file is refused", () => {
  const w = seedConfig(world("plan15"));
  const file = put(path.join(w.base, "a-file"), "x");
  assert.deepEqual(codes(plan(w, { to: file })), ["destination-is-file"]);
  assert.deepEqual(codes(plan(w, { to: path.join(file, "below") })), ["destination-is-file"]);
  assert.match(plan(w, { to: path.join(file, "below") }).problems[0].message, /cannot be created: .* is a file\.$/);
  const elsewhere = tmpDir();
  const link = path.join(w.base, "link");
  fs.symlinkSync(elsewhere, link, IS_WIN ? "junction" : "dir");
  assert.ok(codes(plan(w, { to: link })).includes("destination-is-link"));
  const root = path.parse(w.base).root;
  const m = plan(w, { to: root });
  assert.deepEqual(codes(m), ["destination-is-root"]);
  assert.match(m.problems[0].message, /is the top of a drive\. Choose a folder on it, such as /);
});

test("--to a folder that cannot be created because its parent is read-only (POSIX)", { skip: IS_WIN && "folder permission bits are POSIX" }, (t) => {
  if (process.getuid && process.getuid() === 0) { t.skip("root can write anywhere"); return; }
  const w = seedConfig(world("plan16"));
  const ro = path.join(w.base, "ro");
  fs.mkdirSync(ro);
  fs.chmodSync(ro, 0o500);
  try {
    assert.deepEqual(codes(plan(w, { to: path.join(ro, "claude") })), ["destination-unwritable"]);
  } finally { fs.chmodSync(ro, 0o700); }
});

test("a copy to another drive is planned as copy-check-delete, and needs the room it will use", () => {
  const w = seedConfig(world("plan17"));
  const sys = w.sys({ drive: secondDriveAt(w.dest), free: () => 10 * 1024 ** 3 });
  const m = plan(w, { to: w.dest }, sys);
  assert.deepEqual(m.problems, []);
  assert.equal(m.destination.method, "copy");
  const s = m.space[0];
  assert.equal(s.copy, true);
  assert.equal(s.path, w.dest);
  assert.equal(s.needBytes, m.total.bytes + 16 * 1048576 + m.total.files * 1024);
  assert.equal(s.freeBytes, 10 * 1024 ** 3);
  assert.equal(s.ok, true);
});

test("no room on the destination drive: refused, saying how much is needed and that a copy needs it twice", async () => {
  const w = seedConfig(world("plan18"));
  const sys = w.sys({ drive: secondDriveAt(w.dest), free: () => 5 * 1048576 });
  const m = plan(w, { to: w.dest }, sys);
  assert.deepEqual(codes(m), ["not-enough-space"]);
  assert.match(m.problems[0].message, /^Not enough free space for .*: about \d+(\.\d)? MB needed, 5\.0 MB free \(a copy to another drive needs the room twice, until the original is removed\)\.$/);
  assert.equal(m.space[0].ok, false);
  const r = await run(["plan", "--to", w.dest], w, { sys });
  assert.equal(r.code, 1);
  assert.match(r.out, /NOT ENOUGH/);
});

test("free space that cannot be read is a note, not a refusal", () => {
  const w = seedConfig(world("plan19"));
  const m = plan(w, { to: w.dest }, w.sys({ free: () => null }));
  assert.deepEqual(m.problems, []);
  assert.equal(m.space[0].freeBytes, null);
  assert.ok(m.warnings.some((x) => /^Could not read the free space where /.test(x)));
});

test("a rename needs only the room for the manifest, even when the drive is almost full", () => {
  const w = seedConfig(world("plan20"));
  assert.deepEqual(plan(w, { to: w.dest }, w.sys({ free: () => 2 * 1048576 })).problems, []);
  assert.deepEqual(codes(plan(w, { to: w.dest }, w.sys({ free: () => 100 }))), ["not-enough-space"]);
});

test("--xdg on Windows puts everything in one folder, $XDG_CONFIG_HOME/claude, and says so", { skip: !IS_WIN && "this is the Windows case" }, () => {
  const w = seedConfig(world("plan21"));
  const m = plan(w, { xdg: true });
  const T = m.destination;
  assert.deepEqual([T.requested, T.mode, T.config, T.state, T.cache], ["xdg", "single", w.xdg.config, null, null]);
  assert.ok(m.warnings.some((x) => /^On Windows --xdg puts everything in one folder, \$XDG_CONFIG_HOME\/claude/.test(x)));
});

test("--xdg splits the state and the cache from the config folder, each behind a link (the platform is Linux)", () => {
  const w = seedConfig(world("plan22", { platform: LINUX }));
  const m = plan(w, { xdg: true });
  assert.deepEqual(m.problems, []);
  const T = m.destination;
  assert.deepEqual([T.requested, T.mode, T.config, T.state, T.cache], ["xdg", "xdg-split", w.xdg.config, w.xdg.state, w.xdg.cache]);
  const parts = Object.fromEntries(T.parts.map((p) => [p.path, p]));
  assert.equal(parts.projects.area, "state");
  assert.equal(parts["plugins/cache"].area, "cache");
  assert.equal(parts.projects.bytes > 0 && parts.projects.files === 4, true);
  assert.equal(parts["plugins/cache"].bytes, 4000);
  assert.deepEqual(T.groups.map((g) => g.area), ["config", "state", "cache"]);
  assert.equal(T.groups.reduce((n, g) => n + g.bytes, 0), m.total.bytes, "the three folders hold everything");
  const dest = Object.fromEntries(m.kinds.map((k) => [k.kind, k.destination]));
  assert.deepEqual(dest, { settings: "config", sessions: "state", plugins: "config", pluginCache: "cache", state: "config and state and cache", claudeJson: "config" });
  assert.equal(m.warnings.filter((x) => /--xdg puts everything in one folder/.test(x)).length, 0);
});

test("--xdg refuses a state or cache folder that is inside the config folder, or already holds a part", () => {
  const w = seedConfig(world("plan23", { platform: LINUX }));
  const inside = { ...w.env, XDG_STATE_HOME: path.join(w.cfg, "state") };
  const m = buildPlan({ env: inside, cwd: w.base, sys: w.sys(), opts: { xdg: true } });
  assert.deepEqual(codes(m), ["destination-in-origin"]);
  assert.match(m.problems[0].message, /^The state folder .* is the config folder or inside it\. Choose another with XDG_STATE_HOME\.$/);
  put(path.join(w.xdg.state, "projects", "old.jsonl"), "x");
  const n = plan(w, { xdg: true });
  assert.deepEqual(codes(n), ["destination-not-empty"]);
  assert.match(n.problems[0].message, /^.*projects exists, so projects cannot be moved there\. Move it away, or choose another state folder with XDG_STATE_HOME\.$/);
});

test("the XDG folders follow XDG_CONFIG_HOME, XDG_STATE_HOME and XDG_CACHE_HOME, and the defaults under the home folder", () => {
  const w = seedConfig(world("plan24", { platform: LINUX }));
  const none = { ...w.env };
  delete none.XDG_CONFIG_HOME; delete none.XDG_STATE_HOME; delete none.XDG_CACHE_HOME;
  const T = buildPlan({ env: none, cwd: w.base, sys: w.sys(), opts: { xdg: true } }).destination;
  assert.deepEqual([T.config, T.state, T.cache], [path.join(w.home, ".config", "claude"), path.join(w.home, ".local", "state", "claude"), path.join(w.home, ".cache", "claude")]);
});

test("running Claude Code is a warning for plan and a refusal for move, unless --ignore-running", () => {
  const w = seedConfig(world("plan25"));
  const busy = w.sys({ processes: () => ({ ok: true, processes: [{ pid: 4242, name: "claude" }, { pid: 4243, name: "node (Claude Code)" }] }) });
  const p = plan(w, { to: w.dest }, busy);
  assert.deepEqual(p.problems, []);
  assert.match(p.warnings.join("\n"), /Claude Code or the Claude desktop app is running: 2 processes \(claude, node \(Claude Code\); pid 4242, 4243\)\. Close it before you move anything\./);
  assert.deepEqual(p.processes, { ok: true, list: [{ pid: 4242, name: "claude" }, { pid: 4243, name: "node (Claude Code)" }], error: null });
  const m = plan(w, { to: w.dest, forMove: true }, busy);
  assert.deepEqual(codes(m), ["claude-running"]);
  assert.deepEqual(plan(w, { to: w.dest, forMove: true, ignoreRunning: true }, busy).problems, []);
});

test("if the process list cannot be read, move refuses too and says how to go on", () => {
  const w = seedConfig(world("plan26"));
  const blind = w.sys({ processes: () => ({ ok: false, error: "ps failed (exit 1)" }) });
  assert.ok(plan(w, { to: w.dest }, blind).warnings.includes("Could not check whether Claude Code is running: ps failed (exit 1)."));
  const m = plan(w, { to: w.dest, forMove: true }, blind);
  assert.deepEqual(codes(m), ["process-check-failed"]);
  assert.match(m.problems[0].message, /then use --ignore-running\.$/);
  assert.deepEqual(plan(w, { to: w.dest, forMove: true, ignoreRunning: true }, blind).problems, []);
});

test("describeProcesses names up to five pids and counts the rest", () => {
  assert.equal(describeProcesses([{ pid: 1, name: "claude" }]), "1 process (claude; pid 1)");
  const many = Array.from({ length: 8 }, (_, i) => ({ pid: 10 + i, name: i % 2 ? "claude.exe" : "claude" }));
  assert.equal(describeProcesses(many), "8 processes (claude, claude.exe; pid 10, 11, 12, 13, 14, and 3 more)");
});

test("the profiles and the Windows user environment that move would write are listed; --no-env lists none", () => {
  const w = seedConfig(world("plan27", { platform: LINUX }));
  put(path.join(w.home, ".bashrc"), "alias a=b\n");
  put(path.join(w.home, ".zshrc"), "alias c=d\n");
  const m = plan(w, { to: w.dest });
  assert.deepEqual(m.env.profiles.map((p) => [path.basename(p.file), p.action]), [[".bashrc", "append"], [".zshrc", "append"]]);
  assert.equal(m.env.registry, null, "no registry off Windows");
  assert.equal(m.env.variable, w.dest);
  const off = plan(w, { to: w.dest, noEnv: true });
  assert.deepEqual([off.env.skipped, off.env.profiles, off.env.registry], [true, [], null]);
});

test("on Windows the user environment is part of the plan, under the key the world names", { skip: !IS_WIN && "this is the Windows case" }, () => {
  const w = seedConfig(world("plan28"));
  const m = plan(w, { to: w.dest });
  assert.deepEqual(m.env.registry, { key: w.regKey, name: "CLAUDE_CONFIG_DIR", value: w.dest });
  assert.equal(plan(w, { to: w.dest, noEnv: true }).env.registry, null);
});

test("--link adds the link that would be left at the old place, and one for a .claude.json that sat outside", () => {
  const w = seedConfig(world("plan29", { variable: false }));
  const m = plan(w, { to: w.dest, link: true });
  assert.deepEqual(m.links, [
    { path: path.join(w.home, ".claude"), target: w.dest, kind: "dir", purpose: "origin" },
    { path: path.join(w.home, ".claude.json"), target: path.join(w.dest, ".claude.json"), kind: "file", purpose: "claude-json" },
  ]);
  assert.deepEqual(plan(w, { to: w.dest }).links, []);
  const inside = seedConfig(world("plan29b"));
  assert.deepEqual(plan(inside, { to: inside.dest, link: true }).links.map((l) => l.purpose), ["origin"]);
});

test("settings that spell the config folder's path are reported with their line, and warned about", async () => {
  const w = seedConfig(world("plan30"));
  const r = await runJson(["plan", "--to", w.dest], w);
  assert.equal(r.json.references.length, 1);
  assert.deepEqual([r.json.references[0].file, r.json.references[0].line], ["settings.json", 11]);
  assert.match(r.json.warnings.join("\n"), /spell the config folder's path in 1 place \(hooks or the status line\)\. They stop working after a move unless you use --link or change them\./);
  const text = await run(["plan", "--to", w.dest], w);
  assert.match(text.out, /^Mentions of the config folder's path:\n {2}settings\.json:11 {2}/m);
});

test("a folder that an earlier move left a manifest in is called the destination of an earlier move", async () => {
  const w = seedConfig(world("plan31"));
  put(path.join(w.cfg, "relocate-manifest.json"), "{}");
  const r = await run(["plan"], w);
  assert.match(r.out, /This folder is itself the destination of an earlier move \(relocate-manifest\.json is in it\)\./);
  assert.equal(plan(w).total.files, plan(seedConfig(world("plan31b"))).total.files, "the manifest is not counted");
});

test("a link inside the config folder is moved as a link, and plan warns that its target stays", () => {
  const w = seedConfig(world("plan32"));
  const shared = tmpDir();
  put(path.join(shared, "big.bin"), "x".repeat(100000));
  fs.rmSync(path.join(w.cfg, "todos"), { recursive: true });
  fs.symlinkSync(shared, path.join(w.cfg, "todos"), IS_WIN ? "junction" : "dir");
  const m = plan(w, { to: w.dest });
  assert.ok(m.warnings.some((x) => /^todos in the config folder is a link to .*: it is moved as a link, and what it points to stays where it is\.$/.test(x)));
  assert.equal(m.total.links, 1);
  assert.ok(m.total.bytes < 100000, "the target of the link is not counted");
});

test("the text for a plan to a split destination shows the three folders and what goes behind a link", async () => {
  const w = seedConfig(world("plan33", { platform: LINUX }));
  const r = await run(["plan", "--xdg"], w, { sys: w.sys({ platform: LINUX }) });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^Destination {3}config {2}.*claude$/m);
  assert.match(r.out, /^ {14}state {3}.*\(projects, file-history, session-env, uploads, tasks, todos, shell-snapshots, backups, debug\)$/m);
  assert.match(r.out, /^ {14}cache {3}.*\(plugins\/cache, statsig, usage-data\)$/m);
  assert.match(r.out, /Each state and cache part is replaced inside the config folder by a symbolic link\./);
  assert.match(r.out, /^Method {8}rename: the destination is on the same drive, so nothing is copied$/m);
});

test("the text for a plan with a problem lists it after the table, with a cross, and the exit code is 1", async () => {
  const w = seedConfig(world("plan34"));
  put(path.join(w.dest, "x"), "x");
  const r = await run(["plan", "--to", w.dest], w);
  assert.equal(r.code, 1);
  assert.match(r.out, /^✗ The destination .* exists and is not empty/m);
});

test("a folder an earlier move left links to is moved on with a warning that the links will lead nowhere", async () => {
  const w = seedConfig(world("plan35", { shell: "" }));
  const first = await run(["move", "--to", w.dest, "--link", "--yes"], w, { sys: w.sys() });
  assert.equal(first.code, 0, first.all);
  const atDest = { ...w, env: { ...w.env, CLAUDE_CONFIG_DIR: w.dest } };
  const third = path.join(w.base, "third");
  const m = buildPlan({ env: atDest.env, cwd: w.base, sys: w.sys(), opts: { to: third } });
  assert.deepEqual(m.problems, []);
  assert.equal(m.origin.relocated, true);
  const note = m.warnings.find((x) => /^An earlier move left a link that leads here/.test(x));
  assert.ok(note, m.warnings.join("\n"));
  assert.ok(note.includes(w.cfg));
  assert.match(note, /It will lead nowhere once this folder moves: run undo first, or point it at the new place yourself\.$/);
  const plain = seedConfig(world("plan35b"));
  assert.ok(!plan(plain, { to: plain.dest }).warnings.some((x) => /earlier move/.test(x)));
});
