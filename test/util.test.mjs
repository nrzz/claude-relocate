import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { UsageError, UserError, cmp, count, exists, fail, fileStamp, forwardSlashes, fold, isEmptyDir, isInside, isoOf, listDir, localDay, makeColors, nearestExisting, plural, realLoose, resolveFolder, samePath, size, statOf, tryParse, uniquePath, writeFileAtomic } from "../src/util.mjs";
import { IS_WIN, lexists, noFileLinks, put, tmpDir } from "./helpers.mjs";

test("size writes bytes, KB, MB, GB and TB the way a person reads them", () => {
  assert.equal(size(0), "0 B");
  assert.equal(size(950), "950 B");
  assert.equal(size(1023), "1023 B");
  assert.equal(size(1024), "1 KB");
  assert.equal(size(12345), "12 KB");
  assert.equal(size(1048575), "1.0 MB", "never 1024 KB");
  assert.equal(size(1046528), "1022 KB");
  assert.equal(size(4400000), "4.2 MB");
  assert.equal(size(3e9), "2.8 GB");
  assert.equal(size(3e12), "2.7 TB");
  assert.equal(size(-5), "0 B");
  assert.equal(size("nonsense"), "0 B");
});

test("count and plural put thousands separators and the right word form", () => {
  assert.equal(count(0), "0");
  assert.equal(count(999), "999");
  assert.equal(count(1000), "1,000");
  assert.equal(count(1234567), "1,234,567");
  assert.equal(count(12.6), "13");
  assert.equal(plural(1, "file"), "1 file");
  assert.equal(plural(0, "file"), "0 files");
  assert.equal(plural(2, "session"), "2 sessions");
  assert.equal(plural(1500, "file"), "1,500 files");
  assert.equal(plural(2, "process", "processes"), "2 processes");
  assert.equal(plural(1, "process", "processes"), "1 process");
});

test("dates: isoOf is UTC, localDay and fileStamp are local, and a time that is not a number is empty", () => {
  const ms = new Date(2026, 9, 16, 8, 30, 12).getTime();
  assert.equal(localDay(ms), "2026-10-16");
  assert.equal(fileStamp(ms), "20261016-083012");
  assert.equal(isoOf(Date.UTC(2026, 9, 16, 3, 0, 0)), "2026-10-16T03:00:00.000Z");
  assert.equal(localDay(NaN), "");
  assert.equal(isoOf(NaN), "");
  assert.match(fileStamp(), /^\d{8}-\d{6}$/);
});

test("colours: on for a terminal, off for a pipe, NO_COLOR and --no-color; FORCE_COLOR forces them on", () => {
  const on = makeColors({}, true, false);
  assert.equal(on.on, true);
  assert.equal(on.bold("x"), "\x1b[1mx\x1b[0m");
  assert.equal(on.red("x"), "\x1b[31mx\x1b[0m");
  assert.equal(on.green("x"), "\x1b[32mx\x1b[0m");
  assert.equal(on.yellow("x"), "\x1b[33mx\x1b[0m");
  assert.equal(on.dim("x"), "\x1b[2mx\x1b[0m");
  assert.equal(on.cyan("x"), "\x1b[36mx\x1b[0m");
  assert.equal(makeColors({}, false, false).on, false, "not a terminal");
  assert.equal(makeColors({ NO_COLOR: "1" }, true, false).on, false);
  assert.equal(makeColors({}, true, true).on, false, "--no-color");
  assert.equal(makeColors({ FORCE_COLOR: "1" }, false, false).on, true);
  assert.equal(makeColors({ FORCE_COLOR: "0" }, false, false).on, false);
  assert.equal(makeColors({ FORCE_COLOR: "1" }, true, true).on, false, "--no-color wins over FORCE_COLOR");
  assert.equal(makeColors({}, false, false).bold("plain"), "plain");
  assert.equal(makeColors({}, false, false).red(5), "5");
});

test("cmp orders strings by code unit, the same on every machine", () => {
  assert.deepEqual(["b", "B", "a", "ä", "10", "9"].sort(cmp), ["10", "9", "B", "a", "b", "ä"]);
  assert.equal(cmp("a", "a"), 0);
});

test("tryParse is null for text that is not JSON; the errors carry a code", () => {
  assert.deepEqual(tryParse('{"a":1}'), { a: 1 });
  assert.equal(tryParse("{"), null);
  assert.equal(tryParse(""), null);
  assert.throws(() => fail("no room", "no-room"), (e) => e instanceof UserError && e.message === "no room" && e.code === "no-room");
  assert.equal(new UserError("x").code, "refused");
  assert.ok(new UsageError("x") instanceof Error);
});

test("statOf, exists, listDir and isEmptyDir never throw, and a link is a link", () => {
  const dir = tmpDir();
  put(path.join(dir, "f"), "x");
  fs.mkdirSync(path.join(dir, "empty"));
  fs.symlinkSync(path.join(dir, "gone"), path.join(dir, "dangling"), IS_WIN ? "junction" : "dir");
  assert.equal(statOf(path.join(dir, "nope")), null);
  assert.equal(exists(path.join(dir, "f")), true);
  assert.equal(exists(path.join(dir, "dangling")), true, "a link that leads nowhere is still there");
  assert.equal(statOf(path.join(dir, "dangling")).isSymbolicLink(), true);
  assert.deepEqual(listDir(path.join(dir, "nope")), []);
  assert.deepEqual(listDir(dir).map((e) => e.name).sort(), ["dangling", "empty", "f"]);
  assert.equal(isEmptyDir(path.join(dir, "empty")), true);
  assert.equal(isEmptyDir(dir), false);
  assert.equal(isEmptyDir(path.join(dir, "f")), false, "a file is not an empty folder");
  assert.equal(isEmptyDir(path.join(dir, "nope")), false);
});

