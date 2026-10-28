import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readManifest } from "../src/manifest.mjs";
import { blockValue } from "../src/profiles.mjs";
import { INCOMPLETE } from "../src/move.mjs";
import { readUserEnv, writeUserEnv } from "../src/winenv.mjs";
import { IS_WIN, diffTrees, everything, exdev, lexists, noFileLinks, otherDriveDir, put, read, run, runJson, seedConfig, secondDriveAt, tmpDir, tree, world } from "./helpers.mjs";

const LINUX = IS_WIN ? "linux" : process.platform;
const MANIFEST = "relocate-manifest.json";
const norm = (p) => path.resolve(p).toLowerCase();
const move = (w, args, over, extra = {}) => run(["move", ...args], w, { sys: w.sys(over), ...extra });
const moveJson = (args, w, over) => runJson(["move", ...args], w, { sys: w.sys(over) });
// the world with a config folder in it, and no shell, so that the data move is the same on every system
const fresh = (name, opts = {}) => seedConfig(world(name, { shell: "", ...opts }), opts.seed);
const manifestOf = (dir) => { const r = readManifest(path.join(dir, MANIFEST)); assert.equal(r.ok, true, r.error); return r.manifest; };

test("move --to a new folder on the same drive renames the folder: same files, same file times, a manifest, the original gone", async () => {
  const w = fresh("mv1");
  const before = tree(w.cfg);
  const r = await moveJson(["--to", w.dest, "--yes"], w);
  assert.equal(r.code, 0, r.all);
  assert.equal(r.err, "");
  assert.deepEqual([r.json.ok, r.json.command, r.json.method, r.json.mode, r.json.incomplete, r.json.dryRun], [true, "move", "rename", "single", false, false]);
  assert.equal(r.json.manifest, path.join(w.dest, MANIFEST));
  assert.deepEqual(r.json.verified, { files: r.json.files, bytes: r.json.bytes, differences: 0 });
  assert.ok(!lexists(w.cfg), "the old place is gone");
  assert.deepEqual(diffTrees(before, tree(w.dest), { ignore: [MANIFEST] }), [], "every file, with its content and its file time");
  const m = manifestOf(w.dest);
  assert.deepEqual([m.mode, m.method, m.origin.configDir, m.destination.configDir, m.destination.existedBefore], ["single", "rename", w.cfg, w.dest, false]);
  assert.deepEqual([m.origin.claudeJsonInside, m.sessions, m.links, m.parts, m.previous], [true, { sessions: 3, projects: 2 }, [], [], null]);
  assert.deepEqual(m.options, { link: false, noEnv: false, xdg: false });
  assert.equal(m.files, r.json.files);
});

test("move prints what it did, in plain sentences, and what to do next", async () => {
  const w = fresh("mv2");
  const r = await move(w, ["--to", w.dest, "--yes", "--no-env"]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^claude-relocate 1\.1\.0 {2}move$/m);
  assert.match(r.out, /^ {2}renaming .* to .*$/m);
  assert.match(r.out, /^Moved .* to .*$/m);
  assert.match(r.out, /^ {2}renamed, not copied: both are on the same drive$/m);
  assert.match(r.out, /^ {2}\d+(\.\d)? KB in 30 files: same files, same sizes, file times kept \(checked\)$/m);
  assert.match(r.out, /^ {2}manifest: .*relocate-manifest\.json$/m);
  assert.match(r.out, /Open a new terminal \(this one keeps the environment it started with\), then run: claude-relocate verify/);
  assert.match(r.out, /To put everything back: claude-relocate undo/);
  assert.equal(r.err, "");
});

test("move without --yes shows what it would do and changes nothing; with --dry-run it says so and exits 0", async () => {
  const w = fresh("mv3");
  const before = everything(w);
  const a = await move(w, ["--to", w.dest]);
  assert.equal(a.code, 1);
  assert.match(a.err, /^This will:\n {2}1\. Move .* to .* \(renamed, not copied: same drive\)\.\n/);
  assert.match(a.err, /Nothing was changed\. Run it again with --yes to do this\.$/m);
  assert.deepEqual(everything(w), before);
  const j = await moveJson(["--to", w.dest], w);
  assert.equal(j.code, 1);
  assert.deepEqual([j.json.ok, j.json.needsYes, j.json.error], [false, true, "Nothing was changed. Run it again with --yes to do this."]);
  assert.ok(j.json.steps.length >= 2 && j.json.plan.destination.config === w.dest);
  const d = await move(w, ["--to", w.dest, "--dry-run"]);
  assert.equal(d.code, 0, d.all);
  assert.match(d.out, /^With --dry-run, this is what would happen:$/m);
  assert.match(d.out, /Nothing was changed \(--dry-run\)\.\n$/);
  const dj = await moveJson(["--to", w.dest, "--dry-run"], w);
  assert.deepEqual([dj.code, dj.json.ok, dj.json.dryRun], [0, true, true]);
  assert.deepEqual(everything(w), before, "neither dry run changed anything");
  const both = await move(w, ["--to", w.dest, "--dry-run", "--yes"]);
  assert.equal(both.code, 0, "--dry-run wins over --yes");
  assert.deepEqual(everything(w), before);
});

test("move to another drive copies the folder, checks the copy against the original, then removes the original", async () => {
  const w = fresh("mv4");
  const before = tree(w.cfg);
  const r = await moveJson(["--to", w.dest, "--yes"], w, { drive: secondDriveAt(w.dest), rename: exdev });
  assert.equal(r.code, 0, r.all);
  assert.equal(r.json.method, "copy");
  assert.ok(!lexists(w.cfg), "the original is deleted after the check");
  assert.deepEqual(diffTrees(before, tree(w.dest), { ignore: [MANIFEST] }), []);
  assert.ok(!lexists(path.join(w.dest, INCOMPLETE)), "the unfinished-copy marker is gone");
  assert.equal(manifestOf(w.dest).method, "copy");
});

test("a rename that fails with EXDEV, EPERM, EBUSY or EACCES falls back to the copy, whatever the plan said", async () => {
  for (const code of ["EXDEV", "EPERM", "EBUSY", "EACCES"]) {
    const w = fresh(`mv5-${code}`);
    const before = tree(w.cfg);
    const r = await moveJson(["--to", w.dest, "--yes"], w, { rename: () => { throw Object.assign(new Error(code), { code }); } });
    assert.equal(r.code, 0, `${code}: ${r.all}`);
    assert.equal(r.json.method, "copy", code);
    assert.ok(!lexists(w.cfg), code);
    assert.deepEqual(diffTrees(before, tree(w.dest), { ignore: [MANIFEST] }), [], code);
  }
});

test("a copy that stops half way leaves the original as it was and removes the half copy", async () => {
  const w = fresh("mv6");
  const before = everything(w);
  let n = 0;
  const copyFile = (a, b, flags) => { if (++n === 7) throw Object.assign(new Error("EIO: i/o error, copyfile"), { code: "EIO" }); return fs.copyFileSync(a, b, flags); };
  const r = await move(w, ["--to", w.dest, "--yes"], { rename: exdev, copyFile });
  assert.equal(r.code, 1);
  assert.match(r.err, /^✗ The move stopped: EIO: i\/o error, copyfile\. .* is as it was\.$/m);
  assert.deepEqual(everything(w), before, "the config folder, the home folder and the destination are as they were");
  const j = await moveJson(["--to", w.dest, "--yes"], w, { rename: exdev, copyFile: () => { throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); } });
  assert.equal(j.code, 1);
  assert.deepEqual([j.json.ok, j.json.code], [false, "move-failed"]);
  assert.deepEqual(everything(w), before);
});

test("a copy that stops half way into a folder that existed leaves that folder empty, as it was", async () => {
  const w = fresh("mv7");
  fs.mkdirSync(w.dest);
  const before = everything(w);
  let n = 0;
  const copyFile = (a, b, flags) => { if (++n === 3) throw Object.assign(new Error("EIO"), { code: "EIO" }); return fs.copyFileSync(a, b, flags); };
  const r = await move(w, ["--to", w.dest, "--yes"], { rename: exdev, copyFile });
  assert.equal(r.code, 1);
  assert.deepEqual(everything(w), before);
  assert.deepEqual(fs.readdirSync(w.dest), []);
});

