import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { VerifyError, copyAndVerify, moveEntry, moveFile } from "../src/transfer.mjs";
import { makeSys } from "../src/sys.mjs";
import { lexists, put, tmpDir, tree } from "./helpers.mjs";

const T0 = Date.parse("2026-08-01T12:34:56.789Z");
const exdev = () => { throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }); };

function sample(root) {
  put(path.join(root, "a.txt"), "alpha", T0);
  put(path.join(root, "dir", "b.txt"), "beta beta", T0 + 5000);
  put(path.join(root, "dir", "sub", "c.bin"), Buffer.from([0, 1, 2, 3, 255]), T0 + 9000);
  fs.mkdirSync(path.join(root, "empty"), { recursive: true });
  fs.symlinkSync(path.join("dir", "b.txt"), path.join(root, "rel-link"), "file");
  return root;
}

test("moveEntry on one drive renames: nothing is copied, times cannot change, the original is gone", () => {
  const base = tmpDir();
  const src = sample(path.join(base, "src"));
  const before = tree(src);
  const r = moveEntry(src, path.join(base, "deeper", "dst"), makeSys(), { skipped: [] });
  assert.equal(r.method, "rename");
  assert.equal(r.files, 3);
  assert.ok(!lexists(src));
  assert.deepEqual(tree(path.join(base, "deeper", "dst")), before);
});

test("moveEntry falls back to copy, check and delete when the rename crosses drives (EXDEV)", () => {
  const base = tmpDir();
  const src = sample(path.join(base, "src"));
  const before = tree(src);
  const sys = makeSys({ rename: exdev });
  const r = moveEntry(src, path.join(base, "dst"), sys, { skipped: [], copyFile: sys.copyFile });
  assert.equal(r.method, "copy");
  assert.ok(!lexists(src), "the original is deleted after the check");
  const after = tree(path.join(base, "dst"));
  assert.deepEqual(after, before, "same files, same content, same file times, same links");
});

test("moveEntry also copies when the rename is refused because something holds the folder (EPERM, EBUSY, EACCES)", () => {
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    const base = tmpDir();
    const src = sample(path.join(base, "src"));
    const sys = makeSys({ rename: () => { throw Object.assign(new Error(code), { code }); } });
    const r = moveEntry(src, path.join(base, "dst"), sys, { skipped: [], copyFile: sys.copyFile });
    assert.equal(r.method, "copy", code);
    assert.ok(!lexists(src));
  }
});

test("moveEntry does not hide other rename errors: the original stays and the error is thrown", () => {
  const base = tmpDir();
  const src = sample(path.join(base, "src"));
  const sys = makeSys({ rename: () => { throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); } });
  assert.throws(() => moveEntry(src, path.join(base, "dst"), sys, { skipped: [] }), { code: "ENOSPC" });
  assert.ok(lexists(path.join(src, "a.txt")));
  assert.ok(!lexists(path.join(base, "dst")));
});

test("moveEntry replaces an empty folder that is in the way, and puts it back if the move fails", () => {
  const base = tmpDir();
  const src = sample(path.join(base, "src"));
  fs.mkdirSync(path.join(base, "dst"));
  moveEntry(src, path.join(base, "dst"), makeSys(), { skipped: [] });
  assert.ok(lexists(path.join(base, "dst", "a.txt")));
  const src2 = sample(path.join(base, "src2"));
  fs.mkdirSync(path.join(base, "dst2"));
  const sys = makeSys({ rename: () => { throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); } });
  assert.throws(() => moveEntry(src2, path.join(base, "dst2"), sys, { skipped: [] }), { code: "ENOSPC" });
  assert.ok(fs.statSync(path.join(base, "dst2")).isDirectory(), "the empty folder that was there is still there");
});

