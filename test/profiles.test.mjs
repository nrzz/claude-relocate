import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { END, START, applyBlock, blockLines, blockValue, findBlock, fishQuote, otherAssignments, parseAssignment, planProfiles, profileCandidates, psQuote, readProfileText, readProfiles, removeProfile, shQuote, undoBlock, writeProfile } from "../src/profiles.mjs";
import { IS_WIN, noFileLinks, put, tmpDir, world } from "./helpers.mjs";

// Folder names a shell has to bring back exactly as they went in.
const TORTURE = [
  "/plain/path",
  "/path with spaces/and more",
  "/it's/a 'quoted' folder",
  "/dollar $HOME and `backticks` and $(subst) and ${braces}",
  "/semi;colon & ampersand | pipe > redirect < in",
  "/percent %PATH% and caret ^ and bang ! and hash # and tilde ~",
  "/unicode é日本語 ✓",
  "/back\\slash\\path\\",
  "C:\\Users\\me\\My Documents\\Claude Config",
  "/double \" quote and \\\" mix",
  "/trailing space ",
  "  /leading spaces",
  "/tab\there",
  "'",
  "''",
  "\\'",
  "\\\\",
  "a*b?c[d]e{f,g}",
];

// --- quoting, parsed back ---------------------------------------------------------------------------

test("every quoting function is undone by its parser, for names with every kind of special character", () => {
  for (const v of [...TORTURE, "\u2018curly\u2019 and \u201acomma\u201b"]) {
    for (const [syntax, quote] of [["posix", shQuote], ["fish", fishQuote], ["powershell", psQuote]]) {
      const line = blockLines(syntax, v)[1];
      assert.equal(parseAssignment(syntax, line), v, `${syntax}: ${JSON.stringify(v)} -> ${line}`);
      assert.ok(line.includes(quote(v)));
    }
  }
});

test("a folder name with a line break or a null character is refused: a profile line cannot hold it", () => {
  for (const v of ["/a\nb", "/a\rb", "/a\0b"]) assert.throws(() => blockLines("posix", v), { code: "bad-folder-name" });
});

test("parseAssignment reads only the line this tool writes", () => {
  assert.equal(parseAssignment("posix", "export CLAUDE_CONFIG_DIR=/no/quotes"), null);
  assert.equal(parseAssignment("posix", "CLAUDE_CONFIG_DIR='x'"), null);
  assert.equal(parseAssignment("posix", "export OTHER='x'"), null);
  assert.equal(parseAssignment("fish", "set CLAUDE_CONFIG_DIR 'x'"), null);
  assert.equal(parseAssignment("powershell", "$env:CLAUDE_CONFIG_DIR = \"x\""), null);
});

// --- real shells -------------------------------------------------------------------------------------

function onPath(cmd, args = ["--version"]) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 20000 });
  return !r.error && r.status === 0;
}
const gitBash = IS_WIN ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"].find((p) => fs.existsSync(p)) : null;
const BASH = onPath("bash") ? "bash" : gitBash;
const fwd = (p) => p.replace(/\\/g, "/");

// Source a profile in a shell and print what CLAUDE_CONFIG_DIR is afterwards.
function viaShell(shell, file) {
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR; // only the profile may set it
  const opts = { encoding: "utf8", windowsHide: true, env };
  if (shell === "bash") return spawnSync(BASH, ["-c", '. "$1"; printf %s "$CLAUDE_CONFIG_DIR"', "_", fwd(file)], opts);
  if (shell === "zsh") return spawnSync("zsh", ["-c", '. "$1"; printf %s "$CLAUDE_CONFIG_DIR"', "_", fwd(file)], opts);
  if (shell === "fish") return spawnSync("fish", ["-c", 'source $argv[1]; printf %s $CLAUDE_CONFIG_DIR', file], opts);
  const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; . '${file.replace(/'/g, "''")}'; [Console]::Out.Write($env:CLAUDE_CONFIG_DIR)`;
  return spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], opts);
}