test("a rename whose result does not match the folder is undone, and move says so", async () => {
  const w = fresh("mv8");
  const before = tree(w.cfg);
  const tamper = (a, b) => { fs.renameSync(a, b); fs.writeFileSync(path.join(b, "intruder.txt"), "x"); };
  const r = await move(w, ["--to", w.dest, "--yes"], { rename: tamper });
  assert.equal(r.code, 1);
  assert.match(r.err, /After the rename, .* does not match what was in .* \(1 difference, first: intruder\.txt: is in the copy and not in the original\)\./);
  assert.ok(!lexists(w.dest), "the folder went back");
  assert.deepEqual(diffTrees(before, tree(w.cfg), { ignore: ["intruder.txt"] }), []);
});

test("move to an existing empty folder uses it, and says it was there", async () => {
  const w = fresh("mv9");
  fs.mkdirSync(w.dest);
  const r = await moveJson(["--to", w.dest, "--yes"], w);
  assert.equal(r.code, 0, r.all);
  assert.equal(manifestOf(w.dest).destination.existedBefore, true);
  assert.ok(lexists(path.join(w.dest, "settings.json")));
});

test("move refuses, and changes nothing, when the destination is not empty, inside the folder, the folder itself or a file", async () => {
  const w = fresh("mv10");
  put(path.join(w.base, "a-file"), "x");
  put(path.join(w.base, "full", "x"), "x");
  const before = everything(w);
  for (const [to, code] of [[path.join(w.base, "full"), "destination-not-empty"], [path.join(w.cfg, "inner"), "destination-in-origin"], [w.cfg, "same-folder"], [path.join(w.base, "a-file"), "destination-is-file"], [w.base, "origin-in-destination"]]) {
    const r = await moveJson(["--to", to, "--yes"], w);
    assert.equal(r.code, 1, to);
    assert.deepEqual([r.json.ok, r.json.refused, r.json.problems[0].code], [false, true, code], to);
    assert.equal(r.json.error, r.json.problems[0].message);
    assert.deepEqual(everything(w), before, `${to}: nothing changed`);
  }
  const text = await move(w, ["--to", path.join(w.base, "full"), "--yes"]);
  assert.match(text.err, /^✗ Not moved\.\n {2}- The destination .* exists and is not empty \(1 item\)\. Choose a new or empty folder\.\nNothing was changed\.\n$/);
});

test("move refuses while Claude Code is running, and --ignore-running is the way past that", async () => {
  const w = fresh("mv11");
  const before = everything(w);
  const busy = { processes: () => ({ ok: true, processes: [{ pid: 777, name: "claude" }] }) };
  const r = await moveJson(["--to", w.dest, "--yes"], w, busy);
  assert.equal(r.code, 1);
  assert.equal(r.json.problems[0].code, "claude-running");
  assert.match(r.json.error, /^Claude Code or the Claude desktop app is running: 1 process \(claude; pid 777\)\. Close it, then run this again\. \(--ignore-running skips this check\.\)$/);
  assert.deepEqual(everything(w), before);
  const dry = await move(w, ["--to", w.dest, "--dry-run"], busy);
  assert.equal(dry.code, 1, "even a dry run says it would be refused");
  assert.match(dry.out, /It would be refused:/);
  const ok = await move(w, ["--to", w.dest, "--yes", "--ignore-running"], busy);
  assert.equal(ok.code, 0, ok.all);
});

test("move refuses when there is no room, naming the drive, and changes nothing", async () => {
  const w = fresh("mv12");
  const before = everything(w);
  const r = await moveJson(["--to", w.dest, "--yes"], w, { drive: secondDriveAt(w.dest), free: () => 1000 });
  assert.equal(r.code, 1);
  assert.equal(r.json.problems[0].code, "not-enough-space");
  assert.deepEqual(everything(w), before);
});

test("move with no config folder to move is refused with a sentence, not an error", async () => {
  const w = world("mv13", { shell: "" });
  const r = await move(w, ["--to", w.dest, "--yes"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^✗ Not moved\.\n {2}- There is no Claude Code config folder at /);
});

test("move to a folder with spaces, in a home with spaces, keeps every name and every file time", async () => {
  const w = seedConfig(world("with space", { shell: "" }));
  put(path.join(w.cfg, "skills", "my skill", "SKILL ü.md"), "x", Date.parse("2026-07-07T07:07:07.007Z"));
  const dest = path.join(w.base, "My Claude Data", "claude config 日本");
  const before = tree(w.cfg);
  const r = await moveJson(["--to", dest, "--yes"], w);
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(diffTrees(before, tree(dest), { ignore: [MANIFEST] }), []);
  assert.equal(manifestOf(dest).destination.configDir, dest);
});

test("with the variable not set, .claude.json next to the folder goes into the new folder, and the folder's own old one is kept under another name", async () => {
  const w = fresh("mv14", { variable: false });
  put(path.join(w.cfg, ".claude.json"), '{"old":true}', Date.parse("2026-01-01T00:00:00Z"));
  const live = fs.readFileSync(w.claudeJson, "utf8");
  const r = await moveJson(["--to", w.dest, "--yes"], w);
  assert.equal(r.code, 0, r.all);
  assert.ok(!lexists(w.claudeJson), "the file next to the folder moved");
  assert.equal(read(w.dest, ".claude.json"), live, "the live file is the one that was next to the folder");
  assert.equal(read(w.dest, ".claude.json.before-relocate"), '{"old":true}', "the old one is kept");
  const m = manifestOf(w.dest);
  assert.deepEqual([m.origin.claudeJsonInside, m.stale], [false, { claudeJson: ".claude.json.before-relocate" }]);
  assert.equal(r.json.files, 31, "the carried files count the .claude.json that sat outside");
});

test("with the variable not set and a .claude.json on another drive, it is copied and checked", async () => {
  const w = fresh("mv15", { variable: false });
  const live = fs.readFileSync(w.claudeJson, "utf8");
  const mtime = Math.round(fs.statSync(w.claudeJson).mtimeMs);
  const r = await moveJson(["--to", w.dest, "--yes"], w, { rename: exdev, drive: secondDriveAt(w.dest) });
  assert.equal(r.code, 0, r.all);
  assert.equal(read(w.dest, ".claude.json"), live);
  assert.ok(Math.abs(Math.round(fs.statSync(path.join(w.dest, ".claude.json")).mtimeMs) - mtime) <= 2);
  assert.ok(!lexists(w.claudeJson) && !lexists(w.cfg));
});

test("when .claude.json cannot be moved, everything goes back, folder and file", async () => {
  const w = fresh("mv16", { variable: false });
  const before = everything(w);
  const rename = (a, b) => { if (/\.claude\.json$/.test(a)) exdev(); return fs.renameSync(a, b); };
  const copyFile = () => { throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); };
  const r = await move(w, ["--to", w.dest, "--yes"], { rename, copyFile });
  assert.equal(r.code, 1);
  assert.match(r.err, /The move stopped: EIO: i\/o error/);
  assert.deepEqual(everything(w), before);
});

test("--link leaves a junction (Windows) or a symbolic link at the old place, so a program that ignores the variable still finds everything", async () => {
  const w = fresh("mv17");
  const r = await moveJson(["--to", w.dest, "--yes", "--link"], w);
  assert.equal(r.code, 0, r.all);
  assert.ok(fs.lstatSync(w.cfg).isSymbolicLink(), "the old place is a link");
  assert.equal(norm(fs.readlinkSync(w.cfg)).replace(/[\\/]+$/, ""), norm(w.dest));
  assert.equal(read(w.cfg, "settings.json"), read(w.dest, "settings.json"), "read through the link");
  assert.equal(fs.readFileSync(path.join(w.cfg, "projects", "-work-shop", "11111111-aaaa-4aaa-8aaa-111111111111.jsonl"), "utf8").length > 100, true);
  const m = manifestOf(w.dest);
  assert.deepEqual(m.links.map((l) => [l.path, l.kind, l.purpose]), [[w.cfg, "dir", "origin"]]);
  assert.equal(m.options.link, true);
});

