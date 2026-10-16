import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TIME_TOLERANCE_MS, compareSnapshots, copyTree, fileRow, makeLink, newTargetFor, pruneEmpty, removeEmptyParents, removeIfEmpty, removeTree, retargetLinks, snapshot } from "../src/walk.mjs";
import { IS_WIN, lexists, put, tmpDir, tree } from "./helpers.mjs";

const T0 = Date.parse("2026-08-01T12:34:56.789Z");

// A tree with every kind of thing a config folder holds, with distinct file times.
function sample(root) {
  put(path.join(root, "a.txt"), "alpha", T0);
  put(path.join(root, "dir", "b.txt"), "beta beta", T0 + 5000);
  put(path.join(root, "dir", "sub", "c.bin"), Buffer.from([0, 1, 2, 3, 255]), T0 + 9000);
  put(path.join(root, "with space", "d e.txt"), "spaces", T0 + 12000);
  put(path.join(root, "unicode-é-日本", "ü.txt"), "unicode", T0 + 15000);
  fs.mkdirSync(path.join(root, "empty"), { recursive: true });
  return root;
}

test("snapshot records files, folders and links with sizes, and counts them; links are not followed", () => {
  const dir = sample(tmpDir());
  const other = tmpDir();
  put(path.join(other, "big"), "x".repeat(5000));
  fs.symlinkSync(other, path.join(dir, "lnk"), IS_WIN ? "junction" : "dir");
  const s = snapshot(dir);
  assert.equal(s.files, 5);
  assert.equal(s.links, 1);
  assert.equal(s.dirs, 5);
  assert.equal(s.bytes, 5 + 9 + 5 + 6 + 7);
  assert.equal(s.entries.get("dir/sub/c.bin").size, 5);
  assert.equal(s.entries.get("lnk").t, "l");
  assert.ok(!s.entries.has("lnk/big"));
  assert.equal(s.entries.get("empty").t, "d");
});

test("copyTree copies every file, folder (also empty ones) and name, keeping file times to the millisecond", () => {
  const src = sample(tmpDir());
  const dst = path.join(tmpDir(), "copy");
  const ctx = { skipped: [] };
  copyTree(src, dst, ctx);
  assert.deepEqual(tree(dst), tree(src));
  for (const rel of ["a.txt", "dir/b.txt", "dir/sub/c.bin", "with space/d e.txt", "unicode-é-日本/ü.txt"]) {
    const a = fs.statSync(path.join(src, rel)).mtimeMs;
    const b = fs.statSync(path.join(dst, rel)).mtimeMs;
    assert.ok(Math.abs(a - b) <= 1, `${rel}: ${a} vs ${b}`);
  }
  assert.ok(Math.abs(fs.statSync(path.join(src, "dir")).mtimeMs - fs.statSync(path.join(dst, "dir")).mtimeMs) <= 1, "folder times too");
  assert.deepEqual(ctx.skipped, []);
});

test("copyTree keeps the permission bits of files and folders (POSIX)", { skip: IS_WIN && "Windows has no permission bits" }, () => {
  const src = tmpDir();
  put(path.join(src, "run.sh"), "#!/bin/sh\n");
  fs.chmodSync(path.join(src, "run.sh"), 0o755);
  put(path.join(src, "secret", ".credentials.json"), "{}");
  fs.chmodSync(path.join(src, "secret", ".credentials.json"), 0o600);
  fs.chmodSync(path.join(src, "secret"), 0o700);
  put(path.join(src, "readonly", "f"), "x");
  fs.chmodSync(path.join(src, "readonly"), 0o500);
  const dst = path.join(tmpDir(), "copy");
  try {
    copyTree(src, dst, { skipped: [] });
    const mode = (p) => fs.statSync(p).mode & 0o777;
    assert.equal(mode(path.join(dst, "run.sh")), 0o755);
    assert.equal(mode(path.join(dst, "secret", ".credentials.json")), 0o600);
    assert.equal(mode(path.join(dst, "secret")), 0o700);
    assert.equal(mode(path.join(dst, "readonly")), 0o500, "a read-only folder is copied (it is made writable only while it is filled)");
    assert.equal(fs.readFileSync(path.join(dst, "readonly", "f"), "utf8"), "x");
  } finally {
    for (const d of [src, dst]) { try { fs.chmodSync(path.join(d, "readonly"), 0o700); } catch { /* not there */ } }
  }
});