for (const [shell, syntax, available] of [
  ["bash", "posix", !!BASH],
  ["zsh", "posix", onPath("zsh")],
  ["fish", "fish", onPath("fish")],
  ["powershell", "powershell", IS_WIN && onPath("powershell", ["-NoProfile", "-Command", "1"])],
  ["pwsh", "powershell", onPath("pwsh", ["-NoProfile", "-Command", "1"])],
]) {
  test(`${shell} brings back every awkward folder name exactly (the block is sourced by the real shell)`, { skip: !available && `${shell} is not installed here` }, () => {
    const dir = tmpDir();
    const values = shell === "bash" || shell === "zsh" ? TORTURE.filter((v) => !v.includes("\0")) : TORTURE;
    for (const v of [...values, ...(syntax === "powershell" ? ["\u2018curly\u2019 and \u201acomma\u201b"] : [])]) {
      // fish keeps only what fits a variable; a tab or a leading/trailing space survive in single quotes
      const profile = path.join(dir, "profile.ps1"); // PowerShell only runs a script with this extension
      const applied = applyBlock("existing line\n", syntax, v);
      fs.writeFileSync(profile, syntax === "powershell" ? `\uFEFF${applied.text}` : applied.text);
      const r = viaShell(shell, profile);
      assert.equal(r.status, 0, `${shell} failed on ${JSON.stringify(v)}: ${r.stderr}`);
      assert.equal(r.stdout, v, `${shell}: ${JSON.stringify(v)}`);
    }
  });
}

test("a new PowerShell profile with a non-ASCII folder name gets a byte-order mark, so Windows PowerShell 5.1 reads it as UTF-8", { skip: !(IS_WIN && onPath("powershell", ["-NoProfile", "-Command", "1"])) && "needs Windows PowerShell" }, () => {
  const w = world("psbom");
  const value = "D:\\Café Données\\claude 日本";
  const rec = writeProfile({ shell: "powershell", syntax: "powershell", file: path.join(w.home, "Documents", "WindowsPowerShell", "profile.ps1") }, value, { home: w.home });
  assert.equal(rec.created, true);
  assert.ok(fs.readFileSync(rec.file, "utf8").startsWith("\uFEFF"));
  const r = viaShell("powershell", rec.file);
  assert.equal(r.stdout, value);
});

// --- finding, adding and removing the block ----------------------------------------------------------

test("findBlock finds the first block, with LF or CRLF, an indented marker and a byte-order mark; none when it is unfinished", () => {
  const body = `${START}\nexport CLAUDE_CONFIG_DIR='/x'\n${END}\n`;
  assert.deepEqual(findBlock(`a\n${body}b\n`), { start: 2, end: 2 + body.length, text: body });
  const crlf = body.replace(/\n/g, "\r\n");
  assert.equal(findBlock(`a\r\n${crlf}b\r\n`).text, crlf);
  assert.equal(findBlock(`  ${START}  \n  x\n  ${END}  \n`).text, `  ${START}  \n  x\n  ${END}  \n`);
  assert.ok(findBlock(`\uFEFF${body}`));
  assert.equal(findBlock(`${START}\nno end\n`), null);
  assert.equal(findBlock(`${END}\n${START}\n`), null);
  assert.equal(findBlock(""), null);
  assert.equal(findBlock(`${body}${body}`).text, body, "the first of two");
});

test("applyBlock on an empty file creates, on a file adds at the end, on a file with the block replaces it", () => {
  const created = applyBlock("", "posix", "/x/y");
  assert.equal(created.action, "create");
  assert.equal(created.text, `${START}\nexport CLAUDE_CONFIG_DIR='/x/y'\n${END}\n`);
  const appended = applyBlock("alias a=b\n", "posix", "/x/y");
  assert.equal(appended.action, "append");
  assert.equal(appended.text, `alias a=b\n${START}\nexport CLAUDE_CONFIG_DIR='/x/y'\n${END}\n`);
  const replaced = applyBlock(appended.text, "posix", "/z");
  assert.equal(replaced.action, "replace");
  assert.equal(replaced.text, `alias a=b\n${START}\nexport CLAUDE_CONFIG_DIR='/z'\n${END}\n`);
  assert.equal(replaced.previous, `${START}\nexport CLAUDE_CONFIG_DIR='/x/y'\n${END}\n`);
});