test("--link with the variable not set also links ~/.claude.json to the file in the new folder", { skip: noFileLinks() }, async () => {
  const w = fresh("mv18", { variable: false });
  const live = fs.readFileSync(w.claudeJson, "utf8");
  const r = await moveJson(["--to", w.dest, "--yes", "--link"], w);
  assert.equal(r.code, 0, r.all);
  assert.ok(fs.lstatSync(w.claudeJson).isSymbolicLink());
  assert.equal(fs.readFileSync(w.claudeJson, "utf8"), live);
  assert.deepEqual(manifestOf(w.dest).links.map((l) => l.purpose), ["origin", "claude-json"]);
});

test("--link after a copy to another drive links the old place too", async () => {
  const w = fresh("mv19");
  const r = await moveJson(["--to", w.dest, "--yes", "--link"], w, { rename: exdev, drive: secondDriveAt(w.dest) });
  assert.equal(r.code, 0, r.all);
  assert.equal(r.json.method, "copy");
  assert.ok(fs.lstatSync(w.cfg).isSymbolicLink());
  assert.ok(lexists(path.join(w.cfg, "settings.json")));
});

test("links inside the folder: a link to another folder stays a link to it; an absolute link into the folder follows the folder (rename and copy)", async () => {
  for (const copy of [false, true]) {
    const w = fresh(`mv20${copy ? "c" : "r"}`);
    const shared = tmpDir();
    put(path.join(shared, "shared.txt"), "shared");
    fs.rmSync(path.join(w.cfg, "todos"), { recursive: true });
    fs.symlinkSync(shared, path.join(w.cfg, "todos"), IS_WIN ? "junction" : "dir");
    fs.symlinkSync(path.join(w.cfg, "skills", "demo"), path.join(w.cfg, "skills", "demo-alias"), IS_WIN ? "junction" : "dir");
    const r = await moveJson(["--to", w.dest, "--yes"], w, copy ? { rename: exdev, drive: secondDriveAt(w.dest) } : {});
    assert.equal(r.code, 0, `${copy}: ${r.all}`);
    assert.equal(fs.readFileSync(path.join(w.dest, "todos", "shared.txt"), "utf8"), "shared", "the link to the other folder still leads there");
    assert.equal(norm(fs.readlinkSync(path.join(w.dest, "todos"))).replace(/[\\/]+$/, ""), norm(shared));
    assert.equal(norm(fs.readlinkSync(path.join(w.dest, "skills", "demo-alias"))).replace(/[\\/]+$/, ""), norm(path.join(w.dest, "skills", "demo")), "re-aimed at the new place");
    assert.match(fs.readFileSync(path.join(w.dest, "skills", "demo-alias", "SKILL.md"), "utf8"), /name: demo/);
    assert.ok(lexists(path.join(shared, "shared.txt")), "what the link pointed at is untouched");
  }
});

test("--no-env moves the data and writes CLAUDE_CONFIG_DIR nowhere: no profile, no registry", async () => {
  const w = fresh("mv21", { shell: "/bin/bash" });
  const bashrc = put(path.join(w.home, ".bashrc"), "alias a=b\n");
  const r = await moveJson(["--to", w.dest, "--yes", "--no-env"], w, { platform: LINUX });
  assert.equal(r.code, 0, r.all);
  assert.equal(fs.readFileSync(bashrc, "utf8"), "alias a=b\n");
  assert.deepEqual(fs.readdirSync(w.home).filter((n) => n.startsWith(".bashrc")), [".bashrc"], "no backup either");
  const m = manifestOf(w.dest);
  assert.deepEqual([m.profiles, m.registry, m.options.noEnv], [[], null, true]);
  if (IS_WIN) assert.deepEqual(readUserEnv(w.env), { ok: true, exists: false, type: null, value: null, error: null });
  const text = await move(fresh("mv21b"), ["--to", path.join(w.base, "x"), "--dry-run", "--no-env"]);
  assert.match(text.out, /Leave CLAUDE_CONFIG_DIR alone \(--no-env\)\. Set it to .* yourself\./);
});

test("move writes the block into every profile that exists, after a backup next to it (bash, zsh, fish)", async () => {
  const w = fresh("mv22", { shell: "/bin/bash" });
  const files = {
    bashrc: put(path.join(w.home, ".bashrc"), "alias a=b\nexport PATH=$PATH:/x\n"),
    profile: put(path.join(w.home, ".profile"), "# login\r\numask 022\r\n"),
    zshrc: put(path.join(w.home, ".zshrc"), "alias z=y"),
    fish: put(path.join(w.xdg.config, "..", "fish", "config.fish"), "set -x A 1\n"),
  };
  files.fish = path.resolve(files.fish);
  const originals = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(f, "utf8")]));
  const r = await moveJson(["--to", w.dest, "--yes"], w, { platform: LINUX });
  assert.equal(r.code, 0, r.all);
  const m = manifestOf(w.dest);
  assert.equal(m.profiles.length, 4);
  for (const [k, f] of Object.entries(files)) {
    const text = fs.readFileSync(f, "utf8");
    assert.ok(text.startsWith(originals[k].replace(/\n$/, "")), `${k}: the old lines are still there`);
    const syntax = k === "fish" ? "fish" : "posix";
    assert.equal(blockValue(text, syntax), w.dest, `${k}: the block sets the new folder`);
    const rec = m.profiles.find((p) => p.file === f);
    assert.ok(rec.backup && path.dirname(rec.backup) === path.dirname(f), `${k}: a backup next to it`);
    assert.equal(fs.readFileSync(rec.backup, "utf8"), originals[k], `${k}: the backup is the file as it was`);
  }
  assert.match(fs.readFileSync(files.profile, "utf8"), /umask 022\r\n# claude-relocate start\r\nexport CLAUDE_CONFIG_DIR='.*'\r\n# claude-relocate end\r\n$/, "a CRLF file keeps its line endings");
  assert.match(fs.readFileSync(files.zshrc, "utf8"), /^alias z=y\n# claude-relocate start\n/, "a last line without a line break gets one first");
});

test("with no profile for the shell in use, the main one is created (not on Windows, where the user environment reaches every shell)", async () => {
  for (const [shell, platform, rel] of [["/bin/bash", "linux", ".bashrc"], ["/bin/zsh", "darwin", ".zshrc"], ["/usr/bin/fish", "linux", path.join("..", "xdg", "config", "fish", "config.fish")]]) {
    const w = fresh("mv23", { shell });
    const r = await moveJson(["--to", w.dest, "--yes"], w, { platform });
    assert.equal(r.code, 0, `${shell}: ${r.all}`);
    const file = path.resolve(w.home, rel);
    assert.equal(blockValue(fs.readFileSync(file, "utf8"), shell.endsWith("fish") ? "fish" : "posix"), w.dest, shell);
    const rec = manifestOf(w.dest).profiles[0];
    assert.deepEqual([rec.created, rec.backup, rec.action], [true, null, "create"]);
  }
});

test("a profile that cannot be written is a note: the data is moved, the exit code is 1, and the manifest says what was written", async () => {
  const w = fresh("mv24", { shell: "/bin/bash" });
  put(path.join(w.home, ".zshrc"), "alias z=y\n");
  fs.mkdirSync(path.join(w.home, ".bashrc"));
  const r = await moveJson(["--to", w.dest, "--yes"], w, { platform: LINUX });
  assert.equal(r.code, 1, r.all);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.incomplete, true);
  assert.match(r.json.warnings.join("\n"), /^Could not write .*\.bashrc: EISDIR/);
  assert.ok(lexists(path.join(w.dest, "settings.json")), "the data is in the new place");
  assert.deepEqual(manifestOf(w.dest).profiles.map((p) => path.basename(p.file)), [".zshrc"]);
  assert.equal(blockValue(read(w.home, ".zshrc"), "posix"), w.dest, "the other profile got its block");
});