test("moveEntry moves a single file and a single link too", () => {
  const base = tmpDir();
  put(path.join(base, "one.txt"), "one", T0);
  fs.symlinkSync("elsewhere", path.join(base, "lnk"), "file");
  assert.equal(moveEntry(path.join(base, "one.txt"), path.join(base, "x", "one.txt"), makeSys(), { skipped: [] }).method, "rename");
  assert.equal(fs.readFileSync(path.join(base, "x", "one.txt"), "utf8"), "one");
  assert.equal(Math.round(fs.statSync(path.join(base, "x", "one.txt")).mtimeMs), T0);
  const sys = makeSys({ rename: exdev });
  assert.equal(moveEntry(path.join(base, "lnk"), path.join(base, "x", "lnk"), sys, { skipped: [] }).method, "copy");
  assert.equal(fs.readlinkSync(path.join(base, "x", "lnk")), "elsewhere");
  assert.ok(!lexists(path.join(base, "lnk")));
});

test("copyAndVerify removes its own half-made copy and leaves the original alone when a file cannot be copied", () => {
  const base = tmpDir();
  const src = sample(path.join(base, "src"));
  const before = tree(src);
  let n = 0;
  const copyFile = (a, b, flags) => { if (++n === 2) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); return fs.copyFileSync(a, b, flags); };
  assert.throws(() => copyAndVerify(src, path.join(base, "dst"), { skipped: [], copyFile }), { code: "EIO" });
  assert.ok(!lexists(path.join(base, "dst")), "no half copy is left");
  assert.deepEqual(tree(src), before, "the original is untouched");
});

test("copyAndVerify refuses a copy that does not match: a file of the wrong size, a file time not kept", () => {
  const base = tmpDir();
  const src = sample(path.join(base, "src"));
  const before = tree(src);
  const truncating = (a, b, flags) => { fs.copyFileSync(a, b, flags); if (path.basename(a) === "b.txt") fs.writeFileSync(b, "short"); };
  assert.throws(() => copyAndVerify(src, path.join(base, "dst"), { skipped: [], copyFile: truncating }), (e) => e instanceof VerifyError && /dir\/b\.txt: size 9 became 5/.test(e.message) && /original was not touched/.test(e.message));
  assert.ok(!lexists(path.join(base, "dst")));
  assert.deepEqual(tree(src), before);
});

test("moveFile renames when it can, and copies, checks the size and deletes when it cannot", () => {
  const base = tmpDir();
  put(path.join(base, "a.json"), '{"a":1}', T0);
  assert.equal(moveFile(path.join(base, "a.json"), path.join(base, "n", "a.json"), makeSys()).method, "rename");
  assert.ok(!lexists(path.join(base, "a.json")));
  put(path.join(base, "b.json"), '{"b":22}', T0 + 1000);
  const sys = makeSys({ rename: exdev });
  const r = moveFile(path.join(base, "b.json"), path.join(base, "n", "b.json"), sys);
  assert.equal(r.method, "copy");
  assert.ok(!lexists(path.join(base, "b.json")));
  assert.equal(fs.readFileSync(path.join(base, "n", "b.json"), "utf8"), '{"b":22}');
  assert.equal(Math.round(fs.statSync(path.join(base, "n", "b.json")).mtimeMs), T0 + 1000);
});

test("moveFile can keep the original (for a move that deletes everything at the end), and checks the size of the copy", () => {
  const base = tmpDir();
  put(path.join(base, "c.json"), "ccc");
  const sys = makeSys({ rename: exdev });
  moveFile(path.join(base, "c.json"), path.join(base, "n", "c.json"), sys, { keepOriginal: true });
  assert.ok(lexists(path.join(base, "c.json")));
  assert.ok(lexists(path.join(base, "n", "c.json")));
  put(path.join(base, "d.json"), "dddd");
  const bad = makeSys({ rename: exdev, copyFile: (a, b) => fs.writeFileSync(b, "x") });
  assert.throws(() => moveFile(path.join(base, "d.json"), path.join(base, "n", "d.json"), bad), VerifyError);
  assert.ok(lexists(path.join(base, "d.json")), "the original stays");
  assert.ok(!lexists(path.join(base, "n", "d.json")), "the bad copy is removed");
});