test("applyBlock follows the file's line endings, and adds a line break first when the last line has none", () => {
  const crlf = applyBlock("alias a=b\r\nalias c=d\r\n", "posix", "/x");
  assert.equal(crlf.text, `alias a=b\r\nalias c=d\r\n${START}\r\nexport CLAUDE_CONFIG_DIR='/x'\r\n${END}\r\n`);
  const noEol = applyBlock("alias a=b", "posix", "/x");
  assert.equal(noEol.sepAdded, true);
  assert.equal(noEol.text, `alias a=b\n${START}\nexport CLAUDE_CONFIG_DIR='/x'\n${END}\n`);
  const ps = applyBlock("", "powershell", "D:\\x", { defaultEol: "\r\n" });
  assert.equal(ps.text, `${START}\r\n$env:CLAUDE_CONFIG_DIR = 'D:\\x'\r\n${END}\r\n`);
});

test("undoBlock gives back the exact bytes the file had before, for files of every shape", () => {
  const corpus = ["", "\n", "alias a=b\n", "alias a=b", "alias a=b\r\n", "alias a=b\r\nalias c=d", "\uFEFFalias a=b\n", "# only a comment\n\n\n", "line1\n\nline3\n\n", "no newline at all", "export X=1\nexport Y=2"];
  for (const original of corpus) {
    for (const syntax of ["posix", "fish", "powershell"]) {
      const applied = applyBlock(original, syntax, "/some/where");
      assert.ok(findBlock(applied.text), JSON.stringify(original));
      const undone = undoBlock(applied.text, applied);
      assert.equal(undone.removed, true);
      assert.equal(undone.text, original, `${syntax}: ${JSON.stringify(original)}`);
    }
  }
});

test("undoBlock restores the block it replaced, and only cuts its own lines when the person added text after it", () => {
  const first = applyBlock("a\n", "posix", "/one");
  const second = applyBlock(first.text, "posix", "/two");
  assert.equal(undoBlock(second.text, second).text, first.text, "back to the first move's block");
  const withMore = `${first.text}echo later\n`;
  assert.equal(undoBlock(withMore, first).text, "a\necho later\n");
  const noEolThenMore = applyBlock("a", "posix", "/one");
  assert.equal(undoBlock(`${noEolThenMore.text}echo later\n`, noEolThenMore).text, "a\necho later\n");
  assert.deepEqual(undoBlock("nothing here\n", first), { text: "nothing here\n", removed: false });
});

test("random profile text survives apply and undo byte for byte (300 files)", () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pieces = ["alias a=b", "export PATH=$PATH:/x", "# comment", "", "if [ -f x ]; then", "fi", "  indented", "\ttab", "ünïcode", "set -gx A 1", "$env:X = '1'"];
  for (let i = 0; i < 300; i++) {
    const eol = rnd() < 0.3 ? "\r\n" : "\n";
    const lines = Array.from({ length: Math.floor(rnd() * 12) }, () => pieces[Math.floor(rnd() * pieces.length)]);
    let original = lines.join(eol);
    if (lines.length && rnd() < 0.6) original += eol;
    if (rnd() < 0.1) original = `\uFEFF${original}`;
    const syntax = ["posix", "fish", "powershell"][Math.floor(rnd() * 3)];
    const applied = applyBlock(original, syntax, `/path ${i}/with 'quotes'`);
    assert.equal(undoBlock(applied.text, applied).text, original, `${i}: ${JSON.stringify(original)}`);
  }
});