test("on Windows the value goes into the user environment, the key the world names, as a plain string", { skip: !IS_WIN && "the user environment is Windows only" }, async () => {
  const w = fresh("mv25", { shell: "/usr/bin/bash" });
  const r = await moveJson(["--to", path.join(w.base, "Claude Data", "100%"), "--yes"], w);
  assert.equal(r.code, 0, r.all);
  const dest = path.join(w.base, "Claude Data", "100%");
  assert.deepEqual(readUserEnv(w.env), { ok: true, exists: true, type: "REG_SZ", value: dest, error: null });
  assert.deepEqual(manifestOf(dest).registry, { key: w.regKey, name: "CLAUDE_CONFIG_DIR", value: dest, previous: null, previousType: null });
});

test("on Windows the value that was in the user environment is kept in the manifest, with its type", { skip: !IS_WIN && "the user environment is Windows only" }, async () => {
  const w = fresh("mv26", { shell: "" });
  assert.equal(writeUserEnv("%USERPROFILE%\\old-claude", w.env, undefined, "REG_EXPAND_SZ").ok, true);
  const r = await moveJson(["--to", w.dest, "--yes"], w);
  assert.equal(r.code, 0, r.all);
  assert.equal(readUserEnv(w.env).value, w.dest);
  assert.deepEqual(manifestOf(w.dest).registry, { key: w.regKey, name: "CLAUDE_CONFIG_DIR", value: w.dest, previous: "%USERPROFILE%\\old-claude", previousType: "REG_EXPAND_SZ" });
});

test("on Windows an unreadable user environment is a refusal before anything moves; one that cannot be written is a note after", { skip: !IS_WIN && "the user environment is Windows only" }, async () => {
  const w = fresh("mv27", { shell: "" });
  const before = everything(w);
  const real = w.sys();
  const blind = { run: (cmd, args, o) => (cmd === "cmd.exe" ? { error: new Error("spawn cmd.exe ENOENT"), status: null, stdout: "" } : real.run(cmd, args, o)) };
  const a = await moveJson(["--to", w.dest, "--yes"], w, blind);
  assert.equal(a.code, 1);
  assert.equal(a.json.problems[0].code, "registry-unavailable");
  assert.deepEqual(everything(w), before);
  const deaf = { run: (cmd, args, o) => (cmd === "reg" && args[0] === "add" ? { status: 1, stdout: "", stderr: "ERROR: Access is denied." } : real.run(cmd, args, o)) };
  const b = await moveJson(["--to", w.dest, "--yes"], w, deaf);
  assert.equal(b.code, 1, b.all);
  assert.equal(b.json.incomplete, true);
  assert.match(b.json.warnings.join("\n"), /^Could not set CLAUDE_CONFIG_DIR in the Windows user environment: reg add failed \(ERROR: Access is denied\.\)\. Set it to .* yourself\.$/);
  assert.ok(lexists(path.join(w.dest, "settings.json")));
  assert.equal(manifestOf(w.dest).registry, null, "the manifest does not claim what was not done");
});

test("moving a folder that is itself the destination of an earlier move keeps that move's manifest, so two undos go back two moves", async () => {
  const w = fresh("mv28");
  const first = w.dest;
  const second = path.join(w.base, "second");
  assert.equal((await moveJson(["--to", first, "--yes"], w)).code, 0);
  const w2 = { ...w, env: { ...w.env, CLAUDE_CONFIG_DIR: first } };
  const r = await moveJson(["--to", second, "--yes"], w2, {});
  assert.equal(r.code, 0, r.all);
  const m = manifestOf(second);
  assert.equal(m.previous.destination.configDir, first, "the first move is remembered inside the second");
  assert.equal(m.origin.configDir, first);
});

test("--xdg off Windows splits the sessions and other state into the state folder and the caches into the cache folder, each behind a link", async () => {
  const w = fresh("mv29", { platform: LINUX });
  const before = tree(w.cfg);
  const r = await moveJson(["--xdg", "--yes"], w, { platform: LINUX });
  assert.equal(r.code, 0, r.all);
  assert.equal(r.json.mode, "xdg-split");
  assert.ok(!lexists(w.cfg));
  const m = manifestOf(w.xdg.config);
  assert.equal(m.mode, "xdg-split");
  assert.deepEqual(m.parts.map((p) => p.path).sort(), ["backups", "debug", "file-history", "plugins/cache", "projects", "session-env", "shell-snapshots", "statsig", "tasks", "todos", "uploads", "usage-data"]);
  for (const p of m.parts) {
    assert.ok(fs.lstatSync(p.link).isSymbolicLink(), `${p.path} is a link in the config folder`);
    assert.equal(norm(fs.readlinkSync(p.link)).replace(/[\\/]+$/, ""), norm(p.to));
    assert.ok(fs.lstatSync(p.to).isDirectory() && !fs.lstatSync(p.to).isSymbolicLink(), `${p.path} is a real folder in the ${p.area} folder`);
  }
  assert.ok(lexists(path.join(w.xdg.state, "projects", "-work-shop")), "the sessions are in the state folder");
  assert.ok(lexists(path.join(w.xdg.cache, "plugins", "cache", "m", "p", "1.0.0", "x.txt")), "the plugin cache is in the cache folder");
  assert.ok(fs.lstatSync(path.join(w.xdg.config, "settings.json")).isFile(), "settings stay in the config folder");
  assert.deepEqual(m.links.map((l) => l.purpose), m.parts.map(() => "xdg"));
  // read through the links, everything is where it was
  assert.deepEqual(diffTrees(before, tree(w.xdg.config), { ignore: [MANIFEST, ...m.parts.map((p) => `${p.path}/`)] }), []);
  const through = tree(path.join(w.xdg.config, "projects"));
  assert.deepEqual(diffTrees(Object.fromEntries(Object.entries(before).filter(([k]) => k.startsWith("projects/")).map(([k, v]) => [k.slice(9), v])), through), []);
});

test("--xdg without the split (Windows) puts everything into $XDG_CONFIG_HOME/claude", { skip: !IS_WIN && "this is the Windows case" }, async () => {
  const w = fresh("mv30");
  const before = tree(w.cfg);
  const r = await moveJson(["--xdg", "--yes"], w);
  assert.equal(r.code, 0, r.all);
  assert.equal(r.json.mode, "single");
  assert.deepEqual(diffTrees(before, tree(w.xdg.config), { ignore: [MANIFEST] }), []);
  assert.ok(!lexists(w.xdg.state) && !lexists(w.xdg.cache));
});

test("the split fails as a whole: a part that cannot move puts the others back", async () => {
  const w = fresh("mv31", { platform: LINUX });
  const before = everything(w);
  let n = 0;
  const rename = (a, b) => { if (++n === 9) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); return fs.renameSync(a, b); };
  const r = await move(w, ["--xdg", "--yes"], { platform: LINUX, rename });
  assert.equal(r.code, 1);
  assert.match(r.err, /The move stopped: ENOSPC/);
  assert.deepEqual(everything(w), before, "the config folder is whole again and the XDG folders are as they were");
});

test("--dry-run with --xdg lists the parts that go behind links", async () => {
  const w = fresh("mv32", { platform: LINUX });
  const r = await move(w, ["--xdg", "--dry-run"], { platform: LINUX });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /with these parts in the state and cache folders and a symbolic link for each in /);
  assert.match(r.out, /^ {7}projects -> .*projects$/m);
  assert.match(r.out, /^ {7}plugins\/cache -> /m);
  assert.match(r.out, /^ {2}2\. Write .*relocate-manifest\.json, which `undo` reads\.$/m, "the parts are not numbered as steps");
});

test("move needs a destination and takes only one kind of destination", async () => {
  const w = fresh("mv33");
  const a = await run(["move", "--yes"], w);
  assert.equal(a.code, 2);
  assert.match(a.err, /^claude-relocate: move needs a destination: --to <folder>, or --xdg\nTry: claude-relocate --help\n$/);
  const b = await run(["move", "--to", w.dest, "--xdg"], w);
  assert.equal(b.code, 2);
  assert.match(b.err, /use --to <folder> or --xdg, not both/);
});

