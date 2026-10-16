// Moving one file or folder from a place to another: a rename when both are on one drive (nothing is copied,
// file times cannot change), else a copy that keeps file times, a check that the copy has the same files with the
// same sizes, and only then the removal of the original. A rename that fails because the two places are on
// different drives (EXDEV), or because something holds a file open, falls back to the copy.
import fs from "node:fs";
import path from "node:path";
import { UserError, exists, makeDirs, statOf } from "./util.mjs";
import { compareSnapshots, copyTree, fileRow, removeTree, removeWhatYouCan, snapshot } from "./walk.mjs";

// Rename errors after which a copy may still work.
export const COPY_INSTEAD = new Set(["EXDEV", "EPERM", "EACCES", "EBUSY"]);

export class VerifyError extends UserError {
  constructor(message, mismatches) { super(message, "verify-failed"); this.mismatches = mismatches; }
}

// A snapshot of src, whether it is a folder, a file or a link: { entries, bytes, files }.
function snapshotAny(src) {
  const st = statOf(src);
  if (st && st.isDirectory() && !st.isSymbolicLink()) return snapshot(src);
  const row = fileRow(src);
  const entries = new Map([["", row]]);
  return { entries, bytes: row && row.t === "f" ? row.size : 0, files: row && row.t === "f" ? 1 : 0, dirs: 0, links: row && row.t === "l" ? 1 : 0, other: 0 };
}

const describe = (same) => `${same.count} difference${same.count === 1 ? "" : "s"}, first: ${same.mismatches[0].path}: ${same.mismatches[0].problem}`;

// Copies src to dst (not there yet), checks the copy against src, and returns the snapshot of src. Does not
// remove src. On a failure the copy is removed again, so that dst is as it was, and the error is thrown.
export function copyAndVerify(src, dst, ctx) {
  const before = snapshotAny(src);
  try {
    copyTree(src, dst, ctx);
    const rewrite = ctx.rewrite ? { ...ctx.rewrite, absoluteInside: !!ctx.absoluteInside } : null;
    const same = compareSnapshots(before, snapshotAny(dst), { rewrite });
    if (!same.ok) throw new VerifyError(`The copy of ${src} does not match the original (${describe(same)}). The original was not touched.`, same.mismatches);
  } catch (e) {
    try { removeTree(dst); } catch { /* best effort: the copy was ours */ }
    throw e;
  }
  return before;
}

// Moves src to dst. dst's folder is created; dst itself must not exist, or be an empty folder.
// Returns { method: "rename" | "copy", bytes, files, left? }. ctx: see copyTree. sys: rename and copyFile.
// `left` is what a copy could not remove from src afterwards ([{ path, error }]): the copy is whole and checked by
// then, so the entry has moved, and the caller says what stays behind. (Taking the copy away again would lose the
// files the removal had already deleted.)
// After a rename, links inside that point into the old place are NOT re-aimed here (the caller does that once, when
// everything it moves has arrived: see retargetLinks in walk.mjs); a copy re-aims them as it goes.
export function moveEntry(src, dst, sys, ctx) {
  makeDirs(path.dirname(dst));
  const before = snapshotAny(src);
  const emptyDirInTheWay = exists(dst);
  if (emptyDirInTheWay) fs.rmdirSync(dst);
  try {
    sys.rename(src, dst);
    const same = compareSnapshots(before, snapshotAny(dst));
    if (!same.ok) {
      try { sys.rename(dst, src); } catch { /* leave it where it is and say so */ }
      throw new VerifyError(`After the rename, ${dst} does not match what was at ${src} (${describe(same)}).`, same.mismatches);
    }
    return { method: "rename", bytes: before.bytes, files: before.files };
  } catch (e) {
    if (e instanceof VerifyError || !COPY_INSTEAD.has(e.code)) {
      if (emptyDirInTheWay && !exists(dst)) { try { fs.mkdirSync(dst); } catch { /* it was empty anyway */ } }
      throw e;
    }
  }
  copyAndVerify(src, dst, ctx);
  // the original may have changed while the copy was made (a program started meanwhile): the copy then lacks that,
  // and the original must stay as it is
  const again = compareSnapshots(before, snapshotAny(src));
  if (!again.ok) {
    try { removeTree(dst); } catch { /* best effort: the copy was ours */ }
    throw new UserError(`${src} changed while it was being copied (${again.count} difference${again.count === 1 ? "" : "s"}, the first at ${again.mismatches[0].path || path.basename(src)}), so nothing was removed from it. Close Claude Code and the Claude desktop app, then run this again.`, "changed-during-copy");
  }
  const left = removeWhatYouCan(src);
  return { method: "copy", bytes: before.bytes, files: before.files, ...(left.length ? { left } : {}) };
}

// Copies the contents of a folder into a folder that exists (empty), keeping the times of both.
export function copyChildren(src, dstDir, ctx) {
  const st = fs.lstatSync(src);
  for (const name of fs.readdirSync(src)) {
    if (ctx.onEntry) ctx.onEntry(name);
    copyTree(path.join(src, name), path.join(dstDir, name), ctx);
  }
  if (process.platform !== "win32") fs.chmodSync(dstDir, st.mode & 0o7777);
  fs.utimesSync(dstDir, st.atimeMs / 1000, st.mtimeMs / 1000);
}

// A single file: rename, else copy, check the size, and remove the original. `keepOriginal` leaves it, for a move
// that removes everything at the end, and so never renames (a rename would take the original away at once).
export function moveFile(src, dst, sys, { keepOriginal = false, forceCopy = false } = {}) {
  const row = fileRow(src);
  makeDirs(path.dirname(dst));
  if (!forceCopy && !keepOriginal) {
    try { sys.rename(src, dst); return { method: "rename", bytes: row ? row.size : 0 }; } catch (e) { if (!COPY_INSTEAD.has(e.code)) throw e; }
  }
  const st = fs.lstatSync(src);
  sys.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
  fs.utimesSync(dst, st.atimeMs / 1000, st.mtimeMs / 1000);
  if (process.platform !== "win32") fs.chmodSync(dst, st.mode & 0o7777);
  const after = fileRow(dst);
  if (!after || after.size !== row.size) { fs.rmSync(dst, { force: true }); throw new VerifyError(`The copy of ${src} does not have the size of the original. The original was not touched.`, []); }
  if (!keepOriginal) fs.rmSync(src, { force: true });
  return { method: "copy", bytes: row.size };
}
