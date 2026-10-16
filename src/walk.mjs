// Folders as data: a snapshot of a tree (names, kinds, sizes, file times, link targets), a copy that keeps file
// times, a comparison of two snapshots, links that are re-aimed when the folder they sit in has moved, and a
// removal that never follows a link.
//
// Claude Code's cleanup deletes a session by its transcript file's modification time, so a move that gave every
// file the time of the copy would make a month of sessions look new, or, worse, a restored backup look old.
// Here the times are set again after the copy, and the comparison checks them.
import fs from "node:fs";
import path from "node:path";
import { isInside, samePath, statOf } from "./util.mjs";

// File systems keep times with different precision (FAT: two seconds), so times compare within this much.
export const TIME_TOLERANCE_MS = 2000;

const IS_WIN = process.platform === "win32";

// ---------------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------------

// A tree as { entries: Map<relative path with "/", row>, bytes, files, dirs, links, other }.
// row: { t: "d" | "f" | "l" | "o", size, mtimeMs, target, dir } (target and dir, the folder the link is in, only for
// links). Links are recorded, not followed.
export function snapshot(root) {
  const entries = new Map();
  const out = { entries, bytes: 0, files: 0, dirs: 0, links: 0, other: 0 };
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs)) {
      const p = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        entries.set(r, { t: "l", size: 0, mtimeMs: st.mtimeMs, target: fs.readlinkSync(p), dir: abs });
        out.links++;
      } else if (st.isDirectory()) {
        entries.set(r, { t: "d", size: 0, mtimeMs: st.mtimeMs });
        out.dirs++;
        walk(p, r);
      } else if (st.isFile()) {
        entries.set(r, { t: "f", size: st.size, mtimeMs: st.mtimeMs });
        out.bytes += st.size;
        out.files++;
      } else {
        entries.set(r, { t: "o", size: 0, mtimeMs: st.mtimeMs });
        out.other++;
      }
    }
  };
  walk(root, "");
  return out;
}

// One file as a snapshot row, or null.
export function fileRow(p) {
  const st = statOf(p);
  if (!st) return null;
  if (st.isSymbolicLink()) return { t: "l", size: 0, mtimeMs: st.mtimeMs, target: fs.readlinkSync(p), dir: path.dirname(p) };
  return { t: st.isFile() ? "f" : st.isDirectory() ? "d" : "o", size: st.size, mtimeMs: st.mtimeMs };
}

// ---------------------------------------------------------------------------------------------
// Where a link should point once the folder it is in has moved
// ---------------------------------------------------------------------------------------------

// A link inside a folder that moves from `from` to `to` (`oldLinkDir` is the folder the link was in before):
//   an absolute target inside `from` is re-aimed at the same place inside `to`;
//   a relative target that stays inside `from` is left alone: the folder moved as a whole, so it still works
//     (unless `absoluteInside`, for a part of the folder that moved on its own: then it becomes absolute, aimed inside `to`);
//   a relative target that reaches outside `from` (a dotfiles repository next to the folder) becomes absolute,
//     so that it keeps pointing at the same thing from the new place;
//   any other absolute target stays.
export function newTargetFor(target, oldLinkDir, { from, to, absoluteInside = false } = {}) {
  if (!from || !to) return target;
  const abs = path.isAbsolute(target) ? target : path.resolve(oldLinkDir, target);
  if (isInside(from, abs)) {
    if (!path.isAbsolute(target) && !absoluteInside) return target;
    return path.join(to, path.relative(path.resolve(from), path.resolve(abs)));
  }
  return abs;
}

const normTarget = (t) => (IS_WIN ? path.normalize(t).replace(/[\\/]+$/, "").toLowerCase() : t);
const sameTarget = (a, b) => normTarget(a) === normTarget(b);