test("a profile that is not UTF-8 text (UTF-16, an ANSI code page) is left alone, byte for byte, and plan and move say so; the others get their block", async () => {
  const w = fresh("mv34", { shell: "/bin/bash" });
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("alias a=b\r\n", "utf16le")]);
  fs.writeFileSync(path.join(w.home, ".bashrc"), utf16);
  put(path.join(w.home, ".zshrc"), "alias z=y\n");
  const over = { platform: LINUX };
  const plan = await runJson(["plan", "--to", w.dest], w, { sys: w.sys(over) });
  assert.deepEqual(plan.json.env.notWritten.map((n) => [path.basename(n.file), n.shell]), [[".bashrc", "bash"]]);
  assert.deepEqual(plan.json.env.profiles.map((p) => path.basename(p.file)), [".zshrc"]);
  assert.ok(plan.json.warnings.some((x) => /\.bashrc is not UTF-8 text \(it may be UTF-16, or use an ANSI code page\), so claude-relocate leaves it alone\. Set CLAUDE_CONFIG_DIR=.* in it yourself\.$/.test(x)));
  const r = await moveJson(["--to", w.dest, "--yes"], w, over);
  assert.equal(r.code, 0, r.all);
  assert.ok(fs.readFileSync(path.join(w.home, ".bashrc")).equals(utf16), "the UTF-16 profile is exactly as it was");
  assert.deepEqual(fs.readdirSync(w.home).filter((n) => n.startsWith(".bashrc")), [".bashrc"], "no backup, no temporary file");
  assert.deepEqual(manifestOf(w.dest).profiles.map((p) => path.basename(p.file)), [".zshrc"]);
  assert.equal(blockValue(read(w.home, ".zshrc"), "posix"), w.dest);
});

test("a PowerShell profile keeps its byte-order mark and its CRLF line endings through move and undo (Windows)", { skip: !IS_WIN && "PowerShell profiles are looked for on Windows only" }, async () => {
  const w = fresh("mv35");
  const original = "\uFEFF# my profile\r\nSet-Alias ll Get-ChildItem\r\n";
  const file = put(path.join(w.home, "Documents", "WindowsPowerShell", "profile.ps1"), original);
  const r = await moveJson(["--to", w.dest, "--yes"], w);
  assert.equal(r.code, 0, r.all);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.startsWith("\uFEFF# my profile\r\n"), "the mark and the old lines stay");
  assert.ok(text.endsWith(`# claude-relocate start\r\n$env:CLAUDE_CONFIG_DIR = '${w.dest}'\r\n# claude-relocate end\r\n`));
  assert.equal(manifestOf(w.dest).profiles[0].shell, "powershell");
  const u = await runJson(["undo", "--yes"], { ...w, env: { ...w.env, CLAUDE_CONFIG_DIR: w.dest } }, { sys: w.sys() });
  assert.equal(u.code, 0, u.all);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

const OTHER_DRIVE = otherDriveDir();

test("move to a really different drive: planned as a copy, copied, checked, the original removed; undo copies it back (when this machine has a second drive)", { skip: !OTHER_DRIVE && "this machine has no second writable drive" }, async () => {
  const w = fresh("mv36");
  const dest = path.join(OTHER_DRIVE, "Claude data", "cfg");
  const before = everything(w);
  const treeBefore = tree(w.cfg);
  const plan = await runJson(["plan", "--to", dest], w, { sys: w.sys() });
  assert.equal(plan.json.destination.method, "copy", "the system says these are two drives");
  const r = await moveJson(["--to", dest, "--yes"], w);
  assert.equal(r.code, 0, r.all);
  assert.equal(r.json.method, "copy");
  assert.ok(!lexists(w.cfg));
  assert.deepEqual(diffTrees(treeBefore, tree(dest), { ignore: [MANIFEST] }), []);
  const u = await runJson(["undo", "--yes"], { ...w, env: { ...w.env, CLAUDE_CONFIG_DIR: dest } }, { sys: w.sys() });
  assert.equal(u.code, 0, u.all);
  assert.equal(u.json.method, "copy");
  assert.ok(!lexists(dest) && !lexists(path.dirname(dest)), "and the folders the move made on the way are gone");
  const after = everything(w);
  assert.deepEqual(diffTrees(before.base, after.base, { ignore: [] }), []);
});

test("the --xdg split with the state and cache folders on a really different drive: the config folder is renamed, the parts are copied behind links, undo brings back the exact tree (when this machine has a second drive)", { skip: !OTHER_DRIVE && "this machine has no second writable drive" }, async () => {
  const w = fresh("mv37", { platform: LINUX });
  const env = { ...w.env, XDG_STATE_HOME: path.join(OTHER_DRIVE, "state"), XDG_CACHE_HOME: path.join(OTHER_DRIVE, "cache") };
  const x = { ...w, env };
  const before = everything(w);
  const treeBefore = tree(w.cfg);
  const over = { platform: LINUX };
  const plan = await runJson(["plan", "--xdg"], x, { sys: w.sys(over) });
  assert.deepEqual(plan.json.problems, []);
  assert.equal(plan.json.destination.method, "mixed");
  assert.deepEqual(plan.json.destination.groups.map((g) => `${g.area}:${g.method}`), ["config:rename", "state:copy", "cache:copy"]);
  const m = await runJson(["move", "--xdg", "--yes"], x, { sys: w.sys(over) });
  assert.equal(m.code, 0, m.all);
  assert.equal(m.json.method, "mixed");
  assert.ok(lexists(path.join(OTHER_DRIVE, "state", "claude", "projects", "-work-shop")) && lexists(path.join(OTHER_DRIVE, "cache", "claude", "plugins", "cache", "m")));
  assert.ok(fs.lstatSync(path.join(w.xdg.config, "projects")).isSymbolicLink());
  const atDest = { ...x, env: { ...env, CLAUDE_CONFIG_DIR: w.xdg.config } };
  const u = await runJson(["undo", "--yes"], atDest, { sys: w.sys(over) });
  assert.equal(u.code, 0, u.all);
  assert.equal(u.json.method, "mixed", "the folder came back by rename and the parts by copy");
  assert.deepEqual(diffTrees(treeBefore, tree(w.cfg)), []);
  assert.deepEqual(diffTrees(before.base, everything(w).base), []);
  assert.ok(!lexists(path.join(OTHER_DRIVE, "state")) && !lexists(path.join(OTHER_DRIVE, "cache")), "and the folders the move made on the other drive are gone");
});

test("--xdg when every part is moved by copy still takes a .claude.json that sat next to the folder with it, and undo brings it back (found by review)", async () => {
  const w = fresh("mv38", { variable: false, platform: LINUX });
  const before = everything(w);
  const over = { platform: LINUX, rename: exdev };
  const r = await moveJson(["--xdg", "--yes"], w, over);
  assert.equal(r.code, 0, r.all);
  assert.equal(r.json.mode, "xdg-split");
  assert.equal(r.json.method, "copy");
  assert.ok(!lexists(w.claudeJson), "the old ~/.claude.json is gone, not left behind");
  assert.ok(lexists(path.join(w.xdg.config, ".claude.json")));
  const u = await runJson(["undo", "--yes"], { ...w, env: { ...w.env, CLAUDE_CONFIG_DIR: w.xdg.config } }, { sys: w.sys(over) });
  assert.equal(u.code, 0, u.all);
  assert.deepEqual(diffTrees(before.base, everything(w).base), []);
});

test("--xdg --link when every part is moved by copy leaves the links for the folder's parts and for ~/.claude.json", { skip: noFileLinks() }, async () => {
  const w = fresh("mv39", { variable: false, platform: LINUX });
  const r = await moveJson(["--xdg", "--link", "--yes"], w, { platform: LINUX, rename: exdev });
  assert.equal(r.code, 0, r.all);
  assert.ok(fs.lstatSync(w.claudeJson).isSymbolicLink() && fs.lstatSync(w.cfg).isSymbolicLink());
  assert.equal(read(w.claudeJson), read(w.xdg.config, ".claude.json"));
});

test("the split that fails half way into a destination folder that already existed leaves that folder empty, as it was", async () => {
  const w = fresh("mv40", { platform: LINUX });
  fs.mkdirSync(w.xdg.config, { recursive: true });
  const before = everything(w);
  let n = 0;
  const rename = (a, b) => { if (++n === 14) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); return fs.renameSync(a, b); };
  const r = await move(w, ["--xdg", "--yes"], { platform: LINUX, rename });
  assert.equal(r.code, 1);
  assert.match(r.err, /The move stopped: ENOSPC/);
  assert.deepEqual(everything(w), before);
  assert.deepEqual(fs.readdirSync(w.xdg.config), []);
});