test("otherAssignments finds lines outside the block that also set CLAUDE_CONFIG_DIR, in each shell's syntax", () => {
  const text = [
    "export CLAUDE_CONFIG_DIR=$HOME/old",
    "  export CLAUDE_CONFIG_DIR=\"/another\"",
    "CLAUDE_CONFIG_DIR=/plain; export CLAUDE_CONFIG_DIR",
    "set -gx CLAUDE_CONFIG_DIR /fish/way",
    "set --global --export CLAUDE_CONFIG_DIR /fish/way2",
    "$env:CLAUDE_CONFIG_DIR = 'D:\\old'",
    "setenv CLAUDE_CONFIG_DIR /csh",
    "# export CLAUDE_CONFIG_DIR=/commented-out",
    "echo $CLAUDE_CONFIG_DIR",
    "export MY_CLAUDE_CONFIG_DIR=/not-it",
    START, "export CLAUDE_CONFIG_DIR='/ours'", END,
  ].join("\n");
  assert.deepEqual(otherAssignments(text).map((o) => o.line), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(otherAssignments(`${START}\nexport CLAUDE_CONFIG_DIR='/ours'\n${END}\n`), []);
});

test("blockValue reads the value of the block in a file's text, or null", () => {
  assert.equal(blockValue(applyBlock("x\n", "posix", "/a b/c").text, "posix"), "/a b/c");
  assert.equal(blockValue("x\n", "posix"), null);
  assert.equal(blockValue(`${START}\nsomething else\n${END}\n`, "posix"), null);
});

// --- which files -------------------------------------------------------------------------------------

test("profile candidates: the bash, zsh and fish files everywhere, the two PowerShell profiles on Windows only", () => {
  const home = path.resolve(path.sep, "home", "me");
  const unix = profileCandidates({}, { home, platform: "linux" }).map((c) => path.relative(home, c.file).replace(/\\/g, "/"));
  assert.deepEqual(unix, [".bashrc", ".bash_profile", ".profile", ".zshrc", ".zshenv", ".config/fish/config.fish"]);
  const win = profileCandidates({}, { home, platform: "win32" }).map((c) => path.relative(home, c.file).replace(/\\/g, "/"));
  assert.deepEqual(win.slice(6), ["Documents/PowerShell/profile.ps1", "Documents/WindowsPowerShell/profile.ps1"]);
  const xdg = profileCandidates({ XDG_CONFIG_HOME: path.resolve(path.sep, "cfg") }, { home, platform: "linux" });
  assert.equal(xdg.find((c) => c.shell === "fish").file, path.join(path.resolve(path.sep, "cfg"), "fish", "config.fish"));
});

test("planProfiles: every profile that exists gets the block; none are created beside them", () => {
  const w = world("plan1", { shell: "/bin/bash" });
  put(path.join(w.home, ".bashrc"), "a\n");
  put(path.join(w.home, ".zshrc"), "b\n");
  put(path.join(w.home, ".profile"), "c\n");
  const plan = planProfiles(w.env, { home: w.home, platform: "linux" });
  assert.deepEqual(plan.map((p) => path.basename(p.file)), [".bashrc", ".profile", ".zshrc"]);
  assert.ok(plan.every((p) => p.exists && p.action === "append"));
});

test("planProfiles: a profile with the block already in it is a replace", () => {
  const w = world("plan2");
  put(path.join(w.home, ".bashrc"), applyBlock("", "posix", "/old").text);
  assert.equal(planProfiles(w.env, { home: w.home, platform: "linux" })[0].action, "replace");
});

test("planProfiles: with no file for the shell in use, the main file of that shell is created (and no other)", () => {
  for (const [shell, platform, expected] of [["/bin/bash", "linux", ".bashrc"], ["/bin/bash", "darwin", ".bash_profile"], ["/usr/bin/zsh", "darwin", ".zshrc"], ["/usr/bin/fish", "linux", path.join("fish", "config.fish")]]) {
    const w = world("plan3", { shell });
    const plan = planProfiles(w.env, { home: w.home, platform });
    assert.equal(plan.length, 1, shell);
    // fish reads $XDG_CONFIG_HOME/fish/config.fish, which the world sets to a folder of its own
    assert.equal(path.relative(shell.endsWith("fish") ? w.env.XDG_CONFIG_HOME : w.home, plan[0].file), expected);
    assert.equal(plan[0].action, "create");
    assert.equal(plan[0].exists, false);
  }
});

test("planProfiles: no profile is created for a shell this tool does not know, or when $SHELL is not set", () => {
  for (const shell of ["/bin/sh", "/usr/bin/nu", ""]) {
    const w = world("plan4", { shell });
    assert.deepEqual(planProfiles(w.env, { home: w.home, platform: "linux" }), [], shell);
  }
});

test("planProfiles: a bash user who has only ~/.profile is not given a .bashrc as well", () => {
  const w = world("plan5", { shell: "/bin/bash" });
  put(path.join(w.home, ".profile"), "x\n");
  assert.deepEqual(planProfiles(w.env, { home: w.home, platform: "linux" }).map((p) => path.basename(p.file)), [".profile"]);
});

test("planProfiles: on Windows no profile is created (the user environment reaches every shell), existing ones still get the block", () => {
  const w = world("plan6", { shell: "/usr/bin/bash" });
  assert.deepEqual(planProfiles(w.env, { home: w.home, platform: "win32" }), []);
  put(path.join(w.home, "Documents", "WindowsPowerShell", "profile.ps1"), "# mine\r\n");
  put(path.join(w.home, ".bashrc"), "x\n");
  assert.deepEqual(planProfiles(w.env, { home: w.home, platform: "win32" }).map((p) => p.shell), ["bash", "powershell"]);
});

// --- writing and removing in real files ----------------------------------------------------------------

test("writeProfile backs the file up first, next to it, and removeProfile takes only the block out, after another backup", () => {
  const w = world("write1");
  const file = put(path.join(w.home, ".bashrc"), "alias a=b\nexport PATH=$PATH:/x\n");
  const rec = writeProfile({ shell: "bash", syntax: "posix", file }, "/new place/claude", { home: w.home, now: 1000 });
  assert.equal(rec.action, "append");
  assert.equal(rec.created, false);
  assert.ok(rec.backup && path.dirname(rec.backup) === path.dirname(file) && /\.bashrc\.bak-claude-relocate-/.test(path.basename(rec.backup)));
  assert.equal(fs.readFileSync(rec.backup, "utf8"), "alias a=b\nexport PATH=$PATH:/x\n", "the backup is the original");
  assert.equal(blockValue(fs.readFileSync(file, "utf8"), "posix"), "/new place/claude");
  const out = removeProfile(rec, { now: 2000 });
  assert.equal(out.removed, true);
  assert.equal(out.deleted, false);
  assert.equal(fs.readFileSync(file, "utf8"), "alias a=b\nexport PATH=$PATH:/x\n");
  assert.ok(fs.readFileSync(out.backup, "utf8").includes(START), "the second backup holds the file with the block");
});

test("writeProfile creates a missing profile and its folders; removeProfile deletes it again, with the folders it made", () => {
  const w = world("write2", { shell: "/usr/bin/fish" });
  const norm = path.join(w.env.XDG_CONFIG_HOME, "fish", "config.fish");
  const rec = writeProfile({ shell: "fish", syntax: "fish", file: norm }, "/x/claude", { home: w.home });
  assert.equal(rec.created, true);
  assert.equal(rec.backup, null);
  assert.ok(rec.mkdirs.length >= 1);
  assert.ok(fs.existsSync(norm));
  const out = removeProfile(rec);
  assert.equal(out.deleted, true);
  assert.ok(!fs.existsSync(norm));
  assert.ok(!fs.existsSync(path.dirname(norm)), "the fish folder it created is gone");
});

test("removeProfile keeps a file this tool created if the person has added something to it since", () => {
  const w = world("write3");
  const file = path.join(w.home, ".zshrc");
  const rec = writeProfile({ shell: "zsh", syntax: "posix", file }, "/x", { home: w.home });
  fs.appendFileSync(file, "echo mine\n");
  const out = removeProfile(rec);
  assert.equal(out.deleted, false);
  assert.equal(fs.readFileSync(file, "utf8"), "echo mine\n");
});

test("removeProfile says so when the block or the file is gone, and changes nothing", () => {
  const w = world("write4");
  const file = put(path.join(w.home, ".bashrc"), "x\n");
  const rec = writeProfile({ shell: "bash", syntax: "posix", file }, "/x", { home: w.home });
  fs.writeFileSync(file, "x\n");
  assert.match(removeProfile(rec).note, /no claude-relocate block/);
  fs.rmSync(file);
  assert.match(removeProfile(rec).note, /file is gone/);
});

test("writeProfile writes through a symbolic link, so a dotfiles repository keeps its link", { skip: noFileLinks() }, () => {
  const w = world("write5");
  const real = put(path.join(w.base, "dotfiles", "bashrc"), "alias a=b\n");
  const link = path.join(w.home, ".bashrc");
  fs.symlinkSync(real, link, "file");
  writeProfile({ shell: "bash", syntax: "posix", file: link }, "/x", { home: w.home });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.readFileSync(real, "utf8").includes(START));
});