// The type a link needs on Windows: a junction for a folder (given as an absolute path), a symbolic link for a
// relative path to a folder, a file link for anything else. Elsewhere the type is ignored.
function linkTypeOf(target, resolvedFrom) {
  if (!IS_WIN) return undefined;
  try {
    return fs.statSync(path.isAbsolute(target) ? target : path.resolve(resolvedFrom, target)).isDirectory() ? (path.isAbsolute(target) ? "junction" : "dir") : "file";
  } catch {
    return "file";
  }
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

const KIND_NAME = { d: "folder", f: "file", l: "link", o: "special file" };

// Differences between two snapshots: a path in one and not the other, another kind of entry, another size,
// another file time (beyond the tolerance), another link target (after `rewrite`: see newTargetFor; without it
// the targets must be the same text). Returns { ok, count, mismatches: [first 20] }.
export function compareSnapshots(before, after, { rewrite = null, tolerance = TIME_TOLERANCE_MS, ignore = () => false } = {}) {
  const mismatches = [];
  let count = 0;
  const add = (m) => { count++; if (mismatches.length < 20) mismatches.push(m); };
  for (const [rel, a] of before.entries) {
    if (ignore(rel)) continue;
    const b = after.entries.get(rel);
    if (!b) { add({ path: rel, problem: "missing from the copy" }); continue; }
    if (a.t !== b.t) { add({ path: rel, problem: `is a ${KIND_NAME[a.t]} in the original and a ${KIND_NAME[b.t]} in the copy` }); continue; }
    if (a.t === "f") {
      if (a.size !== b.size) add({ path: rel, problem: `size ${a.size} became ${b.size}` });
      else if (Math.abs(a.mtimeMs - b.mtimeMs) > tolerance) add({ path: rel, problem: "file time was not kept" });
    } else if (a.t === "l") {
      const expected = rewrite ? newTargetFor(a.target, a.dir, rewrite) : a.target;
      if (!sameTarget(expected, b.target)) add({ path: rel, problem: `link target ${a.target} became ${b.target}` });
    }
  }
  for (const rel of after.entries.keys()) {
    if (ignore(rel)) continue;
    if (!before.entries.has(rel)) add({ path: rel, problem: "is in the copy and not in the original" });
  }
  return { ok: count === 0, count, mismatches };
}

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

// A link to a folder: a junction on Windows (it needs no administrator), a symbolic link elsewhere.
// A link to a file: a file symbolic link (on Windows it needs Developer Mode or an administrator).
export function makeLink(target, linkPath, kind) {
  if (kind === "file") fs.symlinkSync(target, linkPath, "file");
  else fs.symlinkSync(target, linkPath, IS_WIN ? "junction" : "dir");
}

// After a folder was renamed from `oldRoot` to `root`, re-aims the links in it as newTargetFor says. Returns how many.
export function retargetLinks(root, oldRoot, rewrite) {
  let n = 0;
  const walk = (dir, oldDir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        const target = fs.readlinkSync(p);
        const next = newTargetFor(target, oldDir, rewrite);
        if (sameTarget(next, target)) continue;
        fs.rmSync(p, { force: true });
        fs.symlinkSync(next, p, linkTypeOf(next, dir));
        try { fs.lutimesSync(p, st.atimeMs / 1000, st.mtimeMs / 1000); } catch { /* link times are best effort */ }
        n++;
      } else if (st.isDirectory()) walk(p, path.join(oldDir, name));
    }
  };
  walk(root, oldRoot);
  return n;
}

// ---------------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------------

function setTimes(dst, st) {
  fs.utimesSync(dst, st.atimeMs / 1000, st.mtimeMs / 1000);
}

// Copies a file, folder or link from src to dst (which must not exist), keeping file times, modes and links as
// links; the links are re-aimed as newTargetFor says. Items that are not files, folders or links (sockets, pipes)
// are left out and listed in ctx.skipped.
// ctx: { skipped: [], copyFile, rewrite: { from, to } | null, absoluteInside }
export function copyTree(src, dst, ctx) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(src);
    const next = ctx.rewrite ? newTargetFor(target, path.dirname(src), { ...ctx.rewrite, absoluteInside: !!ctx.absoluteInside }) : target;
    fs.symlinkSync(next, dst, linkTypeOfSource(src, next));
    try { fs.lutimesSync(dst, st.atimeMs / 1000, st.mtimeMs / 1000); } catch { /* link times are best effort */ }
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { mode: (st.mode & 0o7777) | 0o700 });
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dst, name), ctx);
    if (!IS_WIN) fs.chmodSync(dst, st.mode & 0o7777);
    setTimes(dst, st);
    return;
  }
  if (st.isFile()) {
    (ctx.copyFile || fs.copyFileSync)(src, dst, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    setTimes(dst, st);
    return;
  }
  ctx.skipped.push(src);
}

// The type for a copy of a link on Windows, from what the original link points at.
function linkTypeOfSource(srcLink, next) {
  if (!IS_WIN) return undefined;
  try {
    return fs.statSync(srcLink).isDirectory() ? (path.isAbsolute(next) ? "junction" : "dir") : "file";
  } catch {
    return "file";
  }
}

// ---------------------------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------------------------

// Makes every folder below p writable for its owner, so that it can be emptied (POSIX only).
function openUp(p) {
  const st = statOf(p);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
  try { fs.chmodSync(p, (st.mode & 0o7777) | 0o700); } catch { /* not ours */ }
  for (const name of fs.readdirSync(p)) openUp(path.join(p, name));
}

// Removes a file, link or folder. Links are removed as links: what they point at stays where it is.
export function removeTree(p) {
  const opts = { recursive: true, force: true, maxRetries: 4, retryDelay: 250 };
  try {
    fs.rmSync(p, opts);
  } catch (e) {
    // a folder that cannot be written into: some systems say EACCES or EPERM, others only ENOTEMPTY for the folder above it
    if (IS_WIN || !["EACCES", "EPERM", "ENOTEMPTY"].includes(e.code)) throw e;
    openUp(p);
    fs.rmSync(p, opts);
  }
}

// Removes a folder if it is empty. Returns whether it is gone.
export function removeIfEmpty(p) {
  try { fs.rmdirSync(p); return true; } catch { return false; }
}

// Removes the folder `from` and then the folders above it, each only if it is empty, and stops before `stopAt`
// (which stays) or at the first folder with something in it. For the folders a move made inside the state and cache folders.
export function removeEmptyParents(from, stopAt) {
  let dir = from;
  while (isInside(stopAt, dir) && !samePath(dir, stopAt) && removeIfEmpty(dir)) dir = path.dirname(dir);
}

// Removes p and the folders below it when nothing but folders is in them (no file, no link). Returns whether p is gone.
// For the folders a move made on the way to a destination, once they hold nothing again.
export function pruneEmpty(p) {
  const st = statOf(p);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  let empty = true;
  for (const name of fs.readdirSync(p)) if (!pruneEmpty(path.join(p, name))) empty = false;
  if (!empty) return false;
  try { fs.rmdirSync(p); return true; } catch { return false; }
}
