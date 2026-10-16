import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readManifest } from "../src/manifest.mjs";
import { blockValue } from "../src/profiles.mjs";
import { INCOMPLETE } from "../src/move.mjs";
import { readUserEnv, writeUserEnv } from "../src/winenv.mjs";
import { IS_WIN, diffTrees, everything, exdev, lexists, noFileLinks, put, read, run, runJson, seedConfig, secondDriveAt, tmpDir, tree, world } from "./helpers.mjs";

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
  assert.match(r.out, /^claude-relocate 1\.0\.0 {2}move$/m);
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