test("copyTree copies links as links: relative ones as they are, absolute ones into the copied folder re-aimed there", () => {
  const src = tmpDir();
  put(path.join(src, "real", "f.txt"), "data");
  const outside = tmpDir();
  put(path.join(outside, "o.txt"), "outside");
  fs.symlinkSync(path.join("real", "f.txt"), path.join(src, "rel-link.txt"), "file");
  fs.symlinkSync(path.join(src, "real", "f.txt"), path.join(src, "abs-inside.txt"), "file");
  fs.symlinkSync(path.join(outside, "o.txt"), path.join(src, "abs-outside.txt"), "file");
  fs.symlinkSync(path.join(src, "real"), path.join(src, "dir-link"), IS_WIN ? "junction" : "dir");
  const dst = path.join(tmpDir(), "copy");
  copyTree(src, dst, { skipped: [], rewrite: { from: src, to: dst } });
  assert.equal(fs.readlinkSync(path.join(dst, "rel-link.txt")), path.join("real", "f.txt"));
  assert.equal(path.resolve(fs.readlinkSync(path.join(dst, "abs-inside.txt"))), path.join(dst, "real", "f.txt"), "re-aimed at the copy");
  assert.equal(path.resolve(fs.readlinkSync(path.join(dst, "abs-outside.txt"))), path.join(outside, "o.txt"), "outside links stay");
  assert.equal(path.resolve(fs.readlinkSync(path.join(dst, "dir-link"))), path.join(dst, "real"));
  assert.equal(fs.readFileSync(path.join(dst, "dir-link", "f.txt"), "utf8"), "data", "the copied link resolves");
  assert.equal(fs.readFileSync(path.join(dst, "abs-inside.txt"), "utf8"), "data");
});

test("copyTree copies a dangling link as a link", () => {
  const src = tmpDir();
  fs.symlinkSync(path.join(src, "gone.txt"), path.join(src, "dangling"), "file");
  const dst = path.join(tmpDir(), "copy");
  copyTree(src, dst, { skipped: [] });
  assert.ok(lexists(path.join(dst, "dangling")));
  assert.ok(fs.lstatSync(path.join(dst, "dangling")).isSymbolicLink());
});

test("copyTree leaves out what is not a file, a folder or a link, and says so (POSIX: a named pipe)", { skip: IS_WIN && "Windows has no named pipes in folders" }, (t) => {
  const src = tmpDir();
  put(path.join(src, "f"), "x");
  const r = spawnSync("mkfifo", [path.join(src, "pipe")]);
  if (r.status !== 0) { t.skip("mkfifo is not available"); return; }
  const dst = path.join(tmpDir(), "copy");
  const ctx = { skipped: [] };
  copyTree(src, dst, ctx);
  assert.deepEqual(ctx.skipped, [path.join(src, "pipe")]);
  assert.ok(!lexists(path.join(dst, "pipe")));
  assert.ok(lexists(path.join(dst, "f")));
});

test("copyTree works for paths over 260 characters (Windows long paths) and names with spaces and dots", () => {
  const src = tmpDir();
  let deep = src;
  while (deep.length < 330) deep = path.join(deep, `segment number ${deep.length}.with dots ${"x".repeat(20)}`);
  put(path.join(deep, "file.txt"), "deep", T0);
  const dst = path.join(tmpDir(), "copy");
  copyTree(src, dst, { skipped: [] });
  const before = snapshot(src);
  const after = snapshot(dst);
  assert.ok(compareSnapshots(before, after).ok);
  assert.ok([...after.entries.keys()].some((k) => k.endsWith("file.txt") && k.length > 260));
  removeTree(dst);
  assert.ok(!lexists(dst));
  removeTree(src);
  assert.ok(!lexists(src), "a tree with a path over 260 characters can be removed");
});