test("readProfiles reports each known profile: whether it exists, the value of the block, and other assignments", () => {
  const w = world("read1");
  put(path.join(w.home, ".bashrc"), `export CLAUDE_CONFIG_DIR=/old\n${applyBlock("", "posix", "/mine").text}`);
  put(path.join(w.home, ".zshrc"), "alias x=y\n");
  const list = readProfiles(w.env, { home: w.home, platform: "linux" });
  const bash = list.find((p) => p.file.endsWith(".bashrc"));
  assert.equal(bash.block, "/mine");
  assert.equal(bash.hasBlock, true);
  assert.deepEqual(bash.others.map((o) => o.line), [1]);
  const zsh = list.find((p) => p.file.endsWith(".zshrc"));
  assert.deepEqual([zsh.exists, zsh.block], [true, null]);
  assert.equal(list.find((p) => p.file.endsWith(".profile")).exists, false);
});

// --- files that are not UTF-8 text ---------------------------------------------------------------------

test("readProfileText reads UTF-8 text, with or without a byte-order mark, and says no to UTF-16 and to ANSI text with accents", () => {
  const dir = tmpDir();
  const write = (name, bytes) => { const f = path.join(dir, name); fs.writeFileSync(f, bytes); return f; };
  assert.deepEqual(readProfileText(write("plain", "alias a=b\n")), { ok: true, text: "alias a=b\n" });
  assert.deepEqual(readProfileText(write("empty", "")), { ok: true, text: "" });
  assert.deepEqual(readProfileText(write("utf8", "caf\u00e9 \u65e5\u672c\n")), { ok: true, text: "caf\u00e9 \u65e5\u672c\n" });
  assert.equal(readProfileText(write("bom", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x\n")]))).text, "\uFEFFx\n", "the mark stays in the text");
  const utf16 = readProfileText(write("utf16", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("alias a=b\n", "utf16le")])));
  assert.equal(utf16.ok, false);
  assert.match(utf16.reason, /^is not UTF-8 text \(it may be UTF-16, or use an ANSI code page\)$/);
  assert.equal(readProfileText(write("ansi", Buffer.from([0x23, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a]))).ok, false, "a lone \u00e9 byte in an ANSI file");
  assert.throws(() => readProfileText(dir), { code: "EISDIR" }, "a file that cannot be read throws, as fs does");
});

test("a profile that is not UTF-8 text is planned as skip, and writeProfile and removeProfile leave it alone, byte for byte", () => {
  const w = world("enc1");
  const latin = Buffer.concat([Buffer.from("# caf"), Buffer.from([0xe9]), Buffer.from("\nalias a=b\n")]);
  const file = path.join(w.home, ".bashrc");
  fs.writeFileSync(file, latin);
  put(path.join(w.home, ".zshrc"), "alias z=y\n");
  const plan = planProfiles(w.env, { home: w.home, platform: "linux" });
  assert.deepEqual(plan.map((p) => [path.basename(p.file), p.action]), [[".bashrc", "skip"], [".zshrc", "append"]]);
  assert.match(plan[0].skip, /^is not UTF-8 text/);
  assert.throws(() => writeProfile(plan[0], "/x", { home: w.home }), (e) => e.code === "profile-encoding" && /\.bashrc is not UTF-8 text .* so it is left alone\.$/.test(e.message));
  assert.ok(fs.readFileSync(file).equals(latin), "not one byte changed");
  assert.deepEqual(fs.readdirSync(w.home).filter((n) => n.includes("bak")), [], "and no backup of it was made");
  const rec = { file, shell: "bash", syntax: "posix", action: "append", previous: null, sepAdded: false, created: false, mkdirs: [], backup: null };
  const removed = removeProfile(rec);
  assert.deepEqual([removed.removed, removed.problem], [false, true]);
  assert.match(removed.note, /^is not UTF-8 text .*, so it is left alone$/);
  assert.ok(fs.readFileSync(file).equals(latin));
});

test("a folder name with a line separator or another unusual space (U+2028, U+2029, U+0085, U+00A0) is read back by every syntax (found by review)", () => {
  for (const v of ["/a\u2028b", "/a\u2029b", "/a\u0085b", "/a\u00a0b"]) {
    for (const syntax of ["posix", "fish", "powershell"]) assert.equal(parseAssignment(syntax, blockLines(syntax, v)[1]), v, `${syntax} ${JSON.stringify(v)}`);
  }
});

test("an existing PowerShell profile that is empty or only ASCII gets a byte-order mark with a non-ASCII folder name; undo takes it out again and the file is as it was (found by review)", () => {
  const w = world("psbom2");
  const value = ["D:", "Caf\u00e9 Donn\u00e9es", "claude \u65e5\u672c"].join(path.sep);
  for (const original of ["", "# my profile\r\nSet-Alias ll Get-ChildItem\r\n", "no final line break"]) {
    const file = path.join(w.home, "Documents", "WindowsPowerShell", `profile-${original.length}.ps1`);
    put(file, original);
    const rec = writeProfile({ shell: "powershell", syntax: "powershell", file }, value, { home: w.home });
    assert.equal(rec.created, false);
    assert.equal(rec.markAdded, true);
    const written = fs.readFileSync(file, "utf8");
    assert.ok(written.startsWith("\uFEFF"));
    assert.equal(blockValue(written, "powershell"), value);
    const out = removeProfile(rec, {});
    assert.equal(out.removed, true);
    assert.equal(fs.readFileSync(file, "utf8"), original, "no mark and no block: the file is as it was");
  }
});

test("an ASCII folder name adds no byte-order mark; a profile with non-ASCII text and no mark is not written for a non-ASCII name, and no backup is left (found by review)", () => {
  const w = world("psbom3");
  const file = path.join(w.home, "profile.ps1");
  const original = "# caf\u00e9\r\n";
  put(file, original);
  assert.throws(() => writeProfile({ shell: "powershell", syntax: "powershell", file }, ["D:", "Caf\u00e9"].join(path.sep), { home: w.home }), { code: "profile-encoding" });
  assert.equal(fs.readFileSync(file, "utf8"), original, "untouched");
  assert.deepEqual(fs.readdirSync(w.home).filter((n) => n.includes("bak-claude-relocate")), [], "and no backup is left behind");
  const rec = writeProfile({ shell: "powershell", syntax: "powershell", file }, "D:/claude", { home: w.home });
  assert.equal(rec.markAdded, false);
  assert.ok(!fs.readFileSync(file, "utf8").startsWith("\uFEFF"));
});

test("Windows PowerShell 5.1 brings back a non-ASCII folder name from an existing profile that was empty or ASCII (the real shell reads what was written)", { skip: !(IS_WIN && onPath("powershell", ["-NoProfile", "-Command", "1"])) && "needs Windows PowerShell" }, () => {
  const w = world("psbom4");
  const value = ["D:", "Caf\u00e9 Donn\u00e9es", "claude \u65e5\u672c"].join(path.sep);
  for (const original of ["", "# my profile\r\n"]) {
    const file = path.join(w.home, `p${original.length}.ps1`);
    put(file, original);
    writeProfile({ shell: "powershell", syntax: "powershell", file }, value, { home: w.home });
    const r = viaShell("powershell", file);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, value);
  }
});