// A removal that fails the way a file another program holds open does on Windows: the file, and any folder with it
// inside, cannot be removed; everything else can.
function holdOpen(name, inside) {
  const real = fs.rmSync;
  const holds = (p) => { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink() ? fs.readdirSync(p).some((n) => holds(path.join(p, n))) : path.basename(p) === name; };
  fs.rmSync = (p, o) => {
    if (String(p).startsWith(inside) && lexists(p) && holds(p)) throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${name}'`), { code: "EBUSY" });
    return real.call(fs, p, o);
  };
  return () => { fs.rmSync = real; };
}

// A write of the manifest that fails, as a full disk does
function failManifestWrite() {
  const real = fs.writeFileSync;
  fs.writeFileSync = (p, ...rest) => {
    if (String(p).includes("relocate-manifest.json.tmp-")) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    return real.call(fs, p, ...rest);
  };
  return () => { fs.writeFileSync = real; };
}

test("--xdg split: an entry whose copy was checked but whose original cannot be removed completely has moved; the move finishes and names what is left (found by review)", async () => {
  const w = fresh("mv41", { platform: LINUX });
  put(path.join(w.cfg, "commands", "keep.md"), "keep me\n");
  put(path.join(w.cfg, "commands", "go.md"), "go goes from the old place\n");
  const before = everything(w);
  const over = { platform: LINUX, rename: exdev };
  const release = holdOpen("keep.md", path.join(w.cfg, "commands"));
  let r;
  try { r = await moveJson(["--xdg", "--yes"], w, over); } finally { release(); }
  assert.equal(r.code, 1, r.all);
  assert.deepEqual([r.json.ok, r.json.incomplete], [false, true]);
  assert.ok(r.json.warnings.some((x) => /Could not remove 1 item \(.*keep\.md: EBUSY\) from .*It is whole in the new place; delete what is left by hand/.test(x)), r.json.warnings.join(" | "));
  assert.equal(read(w.xdg.config, "commands", "go.md"), "go goes from the old place\n", "the copy has everything");
  assert.equal(read(w.xdg.config, "commands", "keep.md"), "keep me\n");
  assert.deepEqual(fs.readdirSync(path.join(w.cfg, "commands")), ["keep.md"], "only the file that was held is left in the old place");
  assert.equal(manifestOf(w.xdg.config).leftBehind, 1);
  const atDest = { ...w, env: { ...w.env, CLAUDE_CONFIG_DIR: w.xdg.config } };
  const refused = await runJson(["undo", "--yes"], atDest, { sys: w.sys(over) });
  assert.equal(refused.code, 1);
  assert.match(refused.json.error, /holds what the move could not remove from it, 1 item; delete it\)\. Move it away/);
  fs.rmSync(w.cfg, { recursive: true, force: true });
  const u = await runJson(["undo", "--yes"], atDest, { sys: w.sys(over) });
  assert.equal(u.code, 0, u.all);
  assert.deepEqual(diffTrees(before.base, everything(w).base), [], "and once the leftover is gone, undo brings the exact tree back");
});

test("a folder that cannot be renamed is copied, ~/.claude.json goes along as a copy, and when the manifest then cannot be written the file is still where it was (found by review)", async () => {
  const busyForFolders = (a, b) => { if (fs.statSync(a).isDirectory()) throw Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" }); return fs.renameSync(a, b); };
  const ok = fresh("mv42a", { variable: false });
  const done = await move(ok, ["--to", ok.dest, "--yes", "--no-env"], { rename: busyForFolders });
  assert.equal(done.code, 0, done.all);
  assert.ok(!lexists(ok.claudeJson) && lexists(path.join(ok.dest, ".claude.json")), "without a failure ~/.claude.json ends up in the new folder");
  const w = fresh("mv42b", { variable: false });
  const before = everything(w);
  const release = failManifestWrite();
  let r;
  try { r = await move(w, ["--to", w.dest, "--yes", "--no-env"], { rename: busyForFolders }); } finally { release(); }
  assert.equal(r.code, 1);
  assert.match(r.err, /The move stopped: ENOSPC/);
  assert.deepEqual(everything(w), before, "everything is as it was, ~/.claude.json too");
});

test("--xdg split by rename, then the manifest cannot be written: the folder is put back with its links aimed at the old place again (found by review)", async () => {
  const w = fresh("mv43", { platform: LINUX });
  const kind = IS_WIN ? "junction" : "dir";
  fs.symlinkSync(path.join(w.cfg, "skills"), path.join(w.cfg, "abs-link-to-skills"), kind);
  fs.symlinkSync(path.join(w.cfg, "skills", "demo"), path.join(w.cfg, "projects", "-work-shop", "abs-link"), kind);
  const before = everything(w);
  const release = failManifestWrite();
  let r;
  try { r = await move(w, ["--xdg", "--yes"], { platform: LINUX }); } finally { release(); }
  assert.equal(r.code, 1);
  assert.match(r.err, /The move stopped: ENOSPC/);
  assert.deepEqual(diffTrees(before.base, everything(w).base), [], "every link points where it did");
  assert.ok(fs.existsSync(path.join(w.cfg, "abs-link-to-skills", "demo", "SKILL.md")) && fs.existsSync(path.join(w.cfg, "projects", "-work-shop", "abs-link", "SKILL.md")), "and works");
});

test("a manifest write that fails once after the profiles were written is tried again; one that keeps failing is a note that names what undo will not take out", async () => {
  const mk = (name) => { const w = seedConfig(world(name, { shell: "/bin/bash" })); put(path.join(w.home, ".bashrc"), "# mine\n"); return w; };
  // the renames onto the manifest, counted: from the nth on, `times` of them fail
  const failFrom = (nth, times) => {
    const real = fs.renameSync;
    let n = 0;
    fs.renameSync = (a, b) => {
      if (String(b).endsWith(MANIFEST)) { n++; if (n >= nth && n < nth + times) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }); }
      return real.call(fs, a, b);
    };
    return () => { fs.renameSync = real; };
  };
  const once = mk("mv44a");
  let release = failFrom(2, 1);
  let r;
  try { r = await moveJson(["--to", once.dest, "--yes"], once, {}); } finally { release(); }
  assert.equal(r.code, 0, r.all);
  assert.equal(manifestOf(once.dest).profiles.length, 1, "the second try wrote the profile into the manifest");
  const w = mk("mv44b");
  release = failFrom(2, Infinity);
  try { r = await moveJson(["--to", w.dest, "--yes"], w, {}); } finally { release(); }
  assert.equal(r.code, 1, r.all);
  assert.deepEqual([r.json.ok, r.json.incomplete], [false, true]);
  assert.ok(r.json.warnings.some((x) => x.includes("Could not write") && x.includes("EPERM") && x.includes(path.join(w.home, ".bashrc")) && x.includes("by hand")), r.json.warnings.join(" | "));
  assert.ok(lexists(path.join(w.dest, "settings.json")) && !lexists(w.cfg), "the data is in the new place");
  assert.equal(manifestOf(w.dest).profiles.length, 0, "the manifest on disk is the first version");
  assert.match(read(w.home, ".bashrc"), /# claude-relocate start/, "and the profile has the block");
});

