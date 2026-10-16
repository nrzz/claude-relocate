// `move --xdg` on Linux and macOS: which parts of the config folder go to the state and the cache folders, each
// replaced inside the config folder by a symbolic link.
//
// SPLIT_VERIFIED says whether the real Claude Code was seen to work through such links. Linux and macOS are
// checked in CI (test/e2e-move.test.mjs, "xdg split"): a session written through the linked projects/ folder and
// resumed, a plugin loaded through the linked plugins/cache folder. If that check ever fails there, this is
// the one place to switch the split off, and `--xdg` then moves everything into one folder.
import path from "node:path";
import { CACHE_PARTS, STATE_PARTS } from "./inventory.mjs";
import { statOf } from "./util.mjs";

export const SPLIT_VERIFIED = true;

export function splitSupported(platform) {
  return SPLIT_VERIFIED && platform !== "win32";
}

const isRealFolder = (p) => { const st = statOf(p); return !!st && st.isDirectory() && !st.isSymbolicLink(); };

// The parts of `origin` that exist as real folders or files (a link there is moved as a link, not split off),
// each with where it goes: [{ path, area, from, to, link }]. `config` is the new config folder.
export function splitParts(origin, { config, state, cache }) {
  const parts = [];
  const add = (rel, area, base) => {
    const from = path.join(origin, ...rel.split("/"));
    const st = statOf(from);
    if (!st || st.isSymbolicLink()) return;
    // plugins/cache is a part only when plugins/ itself is a real folder
    if (rel.includes("/") && !isRealFolder(path.join(origin, rel.split("/")[0]))) return;
    parts.push({ path: rel, area, from, to: path.join(base, ...rel.split("/")), link: path.join(config, ...rel.split("/")) });
  };
  for (const rel of STATE_PARTS) add(rel, "state", state);
  for (const rel of CACHE_PARTS) add(rel, "cache", cache);
  return parts;
}
