// Small shared helpers: errors, sizes and dates, colours, paths that compare the way the file system does,
// reading and writing files.
import fs from "node:fs";
import path from "node:path";

// A refusal the person can act on (a folder in the way, no space, a claude process running): exit code 1.
export class UserError extends Error {
  constructor(message, code = "refused") { super(message); this.code = code; }
}
// A command line that cannot be run (unknown option, a missing folder): exit code 2.
export class UsageError extends Error {}
export const fail = (message, code) => { throw new UserError(message, code); };

export const MiB = 1048576;

// Compares two strings by code unit: the same order on every machine, whatever its locale.
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// Numbers, sizes, dates
// ---------------------------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, "0");
const num = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
export const count = num;

// 950 -> "950 B", 12345 -> "12 KB", 4400000 -> "4.2 MB", 3e9 -> "2.8 GB", 3e12 -> "2.7 TB".
export function size(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} B`;
  const kb = Math.round(n / 1024);
  if (kb < 1024) return `${kb} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  if (n < 1099511627776) return `${(n / 1073741824).toFixed(1)} GB`;
  return `${(n / 1099511627776).toFixed(1)} TB`;
}

export const isoOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "");

// 2026-10-16, local time, for the person at the keyboard (the manifest keeps the UTC time).
export function localDay(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 20261016-083012, local time, for backup names.
export function fileStamp(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------------------------
// Colours: on for a terminal, off for pipes and when NO_COLOR is set.
// ---------------------------------------------------------------------------------------------

export function makeColors(env = process.env, isTTY = !!process.stdout.isTTY, off = false) {
  const forced = !!env.FORCE_COLOR && env.FORCE_COLOR !== "0";
  const on = !off && (forced || (isTTY && !env.NO_COLOR));
  const paint = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { on, bold: paint("1"), dim: paint("2"), red: paint("31"), green: paint("32"), yellow: paint("33"), cyan: paint("36") };
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export const tryParse = (text) => { try { return JSON.parse(text); } catch { return null; } };

export function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
// lstat: a link is a link, never what it points to. null when nothing is there.
export function statOf(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}
export const exists = (p) => statOf(p) !== null;
export function isEmptyDir(p) {
  try { return fs.readdirSync(p).length === 0; } catch { return false; }
}

// mkdir -p that leaves a folder alone when it is there already. Node's recursive mkdir throws EPERM for the root of a
// drive (the parent of --to D:/claude, D: being a drive) even though that root exists. Returns the first folder made, or null.
export function makeDirs(dir) {
  try { if (fs.statSync(dir).isDirectory()) return null; } catch { /* not there yet */ }
  return plainPath(fs.mkdirSync(dir, { recursive: true }) || null);
}

// Node names the folder it made first with the extended-length prefix on Windows; the plain form is what the rest of
// this tool, and the manifest, use.
function plainPath(p) {
  const prefix = `${String.fromCharCode(92)}${String.fromCharCode(92)}?${String.fromCharCode(92)}`;
  if (!p || !p.startsWith(prefix)) return p;
  const rest = p.slice(prefix.length);
  const unc = `UNC${String.fromCharCode(92)}`;
  return rest.startsWith(unc) ? `${String.fromCharCode(92)}${String.fromCharCode(92)}${rest.slice(unc.length)}` : rest;
}

// Writes a file so a reader never sees half of it: a temporary name next to it, then a rename. A symbolic link
// is written through, so the link stays a link.
export function writeFileAtomic(file, text) {
  makeDirs(path.dirname(file));
  const st = statOf(file);
  if (st && st.isSymbolicLink()) { fs.writeFileSync(file, text); return; }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text, st ? { mode: st.mode & 0o7777 } : undefined);
    renameWithRetry(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw e;
  }
}

// Waits, without a timer (the callers are synchronous).
export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A rename onto a file that a virus scanner or an indexer is looking at fails for a moment on Windows (EPERM, EBUSY,
// EACCES): it is tried again a few times before the error is given.
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      sleepMs(50 * 2 ** attempt);
    }
  }
}

// "3 items (the first, C:/a/b: EPERM)" for what removeWhatYouCan could not remove.
export function describeLeft(left) {
  const first = left[0];
  return left.length === 1 ? `1 item (${first.path}: ${first.error})` : `${left.length} items (the first, ${first.path}: ${first.error})`;
}

// `base` if nothing is there yet, else `base-2`, `base-3` ...
export function uniquePath(base) {
  if (!exists(base)) return base;
  for (let i = 2; i < 1000; i++) if (!exists(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

// The path with forward slashes, for text that must read the same everywhere.
export const forwardSlashes = (p) => String(p).replace(/\\/g, "/");

// ---------------------------------------------------------------------------------------------
// Paths. Windows and macOS file systems ignore case by default, so paths compare lower-cased there.
// ---------------------------------------------------------------------------------------------

const FOLD = process.platform === "win32" || process.platform === "darwin";
export const fold = (p) => (FOLD ? p.toLowerCase() : p);

// The folder given as an absolute path, a leading ~ meaning the home folder.
export function resolveFolder(p, cwd, home) {
  let s = String(p);
  // ~/x everywhere; ~\x only where a backslash separates names (on Linux and macOS it is a letter of a name)
  if (home && (s === "~" || s.startsWith("~/") || (path.sep === "\\" && s.startsWith("~\\")))) s = path.join(home, s.slice(1));
  return path.resolve(cwd || process.cwd(), s);
}

// The real path of the deepest part that exists, with the rest appended: where a folder that is not there yet
// would end up once links are followed.
export function realLoose(p) {
  const start = path.resolve(p);
  let cur = start;
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return start;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export const samePath = (a, b) => fold(path.resolve(a)) === fold(path.resolve(b));

// Is `p` the folder `root` or somewhere below it? (Text only: links are not followed.)
export function isInside(root, p) {
  const rel = path.relative(fold(path.resolve(root)), fold(path.resolve(p)));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// The nearest folder that exists at or above `p`.
export function nearestExisting(p) {
  let cur = path.resolve(p);
  for (;;) {
    const st = statOf(cur);
    if (st) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}