test("compareSnapshots: the same tree is the same; each kind of difference is named", () => {
  const src = sample(tmpDir());
  const dst = path.join(tmpDir(), "copy");
  copyTree(src, dst, { skipped: [] });
  const before = snapshot(src);
  assert.deepEqual(compareSnapshots(before, snapshot(dst)), { ok: true, count: 0, mismatches: [] });

  fs.rmSync(path.join(dst, "a.txt"));
  put(path.join(dst, "dir", "b.txt"), "different size", T0 + 5000);
  put(path.join(dst, "extra.txt"), "x");
  fs.rmSync(path.join(dst, "empty"), { recursive: true });
  fs.writeFileSync(path.join(dst, "empty"), "now a file");
  fs.utimesSync(path.join(dst, "with space", "d e.txt"), (T0 + 12000 + 60000) / 1000, (T0 + 12000 + 60000) / 1000);
  const r = compareSnapshots(before, snapshot(dst));
  assert.equal(r.ok, false);
  const byPath = Object.fromEntries(r.mismatches.map((m) => [m.path, m.problem]));
  assert.match(byPath["a.txt"], /missing from the copy/);
  assert.match(byPath["dir/b.txt"], /size 9 became 14/);
  assert.match(byPath["extra.txt"], /in the copy and not in the original/);
  assert.match(byPath.empty, /folder in the original and a file in the copy/);
  assert.match(byPath["with space/d e.txt"], /file time was not kept/);
  assert.equal(r.count, 5);
});

test("compareSnapshots accepts file times that differ by less than the tolerance and no more", () => {
  const a = tmpDir();
  const b = tmpDir();
  put(path.join(a, "f"), "x", T0);
  put(path.join(b, "f"), "x", T0 + TIME_TOLERANCE_MS - 1);
  assert.ok(compareSnapshots(snapshot(a), snapshot(b)).ok);
  fs.utimesSync(path.join(b, "f"), (T0 + TIME_TOLERANCE_MS + 1000) / 1000, (T0 + TIME_TOLERANCE_MS + 1000) / 1000);
  assert.equal(compareSnapshots(snapshot(a), snapshot(b)).ok, false);
});

test("compareSnapshots checks link targets: the same text, or the text a move gives a link (see newTargetFor)", () => {
  const a = tmpDir();
  const b = tmpDir();
  fs.symlinkSync(path.join(a, "inside"), path.join(a, "l"), "file");
  fs.symlinkSync(path.join(b, "inside"), path.join(b, "l"), "file");
  assert.equal(compareSnapshots(snapshot(a), snapshot(b)).ok, false, "an absolute link into the old folder must change for a copy");
  assert.ok(compareSnapshots(snapshot(a), snapshot(b), { rewrite: { from: a, to: b } }).ok);
  const c = tmpDir();
  fs.symlinkSync(path.join(a, "inside"), path.join(c, "l"), "file");
  assert.ok(compareSnapshots(snapshot(a), snapshot(c)).ok, "unchanged text is the same");
  assert.equal(compareSnapshots(snapshot(a), snapshot(c), { rewrite: { from: a, to: b } }).ok, false, "but not when the move says it should have been re-aimed");
});

test("newTargetFor: absolute links into the moved folder follow it, relative ones that stay inside stay, relative ones that leave become absolute", () => {
  const from = path.resolve(path.sep, "old", "cfg");
  const to = path.resolve(path.sep, "new", "place");
  const out = path.resolve(path.sep, "dotfiles", "claude");
  const r = { from, to };
  assert.equal(newTargetFor(path.join(from, "a", "b"), path.join(from, "x"), r), path.join(to, "a", "b"), "absolute inside");
  assert.equal(newTargetFor(out, path.join(from, "x"), r), out, "absolute outside");
  assert.equal(newTargetFor(path.join("..", "a"), path.join(from, "x"), r), path.join("..", "a"), "relative, still inside");
  assert.equal(newTargetFor(path.join("..", "..", "..", "dotfiles", "claude"), path.join(from, "x"), r), path.resolve(path.sep, "dotfiles", "claude"), "relative, leaving the folder: aimed at the same place by its full path");
  assert.equal(newTargetFor(path.join("..", "a"), path.join(from, "x"), { ...r, absoluteInside: true }), path.join(to, "a"), "relative inside, for a part that moves on its own");
  assert.equal(newTargetFor("whatever", path.join(from, "x"), {}), "whatever", "no move, no change");
});