test("moveFile with forceCopy never renames", () => {
  const base = tmpDir();
  put(path.join(base, "e.json"), "eee");
  let renamed = false;
  const sys = makeSys({ rename: () => { renamed = true; } });
  moveFile(path.join(base, "e.json"), path.join(base, "n", "e.json"), sys, { forceCopy: true });
  assert.equal(renamed, false);
  assert.ok(!lexists(path.join(base, "e.json")));
});

test("moveEntry: when the copy is whole but the original cannot be removed completely, the entry has moved: the rest is reported and nothing is taken back", () => {
  const base = tmpDir();
  const src = path.join(base, "from", "commands");
  put(path.join(src, "go.md"), "go\n", T0);
  put(path.join(src, "keep.md"), "keep\n", T0 + 1000);
  const dst = path.join(base, "to", "commands");
  const real = fs.rmSync;
  const holdsKeep = (p) => { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink() ? fs.readdirSync(p).some((n) => holdsKeep(path.join(p, n))) : path.basename(p) === "keep.md"; };
  fs.rmSync = (p, o) => { if (String(p).startsWith(src) && lexists(p) && holdsKeep(p)) throw Object.assign(new Error("EBUSY: resource busy or locked, unlink"), { code: "EBUSY" }); return real.call(fs, p, o); };
  let r;
  try {
    const sys = makeSys({ rename: exdev });
    r = moveEntry(src, dst, sys, { skipped: [], copyFile: sys.copyFile });
  } finally { fs.rmSync = real; }
  assert.equal(r.method, "copy");
  assert.deepEqual(r.left.map((l) => [path.basename(l.path), l.error]), [["keep.md", "EBUSY"]]);
  assert.deepEqual(Object.keys(tree(dst)).sort(), ["go.md", "keep.md"], "the copy is whole");
  assert.deepEqual(Object.keys(tree(src)).sort(), ["keep.md"], "go.md is gone from the old place; keep.md stays");
});

test("moveFile with keepOriginal copies even where a rename would work, so that the original stays; without it the rename is used", () => {
  const base = tmpDir();
  put(path.join(base, "a.json"), "{}\n", T0);
  const kept = moveFile(path.join(base, "a.json"), path.join(base, "n", "b.json"), makeSys(), { keepOriginal: true });
  assert.equal(kept.method, "copy");
  assert.equal(fs.readFileSync(path.join(base, "a.json"), "utf8"), "{}\n", "the original is still there");
  assert.equal(fs.readFileSync(path.join(base, "n", "b.json"), "utf8"), "{}\n");
  const plain = moveFile(path.join(base, "a.json"), path.join(base, "n", "c.json"), makeSys());
  assert.equal(plain.method, "rename");
  assert.ok(!lexists(path.join(base, "a.json")));
});

test("moveEntry: a source that changed while it was being copied is not removed, the copy is taken away again, and the error says so", () => {
  const base = tmpDir();
  const src = sample(path.join(base, "src"));
  const dst = path.join(base, "dst");
  const copied = [];
  // the first file is changed after it was copied
  const copyFile = (a, b, flags) => { fs.copyFileSync(a, b, flags); copied.push(a); if (copied.length === 2) fs.appendFileSync(copied[0], "more\n"); };
  assert.throws(() => moveEntry(src, dst, makeSys({ rename: exdev }), { skipped: [], copyFile }), (e) => e.code === "changed-during-copy" && /changed while it was being copied \(1 difference, the first at a\.txt\), so nothing was removed from it\./.test(e.message));
  assert.ok(!lexists(dst), "the copy is gone");
  assert.match(fs.readFileSync(path.join(src, "a.txt"), "utf8"), /more/, "and the source has what was added to it");
  assert.ok(lexists(path.join(src, "dir", "b.txt")));
});