test("a single folder copied while a file in the old place stays held open: the move finishes, names the file, and undo waits until it is deleted by hand", async () => {
  const w = fresh("mv45");
  put(path.join(w.cfg, "projects", "-work-shop", "locked.txt"), "held open\n");
  const before = everything(w);
  const over = { rename: exdev, drive: secondDriveAt(w.dest) };
  const realRename = fs.renameSync;
  // the lock keeps the old folder from being renamed aside as well, so what cannot be removed stays where it was
  fs.renameSync = (a, b) => { if (String(b).endsWith(".claude-relocate-old")) throw Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" }); return realRename.call(fs, a, b); };
  const release = holdOpen("locked.txt", w.cfg);
  let r;
  try { r = await moveJson(["--to", w.dest, "--yes", "--no-env"], w, over); } finally { release(); fs.renameSync = realRename; }
  assert.equal(r.code, 1, r.all);
  assert.ok(r.json.warnings.some((x) => /Could not remove 1 item \(.*locked\.txt: EBUSY\) from .*Everything is in .*delete what is left by hand/.test(x)), r.json.warnings.join(" | "));
  assert.equal(read(w.dest, "projects", "-work-shop", "locked.txt"), "held open\n", "it is in the new place");
  assert.deepEqual(Object.keys(tree(w.cfg)).sort(), ["projects", "projects/-work-shop", "projects/-work-shop/locked.txt"], "only the held file, and the folders above it, are left");
  assert.equal(manifestOf(w.dest).leftBehind, 1);
  const atDest = { ...w, env: { ...w.env, CLAUDE_CONFIG_DIR: w.dest } };
  const refused = await runJson(["undo", "--yes"], atDest, { sys: w.sys(over) });
  assert.equal(refused.code, 1);
  assert.match(refused.json.error, /holds what the move could not remove from it, 1 item; delete it\)\. Move it away/);
  fs.rmSync(w.cfg, { recursive: true, force: true });
  const u = await runJson(["undo", "--yes"], atDest, { sys: w.sys(over) });
  assert.equal(u.code, 0, u.all);
  assert.deepEqual(diffTrees(before.base, everything(w).base), []);
});

test("a destination directly below the top of a drive works, and so does the undo that makes the old folder there again (found by review: Node cannot make the drive root itself)", { skip: !(IS_WIN && OTHER_DRIVE) && "needs Windows and a second writable drive" }, async () => {
  const root = path.parse(OTHER_DRIVE).root;
  const dest = path.join(root, `cr-direct-${process.pid}`);
  const cfg = path.join(root, `cr-origin-${process.pid}`);
  try {
    // 1. to a folder directly below the top of the other drive
    const a = fresh("mv47a");
    const aBefore = everything(a);
    const m = await moveJson(["--to", dest, "--yes", "--no-env"], a);
    assert.equal(m.code, 0, m.all);
    assert.equal(m.json.method, "copy");
    assert.ok(lexists(path.join(dest, "settings.json")));
    const u = await runJson(["undo", "--yes"], { ...a, env: { ...a.env, CLAUDE_CONFIG_DIR: dest } }, { sys: a.sys() });
    assert.equal(u.code, 0, u.all);
    assert.ok(!lexists(dest), "the folder it made is gone");
    assert.deepEqual(diffTrees(aBefore.base, everything(a).base), []);
    // 2. a config folder that sits directly below the top of a drive, moved away and brought back
    const w0 = world("mv47b", { shell: "" });
    const w = { ...w0, cfg, claudeJson: path.join(cfg, ".claude.json"), env: { ...w0.env, CLAUDE_CONFIG_DIR: cfg } };
    seedConfig(w);
    const before = tree(cfg);
    const m2 = await moveJson(["--to", w.dest, "--yes", "--no-env"], w);
    assert.equal(m2.code, 0, m2.all);
    assert.ok(!lexists(cfg));
    const u2 = await runJson(["undo", "--yes"], { ...w, env: { ...w.env, CLAUDE_CONFIG_DIR: w.dest } }, { sys: w.sys() });
    assert.equal(u2.code, 0, u2.all);
    assert.deepEqual(diffTrees(before, tree(cfg)), []);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.rmSync(cfg, { recursive: true, force: true });
  }
});

test("a named pipe in the folder is left out of a copy and said so, and is not a reason to refuse the move (POSIX)", { skip: IS_WIN && "Windows has no named pipes in folders" }, async (t) => {
  const w = fresh("mv48");
  if (spawnSync("mkfifo", [path.join(w.cfg, "pipe")]).status !== 0) { t.skip("mkfifo is not available"); return; }
  const r = await moveJson(["--to", w.dest, "--yes", "--no-env"], w, { rename: exdev, drive: secondDriveAt(w.dest) });
  assert.equal(r.code, 0, r.all);
  assert.ok(r.json.warnings.some((x) => /1 special file \(sockets or pipes\) could not be copied and was left out/.test(x)), r.json.warnings.join(" | "));
  assert.ok(!lexists(path.join(w.dest, "pipe")) && !lexists(w.cfg));
});

test("move to a new folder below a link to a real folder, and undo, work through the link (found by review: it was refused as 'is a file')", async () => {
  const w = fresh("mv49");
  const real = path.join(w.base, "bigdisk", "config");
  fs.mkdirSync(real, { recursive: true });
  const link = path.join(w.base, "configlink");
  fs.symlinkSync(real, link, IS_WIN ? "junction" : "dir");
  const dest = path.join(link, "claude");
  const before = everything(w);
  const r = await moveJson(["--to", dest, "--yes", "--no-env"], w);
  assert.equal(r.code, 0, r.all);
  assert.ok(lexists(path.join(real, "claude", "settings.json")), "the data is in the real folder behind the link");
  const u = await runJson(["undo", "--yes"], { ...w, env: { ...w.env, CLAUDE_CONFIG_DIR: dest } }, { sys: w.sys() });
  assert.equal(u.code, 0, u.all);
  assert.deepEqual(diffTrees(before.base, everything(w).base), [], "the link and the folder behind it are as they were");
});

// Something writes to the folder after the copy was checked, as the manifest is being written (the profiles and the
// user environment come between the copy and the removal of the original, and take a moment).
function writeAfterTheCopy(w) {
  const real = fs.writeFileSync;
  let done = false;
  fs.writeFileSync = (p, ...rest) => {
    if (!done && String(p).includes("relocate-manifest.json.tmp-")) { done = true; fs.appendFileSync(path.join(w.cfg, "history.jsonl"), "written after the copy was checked\n"); }
    return real.call(fs, p, ...rest);
  };
  return () => { fs.writeFileSync = real; };
}

test("a single folder whose original changes while it is copied: the move stops with nothing changed, and the copy is taken away again (found by review)", async () => {
  const w = fresh("mv50a", { variable: false });
  const before = everything(w);
  const copied = [];
  const copyFile = (a, b, flags) => { fs.copyFileSync(a, b, flags); copied.push(a); if (copied.length === 4) fs.appendFileSync(copied[0], "written by a program that started meanwhile\n"); };
  const r = await moveJson(["--to", w.dest, "--yes"], w, { rename: exdev, drive: secondDriveAt(w.dest), copyFile });
  assert.equal(r.code, 1, r.all);
  assert.match(r.json.error, /changed while it was being copied \(1 difference, the first at .+\)\. Nothing was changed\. Close Claude Code and the Claude desktop app, then run this again\.$/);
  assert.ok(!lexists(w.dest), "the copy is gone");
  const differences = diffTrees(before.base, everything(w).base);
  assert.equal(differences.length, 1, `only the file the other program wrote to differs; no profile, no manifest, no link: ${differences.join("; ")}`);
});

test("a single folder whose original changes after the copy was checked: the move finishes, keeps the original, says what changed, and undo says why the old place is in the way (found by review)", async () => {
  const w = fresh("mv50", { variable: false });
  const over = { rename: exdev, drive: secondDriveAt(w.dest) };
  const release = writeAfterTheCopy(w);
  let r;
  try { r = await moveJson(["--to", w.dest, "--yes", "--no-env"], w, over); } finally { release(); }
  assert.equal(r.code, 1, r.all);
  assert.deepEqual([r.json.ok, r.json.incomplete], [false, true]);
  assert.ok(r.json.warnings.some((x) => /changed after the copy was checked, so the original was not removed\. The copy in .* is .* as it was when the move began/.test(x)), r.json.warnings.join(" | "));
  assert.ok(lexists(path.join(w.cfg, "settings.json")), "the original is still there");
  assert.ok(lexists(w.claudeJson), "and so is the ~/.claude.json that went with it");
  assert.ok(lexists(path.join(w.dest, "settings.json")) && lexists(path.join(w.dest, ".claude.json")), "the copy is complete");
  assert.equal(manifestOf(w.dest).originalKept, true);
  const refused = await runJson(["undo", "--yes"], { ...w, env: { ...w.env, CLAUDE_CONFIG_DIR: w.dest } }, { sys: w.sys(over) });
  assert.equal(refused.code, 1);
  assert.match(refused.json.error, /the move kept it because it changed after the copy was checked; copy what you need from it into the new folder, then delete it\)\. Move it away/);
});