test("writeFileAtomic writes a new file, replaces an old one in one step, leaves no temporary file, and creates folders", () => {
  const dir = tmpDir();
  const file = path.join(dir, "a", "b", "c.txt");
  writeFileAtomic(file, "one");
  assert.equal(fs.readFileSync(file, "utf8"), "one");
  writeFileAtomic(file, "two");
  assert.equal(fs.readFileSync(file, "utf8"), "two");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["c.txt"]);
});

test("writeFileAtomic keeps the permission bits of the file it replaces (POSIX)", { skip: IS_WIN && "Windows has no permission bits" }, () => {
  const file = put(path.join(tmpDir(), "secret"), "x");
  fs.chmodSync(file, 0o600);
  writeFileAtomic(file, "y");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("writeFileAtomic writes through a symbolic link, so the link stays a link", { skip: noFileLinks() }, () => {
  const dir = tmpDir();
  const real = put(path.join(dir, "real.txt"), "old");
  const link = path.join(dir, "link.txt");
  fs.symlinkSync(real, link, "file");
  writeFileAtomic(link, "new");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(real, "utf8"), "new");
});

test("writeFileAtomic removes its temporary file when the write fails", () => {
  const dir = tmpDir();
  const target = path.join(dir, "folder");
  fs.mkdirSync(target);
  assert.throws(() => writeFileAtomic(target, "x"));
  assert.deepEqual(fs.readdirSync(dir), ["folder"], "no .tmp file is left behind");
});

test("uniquePath is the path itself when free, then -2, -3 ...", () => {
  const dir = tmpDir();
  const base = path.join(dir, "backup");
  assert.equal(uniquePath(base), base);
  put(base, "x");
  assert.equal(uniquePath(base), `${base}-2`);
  put(`${base}-2`, "x");
  assert.equal(uniquePath(base), `${base}-3`);
});

test("forwardSlashes turns backslashes into slashes for text that must read the same everywhere", () => {
  assert.equal(forwardSlashes("C:\\Users\\me\\x"), "C:/Users/me/x");
  assert.equal(forwardSlashes("/already/fine"), "/already/fine");
});

test("paths compare the way the file system does: case-insensitive on Windows and macOS", () => {
  const same = fold("AbC") === "abc";
  assert.equal(same, process.platform === "win32" || process.platform === "darwin");
  assert.equal(samePath("/a/b/../c", "/a/c"), true);
  assert.equal(samePath(path.resolve("x"), path.resolve("./x/")), true);
  assert.equal(samePath("/a/b", "/a/c"), false);
  assert.equal(samePath("/A/B", "/a/b"), same);
});

test("isInside: the folder itself and anything below it, never a sibling that only starts with the same letters", () => {
  const root = path.resolve(path.sep, "data", "claude");
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, path.join(root, "projects", "x")), true);
  assert.equal(isInside(root, path.resolve(path.sep, "data", "claude-other")), false);
  assert.equal(isInside(root, path.resolve(path.sep, "data")), false);
  assert.equal(isInside(root, path.join(root, "..", "claude", "a")), true, "dots are resolved first");
  assert.equal(isInside(root, path.join(root, "..", "x")), false);
  assert.equal(isInside(path.parse(root).root, root), true, "everything is inside the top of the drive");
  if (IS_WIN) assert.equal(isInside("C:\\Data", "D:\\Data\\x"), false, "another drive is another tree");
});

test("resolveFolder: ~ is the home folder, a relative path is relative to the working folder", () => {
  const home = path.resolve(path.sep, "home", "me");
  const cwd = path.resolve(path.sep, "work");
  assert.equal(resolveFolder("~", cwd, home), home);
  assert.equal(resolveFolder("~/claude", cwd, home), path.join(home, "claude"));
  assert.equal(resolveFolder("~\\claude", cwd, home), path.join(home, "claude"));
  assert.equal(resolveFolder("~other", cwd, home), path.join(cwd, "~other"), "~other is not the home folder");
  assert.equal(resolveFolder("rel/dir", cwd, home), path.join(cwd, "rel", "dir"));
  assert.equal(resolveFolder(path.join(cwd, "abs"), cwd, home), path.join(cwd, "abs"));
  assert.equal(resolveFolder("a/../b", cwd, home), path.join(cwd, "b"));
});

test("realLoose follows links in the part that exists and appends the rest", () => {
  const dir = tmpDir();
  const real = path.join(dir, "real");
  fs.mkdirSync(real);
  const link = path.join(dir, "link");
  fs.symlinkSync(real, link, IS_WIN ? "junction" : "dir");
  assert.equal(realLoose(real), real);
  assert.equal(realLoose(path.join(link, "a", "b")).toLowerCase(), path.join(real, "a", "b").toLowerCase());
  assert.equal(realLoose(path.join(dir, "not", "there")), path.join(dir, "not", "there"));
  const root = path.parse(dir).root;
  assert.equal(realLoose(root).toLowerCase(), root.toLowerCase());
});

test("nearestExisting is the path itself when it is there, else the deepest folder above it that is", () => {
  const dir = tmpDir();
  assert.equal(nearestExisting(dir), dir);
  assert.equal(nearestExisting(path.join(dir, "a", "b", "c")), dir);
  put(path.join(dir, "file"), "x");
  assert.equal(nearestExisting(path.join(dir, "file", "below")), path.join(dir, "file"), "a file counts: the caller decides what to do with it");
  assert.ok(lexists(nearestExisting(path.join(path.parse(dir).root, "no-such-folder-for-sure", "x"))));
});