test("copyTree turns a relative link that reaches outside the folder into an absolute one, so it still points at the same file", () => {
  const base = tmpDir();
  put(path.join(base, "dotfiles", "CLAUDE.md"), "my rules");
  put(path.join(base, "cfg", "settings.json"), "{}");
  fs.symlinkSync(path.join("..", "dotfiles", "CLAUDE.md"), path.join(base, "cfg", "CLAUDE.md"), "file");
  fs.symlinkSync(path.join("..", "..", "dotfiles"), path.join(base, "cfg", "sub-link"), IS_WIN ? "junction" : "dir");
  const dst = path.join(base, "deeper", "still", "newcfg");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  copyTree(path.join(base, "cfg"), dst, { skipped: [], rewrite: { from: path.join(base, "cfg"), to: dst } });
  assert.equal(fs.readFileSync(path.join(dst, "CLAUDE.md"), "utf8"), "my rules", "the copy of the link still reads the file");
  assert.ok(path.isAbsolute(fs.readlinkSync(path.join(dst, "CLAUDE.md"))));
});

test("retargetLinks re-aims, after a rename, the links that pointed into the old place, and counts them", () => {
  const base = tmpDir();
  const oldRoot = path.join(base, "old");
  const root = path.join(base, "new");
  put(path.join(oldRoot, "real", "f.txt"), "data");
  put(path.join(base, "elsewhere", "o.txt"), "outside");
  fs.symlinkSync(path.join(oldRoot, "real", "f.txt"), path.join(oldRoot, "abs-in"), "file");
  fs.symlinkSync(path.join("real", "f.txt"), path.join(oldRoot, "rel-in"), "file");
  fs.symlinkSync(path.join(base, "elsewhere", "o.txt"), path.join(oldRoot, "abs-out"), "file");
  fs.symlinkSync(path.join("..", "elsewhere", "o.txt"), path.join(oldRoot, "rel-out"), "file");
  fs.symlinkSync(path.join(oldRoot, "real"), path.join(oldRoot, "dir-abs-in"), IS_WIN ? "junction" : "dir");
  fs.renameSync(oldRoot, root);
  assert.equal(retargetLinks(root, oldRoot, { from: oldRoot, to: root }), 3, "abs-in, rel-out and dir-abs-in change; rel-in and abs-out do not");
  for (const name of ["abs-in", "rel-in", "abs-out", "rel-out"]) assert.ok(fs.existsSync(path.join(root, name)), `${name} resolves`);
  assert.equal(fs.readFileSync(path.join(root, "dir-abs-in", "f.txt"), "utf8"), "data");
  assert.equal(fs.readlinkSync(path.join(root, "rel-in")), path.join("real", "f.txt"), "a relative link inside is untouched");
  assert.equal(retargetLinks(root, oldRoot, { from: oldRoot, to: root }), 0, "a second pass changes nothing");
});

test("compareSnapshots can ignore a path, and reports only the first 20 differences", () => {
  const a = tmpDir();
  const b = tmpDir();
  for (let i = 0; i < 30; i++) put(path.join(a, `f${i}`), "x");
  put(path.join(b, "marker"), "m");
  const r = compareSnapshots(snapshot(a), snapshot(b), { ignore: (rel) => rel === "marker" });
  assert.equal(r.count, 30);
  assert.equal(r.mismatches.length, 20);
});

test("removeTree removes a tree and never follows a link: what a junction or symbolic link points at stays", () => {
  const keep = tmpDir();
  put(path.join(keep, "precious.txt"), "precious");
  const victim = tmpDir();
  put(path.join(victim, "f.txt"), "x");
  fs.symlinkSync(keep, path.join(victim, "dirlink"), IS_WIN ? "junction" : "dir");
  fs.symlinkSync(path.join(keep, "precious.txt"), path.join(victim, "filelink"), "file");
  removeTree(victim);
  assert.ok(!lexists(victim));
  assert.equal(fs.readFileSync(path.join(keep, "precious.txt"), "utf8"), "precious");
});

test("removeTree removes a single link without touching its target", () => {
  const keep = tmpDir();
  put(path.join(keep, "f"), "x");
  const holder = tmpDir();
  const link = path.join(holder, "l");
  fs.symlinkSync(keep, link, IS_WIN ? "junction" : "dir");
  removeTree(link);
  assert.ok(!lexists(link));
  assert.ok(fs.existsSync(path.join(keep, "f")));
});