test("the text of a move that kept its original, or could not empty the old place, does not say the original was removed, and says what to do before undo (found by review)", async () => {
  const kept = fresh("mv51a", { variable: false });
  const release0 = writeAfterTheCopy(kept);
  let k;
  try { k = await move(kept, ["--to", kept.dest, "--yes", "--no-env"], { rename: exdev, drive: secondDriveAt(kept.dest) }); } finally { release0(); }
  assert.equal(k.code, 1, k.all);
  assert.match(k.out, /^ {2}copied and checked; the original was kept, because it changed after the copy was checked$/m);
  assert.doesNotMatch(k.out, /then the original was removed/);
  assert.match(k.out, /^The old place has newer changes than the copy in the new folder: copy what you need from it into the new folder, then delete the old place\. undo waits until it is gone\.$/m);
  assert.doesNotMatch(k.out, /then run claude-relocate undo/, "undo is not offered: deleting the old place and running it would bring back the older copy");
  const stuck = fresh("mv51b");
  put(path.join(stuck.cfg, "projects", "-work-shop", "locked.txt"), "held open\n");
  const release = holdOpen("locked.txt", stuck.cfg);
  let s;
  try { s = await move(stuck, ["--to", stuck.dest, "--yes", "--no-env"], { rename: exdev, drive: secondDriveAt(stuck.dest) }); } finally { release(); }
  assert.equal(s.code, 1, s.all);
  assert.match(s.out, /^ {2}copied and checked; the original was removed except for what the notes below name$/m);
  assert.match(s.out, /^note {2}Could not remove 1 item /m);
  assert.match(s.out, /^To put everything back: delete what is left of the old place, as the notes say, then run claude-relocate undo$/m);
  const ok = fresh("mv51c");
  const o = await move(ok, ["--to", ok.dest, "--yes", "--no-env"], { rename: exdev, drive: secondDriveAt(ok.dest) });
  assert.match(o.out, /^ {2}copied and checked, then the original was removed$/m);
  assert.match(o.out, /^To put everything back: claude-relocate undo$/m);
});

test("when the old folder can be moved aside but not emptied, what is left is in the folder next to it, the move names it, and undo does not wait for it", async () => {
  const w = fresh("mv52");
  put(path.join(w.cfg, "projects", "-work-shop", "locked.txt"), "held open\n");
  const before = everything(w);
  const over = { rename: exdev, drive: secondDriveAt(w.dest) };
  const aside = `${w.cfg}.claude-relocate-old`;
  const release = holdOpen("locked.txt", w.cfg);
  let r;
  try { r = await moveJson(["--to", w.dest, "--yes", "--no-env"], w, over); } finally { release(); }
  assert.equal(r.code, 1, r.all);
  assert.ok(r.json.warnings.some((x) => x.includes("locked.txt") && x.includes(aside)), r.json.warnings.join(" | "));
  assert.ok(!lexists(w.cfg), "the old place itself is gone");
  assert.deepEqual(Object.keys(tree(aside)).sort(), ["projects", "projects/-work-shop", "projects/-work-shop/locked.txt"]);
  const u = await runJson(["undo", "--yes"], { ...w, env: { ...w.env, CLAUDE_CONFIG_DIR: w.dest } }, { sys: w.sys(over) });
  assert.equal(u.code, 0, u.all);
  assert.deepEqual(diffTrees(before.base, everything(w).base, { ignore: ["cfg.claude-relocate-old/"] }), [], "everything is back, and the leftover is still beside it");
  assert.ok(lexists(path.join(aside, "projects", "-work-shop", "locked.txt")));
});

test("a rename whose result does not match is undone with the relative links that leave the folder as they were (found by review)", { skip: noFileLinks() }, async () => {
  const w = fresh("mv53");
  put(path.join(w.base, "dotfiles", "x.md"), "x");
  fs.symlinkSync(path.join("..", "dotfiles", "x.md"), path.join(w.cfg, "linked.md"), "file");
  const before = tree(w.cfg);
  const tamper = (a, b) => { fs.renameSync(a, b); fs.writeFileSync(path.join(b, "intruder.txt"), "x"); };
  const r = await move(w, ["--to", w.dest, "--yes"], { rename: tamper });
  assert.equal(r.code, 1);
  assert.deepEqual(diffTrees(before, tree(w.cfg), { ignore: ["intruder.txt"] }), [], "the link has the text it had");
});

test("--xdg split that fails half way through the walk leaves the relative links that leave the folder as they were: the pass that re-aims links had not run (found by review)", { skip: noFileLinks() }, async () => {
  const w = fresh("mv54", { platform: LINUX });
  put(path.join(w.base, "dotfiles", "x.md"), "x");
  fs.symlinkSync(path.join("..", "dotfiles", "x.md"), path.join(w.cfg, "linked.md"), "file");
  fs.symlinkSync(path.join("..", "..", "..", "dotfiles", "x.md"), path.join(w.cfg, "projects", "-work-shop", "linked.md"), "file");
  const before = everything(w);
  let n = 0;
  const rename = (a, b) => { if (++n === 14) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); return fs.renameSync(a, b); };
  const r = await move(w, ["--xdg", "--yes"], { platform: LINUX, rename });
  assert.equal(r.code, 1);
  assert.match(r.err, /The move stopped: EIO/);
  assert.deepEqual(diffTrees(before.base, everything(w).base), [], "every file and every link as it was");
});

test("when the original cannot be listed again as it is looked at once more (a file went away), the move keeps it and says so; it does not end in an error after the profiles were written (found by review)", async () => {
  const w = fresh("mv55", { variable: false });
  const realWrite = fs.writeFileSync;
  const realRead = fs.readdirSync;
  let armed = false;
  fs.writeFileSync = (p, ...rest) => { if (String(p).includes("relocate-manifest.json.tmp-")) armed = true; return realWrite.call(fs, p, ...rest); };
  fs.readdirSync = (p, ...rest) => { const names = realRead.call(fs, p, ...rest); return armed && path.resolve(String(p)) === w.cfg ? [...names, "ghost.txt"] : names; };
  let r;
  try { r = await moveJson(["--to", w.dest, "--yes", "--no-env"], w, { rename: exdev, drive: secondDriveAt(w.dest) }); } finally { fs.writeFileSync = realWrite; fs.readdirSync = realRead; }
  assert.equal(r.code, 1, r.all);
  assert.ok(r.json.warnings.some((x) => /a file in it went away while it was looked at again: ENOENT\) changed after the copy was checked, so the original was not removed/.test(x)), r.json.warnings.join(" | "));
  assert.ok(lexists(path.join(w.cfg, "settings.json")), "the original is kept");
  assert.equal(manifestOf(w.dest).originalKept, true);
});

test("a ~/.claude.json next to the old folder that cannot be removed is said so, kept in the manifest, and named in undo's refusal (found by review)", async () => {
  const w = fresh("mv56", { variable: false });
  const over = { rename: exdev, drive: secondDriveAt(w.dest) };
  const real = fs.rmSync;
  fs.rmSync = (p, o) => { if (path.resolve(String(p)) === w.claudeJson) throw Object.assign(new Error("EBUSY: resource busy or locked, unlink"), { code: "EBUSY" }); return real.call(fs, p, o); };
  let r;
  try { r = await moveJson(["--to", w.dest, "--yes", "--no-env"], w, over); } finally { fs.rmSync = real; }
  assert.equal(r.code, 1, r.all);
  assert.ok(r.json.warnings.some((x) => x.includes("Could not remove") && x.includes(".claude.json") && x.includes("EBUSY")), r.json.warnings.join(" | "));
  assert.equal(manifestOf(w.dest).jsonLeft, true);
  const refused = await runJson(["undo", "--yes"], { ...w, env: { ...w.env, CLAUDE_CONFIG_DIR: w.dest } }, { sys: w.sys(over) });
  assert.equal(refused.code, 1);
  assert.match(refused.json.error, /\.claude\.json exists \(the move could not remove it\), and .* has to go back there\./);
});