test("removeTree removes read-only files, and read-only folders (POSIX)", () => {
  const dir = tmpDir();
  put(path.join(dir, "ro", "f.txt"), "x");
  fs.chmodSync(path.join(dir, "ro", "f.txt"), 0o444);
  if (!IS_WIN) fs.chmodSync(path.join(dir, "ro"), 0o500);
  removeTree(dir);
  assert.ok(!lexists(dir));
});

test("removeIfEmpty removes an empty folder and says no to one with something in it", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "e"));
  put(path.join(dir, "f", "x"), "x");
  assert.equal(removeIfEmpty(path.join(dir, "e")), true);
  assert.equal(removeIfEmpty(path.join(dir, "f")), false);
  assert.equal(removeIfEmpty(path.join(dir, "nope")), false);
});

test("makeLink makes a junction (Windows) or a symbolic link to a folder, and a symbolic link to a file", () => {
  const dir = tmpDir();
  put(path.join(dir, "real", "f"), "x");
  makeLink(path.join(dir, "real"), path.join(dir, "dl"), "dir");
  makeLink(path.join(dir, "real", "f"), path.join(dir, "fl"), "file");
  assert.ok(fs.lstatSync(path.join(dir, "dl")).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(dir, "fl")).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(dir, "dl", "f"), "utf8"), "x");
  assert.equal(fs.readFileSync(path.join(dir, "fl"), "utf8"), "x");
});

test("fileRow describes a file, a link and nothing", () => {
  const dir = tmpDir();
  put(path.join(dir, "f"), "abc", T0);
  fs.symlinkSync("somewhere", path.join(dir, "l"), "file");
  assert.equal(fileRow(path.join(dir, "f")).t, "f");
  assert.equal(fileRow(path.join(dir, "f")).size, 3);
  assert.deepEqual([fileRow(path.join(dir, "l")).t, fileRow(path.join(dir, "l")).target], ["l", "somewhere"]);
  assert.equal(fileRow(path.join(dir, "none")), null);
});

test("pruneEmpty removes a tree of empty folders, and stops at a file or a link", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "a", "b", "c"), { recursive: true });
  fs.mkdirSync(path.join(dir, "a", "d"));
  assert.equal(pruneEmpty(path.join(dir, "a")), true);
  assert.ok(!lexists(path.join(dir, "a")));
  put(path.join(dir, "x", "y", "file.txt"), "x");
  fs.mkdirSync(path.join(dir, "x", "empty"));
  assert.equal(pruneEmpty(path.join(dir, "x")), false, "a file keeps its folders");
  assert.ok(lexists(path.join(dir, "x", "y", "file.txt")));
  assert.ok(!lexists(path.join(dir, "x", "empty")), "but the empty folder beside it goes");
  const target = tmpDir();
  fs.mkdirSync(path.join(dir, "l"));
  fs.symlinkSync(target, path.join(dir, "l", "link"), IS_WIN ? "junction" : "dir");
  assert.equal(pruneEmpty(path.join(dir, "l")), false, "a link is something");
  assert.ok(lexists(target), "and what it points to is untouched");
  assert.equal(pruneEmpty(path.join(dir, "nothing-here")), false);
  assert.equal(pruneEmpty(path.join(dir, "x", "y", "file.txt")), false, "a file is not a folder");
});

test("removeEmptyParents walks up from a folder, removing the empty ones, and never the one it was told to stop at", () => {
  const dir = tmpDir();
  const base = path.join(dir, "cache", "claude");
  fs.mkdirSync(path.join(base, "plugins", "cache"), { recursive: true });
  removeEmptyParents(path.join(base, "plugins", "cache"), base);
  assert.ok(!lexists(path.join(base, "plugins")), "plugins/cache and plugins are gone");
  assert.ok(lexists(base), "the stop is still there");
  put(path.join(base, "plugins", "keep.txt"), "x");
  fs.mkdirSync(path.join(base, "plugins", "sub"));
  removeEmptyParents(path.join(base, "plugins", "sub"), base);
  assert.ok(!lexists(path.join(base, "plugins", "sub")) && lexists(path.join(base, "plugins", "keep.txt")), "it stops at the first folder with something in it");
  removeEmptyParents(path.join(dir, "elsewhere"), base);
  removeEmptyParents(path.join(dir), base);
  assert.ok(lexists(dir), "a folder outside the stop's tree is not touched");
});
