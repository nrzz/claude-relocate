# claude-relocate

[![test](https://github.com/nrzz/claude-relocate/actions/workflows/test.yml/badge.svg)](https://github.com/nrzz/claude-relocate/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg) ![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg) [![part of the Claude Code toolkit](https://img.shields.io/badge/Claude%20Code-toolkit-d97757.svg)](https://github.com/nrzz/claude-code-toolkit)

Claude Code keeps its settings, sessions, plugin cache and `.claude.json` in your home folder, and the folder grows. [anthropics/claude-code#1455](https://github.com/anthropics/claude-code/issues/1455) (Claude Code does not respect the XDG Base Directory specification, 460 reactions on 2026-10-16) and [#2350](https://github.com/anthropics/claude-code/issues/2350) ask for the XDG folders. [#57998](https://github.com/anthropics/claude-code/issues/57998) asks for a way to move the desktop app's own folder on Windows when the C: drive is full. [#30538](https://github.com/anthropics/claude-code/issues/30538) reports that the VS Code extension ignores `CLAUDE_CONFIG_DIR`. That variable exists, but moving by hand means copying a folder, setting the variable in every shell, and finding out afterwards what broke. claude-relocate does the move with a plan before it and an undo after it. It shows what is in the folder and how big each kind is, moves it to another drive or into the XDG folders, keeps file times, sets `CLAUDE_CONFIG_DIR` in your shell profiles and the Windows user environment, can leave a junction or link at the old place for programs that ignore the variable, refuses while Claude Code is running, checks the result, and puts everything back on request. It is a plain Node program that runs outside Claude, so it costs no tokens. It cannot move the desktop app's own `%APPDATA%\Claude` folder (#57998); [How it works](#how-it-works) lists what it leaves alone.

## What you get

- `plan`: what is in the config folder, how big each kind is (settings, sessions, plugins, plugin cache, state and caches, `.claude.json`), where each would go, the room on the destination drive, which profiles would be written, and every reason a move would be refused.
- `move --to <folder>`: everything into one new folder, a second drive for example. A rename when the folder is on the same drive. Otherwise a copy that keeps file times, is checked against the original file by file, and only then replaces it.
- `move --xdg`: the XDG folders. On Linux and macOS the settings stay in `$XDG_CONFIG_HOME/claude`, the sessions and other state go to `$XDG_STATE_HOME/claude` and the caches to `$XDG_CACHE_HOME/claude`, each behind a symbolic link. On Windows everything goes into the one folder `$XDG_CONFIG_HOME/claude` (default `~/.config/claude`).
- `CLAUDE_CONFIG_DIR` written into the shell profiles that exist (bash, zsh, fish, PowerShell) between two marker lines, after a backup, and into the Windows user environment.
- `--link`: a junction (Windows) or a symbolic link at the old place, for programs that ignore the variable.
- A refusal while a Claude Code process or the Claude desktop app is open.
- `verify`: the variable in each profile and in the Windows user environment, the folder, the links, the list of sessions, and `claude --version` run with the variable pointing at the new place.
- `undo`: the folder, `.claude.json`, the links, the profiles and the Windows user environment put back as they were, from the manifest the move left.
- `status`: where things are now, and what each kind of new terminal will get.
- `--json` on every command, `--dry-run` on `move` and `undo`, and nothing is changed without `--yes`.

## What it costs in tokens

| Command | Tokens | What it does with Claude |
| --- | --- | --- |
| `claude-relocate plan` | 0 | Reads the config folder's names, sizes and file times, and the text of `settings.json` and `settings.local.json`. Starts `tasklist` or `ps` to see whether Claude is running |
| `claude-relocate move` | 0 | Moves files, edits shell profiles, writes the Windows user environment. Never calls Claude or the network |
| `claude-relocate verify` | 0 | Runs `claude --version`, which prints the version and exits. It sent no request to a fake API on 127.0.0.1 that was listening while it ran |
| `claude-relocate undo` | 0 | Puts the files and the environment back |
| `claude-relocate status` | 0 | Reads the same places as `verify` and changes nothing |

Nothing runs a model, and there is no plugin and no skill, so nothing is added to Claude's context. The tool is a separate Node process that opens no network connection; a test fails if any file of the package imports a module that could.

## Install

From a terminal, with Node 18 or newer. There is nothing to install and no dependency:

```bash
npx -y github:nrzz/claude-relocate plan
```

Or from a clone:

```bash
git clone https://github.com/nrzz/claude-relocate
cd claude-relocate
node bin/claude-relocate.mjs plan
```

`claude-relocate` in the rest of this document means `npx -y github:nrzz/claude-relocate`, or the command after `npm i -g github:nrzz/claude-relocate` once. There is no Claude Code plugin: it would only add text to Claude's context, and this job needs none.

## Use

Close Claude Code and the Claude desktop app first. Then, in order: `plan` to see what would happen, `move` once without `--yes` to read the steps, `move --yes` to do it, `verify` in a new terminal, and `undo --yes` if you want it back.

```text
claude-relocate plan   [--to <folder> | --xdg] [--json]
claude-relocate move   (--to <folder> | --xdg) [--link] [--no-env] [--ignore-running] [--dry-run] [--yes] [--json]
claude-relocate verify [--json]
claude-relocate undo   [--ignore-running] [--dry-run] [--yes] [--json]
claude-relocate status [--json]
```

| Option | What it does |
| --- | --- |
| `--to <folder>` | The new config folder. It must be new or empty, and outside the old one |
| `--xdg` | `$XDG_CONFIG_HOME/claude` (default `~/.config/claude`) as the config folder. On Linux and macOS the sessions and other state go to `$XDG_STATE_HOME/claude` and the caches to `$XDG_CACHE_HOME/claude`, each behind a symbolic link |
| `--link` | Leave a junction (Windows) or a symbolic link at the old place, and one for `~/.claude.json` if it sat next to the folder. For programs that ignore `CLAUDE_CONFIG_DIR`, and for hooks that spell the old path |
| `--no-env` | Do not write `CLAUDE_CONFIG_DIR` into profiles or the Windows user environment. You set it yourself |
| `--ignore-running` | Do not refuse because a claude process is running. Close it first if you can |
| `--dry-run` | Show what would happen and change nothing (`move`, `undo`) |
| `--yes` | Do it. `move` and `undo` change nothing without it |
| `--json` | One JSON document on stdout, errors too, as `{"ok": false, "error": ...}` |
| `--no-color` | No colour; `NO_COLOR` does the same |
| `-h`, `--help`; `-v`, `--version` | The help; the version |

Exit codes: 0 done or nothing wrong, 1 refused or something to fix, 2 wrong usage. The folder it works on is the one Claude Code uses in that terminal: `CLAUDE_CONFIG_DIR`, else `~/.claude`.

The examples below were run in a throwaway world on Windows 11 with Node 24.19.0: a home folder under the system temp folder with a generated config folder of 147.9 MB (three projects with 14 sessions each, a plugin cache, file history, a status line script that spells `~/.claude`), a `.bashrc` and a PowerShell profile, a scratch registry key in place of `HKCU\Environment`, and the repository's drive (D:) as the second drive. Paths are shortened: `C:\Users\me` stands for that home folder and `D:\Claude` for a folder on D:. The tool was told that no Claude Code process was running, as it finds on a machine where Claude is closed; only the refusal example uses the machine's real process list.

### `plan`

```text
$ claude-relocate plan --to D:\Claude
claude-relocate 1.0.0  what would move
config folder   C:\Users\me\.claude  (the default: CLAUDE_CONFIG_DIR is not set)
.claude.json    C:\Users\me\.claude.json  (next to the config folder, because CLAUDE_CONFIG_DIR is not set)

  KIND                   SIZE    FILES  GOES TO               WHAT
  settings              328 B        9  config                CLAUDE.md, agents/, commands/, keybindings.json, ... (3 more)
  sessions            86.6 MB       42  config                projects/
  plugins              6.9 MB       62  config                plugins/
  plugin cache        40.1 MB       30  config                plugins/cache/
  state and caches    14.2 MB       46  config                debug/, file-history/, history.jsonl, ide/, ... (3 more)
  .claude.json         127 KB        1  config                (next to the config folder)
  total              147.9 MB      190

Destination   D:\Claude  (new)
Method        copy, check the copy, then delete the original: the destination is on another drive
Room          D:\Claude: about 164.0 MB needed, 205.4 GB free
Also written  CLAUDE_CONFIG_DIR=D:\Claude in:
                C:\Users\me\.bashrc (block added, backup first)
                C:\Users\me\Documents\WindowsPowerShell\profile.ps1 (block added, backup first)
                the Windows user environment (HKCU\Environment)

note  settings.json or settings.local.json spell the config folder's path in 1 place (hooks or the status line). They stop working after a move unless you use --link or change them.

Mentions of the config folder's path:
  settings.json:5  "command": "bash \"$HOME/.claude/statusline.sh\""
```

Without `--to` or `--xdg` it prints the first block only and says to pass one. The kinds are: settings (`settings.json`, `settings.local.json`, `keybindings.json`, `CLAUDE.md`, `skills/`, `agents/`, `commands/`, `hooks/`, `rules/`, `output-styles/`, `themes/`, status line scripts, and any folder a hook or the status line points into), sessions (`projects/`), plugins (`plugins/` without its cache), plugin cache (`plugins/cache/`), state and caches (everything else: history, file history, todos, shell snapshots, debug logs, caches) and `.claude.json`. Links inside the folder are counted as links and never followed. `plan` exits 1 when a move to that destination would be refused, and says why:

```text
$ claude-relocate move --to D:\Full --yes
claude-relocate 1.0.0  move
✗ Not moved.
  - The destination D:\Full exists and is not empty (1 item). Choose a new or empty folder.
Nothing was changed.
```

It refuses the same way for a destination inside the config folder, the config folder itself, a folder that holds it, a file, a link, the top of a drive, a folder that cannot be created, no room on the drive (a copy needs the folder's size plus 16 MB and 1 KB a file, free on the new drive), and a claude process that is running:

```text
$ claude-relocate move --to D:\Claude --yes
claude-relocate 1.0.0  move
✗ Not moved.
  - Claude Code or the Claude desktop app is running: 19 processes (claude.exe; pid 1948, 4524, 6836, 8908, 9064, and 14 more). Close it, then run this again. (--ignore-running skips this check.)
Nothing was changed.
```

(That one is from the machine the examples were made on, with the desktop app and Claude Code open.) On Windows `--xdg` says what it does there:

```text
$ claude-relocate plan --xdg
...
Destination   C:\Users\me\.config\claude  (new)
Method        rename: the destination is on the same drive, so nothing is copied
...
note  On Windows --xdg puts everything in one folder, $XDG_CONFIG_HOME/claude (the state and cache folders are for Linux and macOS).
```

### `move`

Without `--yes` it prints the steps and changes nothing (exit 1, on stderr, so a script cannot mistake it for done); `--dry-run` prints the same steps and exits 0:

```text
$ claude-relocate move --to D:\Claude --link --dry-run
claude-relocate 1.0.0  move
With --dry-run, this is what would happen:
  1. Move C:\Users\me\.claude to D:\Claude (copied and checked, then the original is deleted: another drive).
  2. Move C:\Users\me\.claude.json into the new folder, as D:\Claude\.claude.json.
  3. Write D:\Claude\relocate-manifest.json, which `undo` reads.
  4. Add the claude-relocate block to C:\Users\me\.bashrc (after a backup).
  5. Add the claude-relocate block to C:\Users\me\Documents\WindowsPowerShell\profile.ps1 (after a backup).
  6. Set CLAUDE_CONFIG_DIR=D:\Claude in the Windows user environment (HKCU\Environment).
  7. Leave a junction at C:\Users\me\.claude pointing to D:\Claude.
  8. Leave a symbolic link at C:\Users\me\.claude.json pointing to D:\Claude\.claude.json.

note  settings.json or settings.local.json spell the config folder's path in 1 place (hooks or the status line). They stop working after a move unless you use --link or change them.

Nothing was changed (--dry-run).
```

With `--yes`:

```text
$ claude-relocate move --to D:\Claude --link --yes
claude-relocate 1.0.0  move
  copying C:\Users\me\.claude to D:\Claude
  copying agents
  copying CLAUDE.md
  copying commands
  copying debug
  copying file-history
  copying history.jsonl
  copying ide
  copying keybindings.json
  copying plugins
  copying projects
  copying settings.json
  copying shell-snapshots
  copying skills
  copying statsig
  copying statusline.sh
  copying todos
  moving C:\Users\me\.claude.json into D:\Claude
  updated C:\Users\me\.bashrc (backup: C:\Users\me\.bashrc.bak-claude-relocate-20261016-094532)
  updated C:\Users\me\Documents\WindowsPowerShell\profile.ps1 (backup: C:\Users\me\Documents\WindowsPowerShell\profile.ps1.bak-claude-relocate-20261016-094532)
  set CLAUDE_CONFIG_DIR in the Windows user environment (HKCU\Environment)
  removing the original C:\Users\me\.claude
  linked C:\Users\me\.claude to D:\Claude
  linked C:\Users\me\.claude.json to D:\Claude\.claude.json
Moved C:\Users\me\.claude to D:\Claude
  copied and checked, then the original was removed
  147.9 MB in 190 files: same files, same sizes, file times kept (checked)
  manifest: D:\Claude\relocate-manifest.json

Open a new terminal (this one keeps the environment it started with), then run: claude-relocate verify
To put everything back: claude-relocate undo
```

On the same drive it is a rename and says `renamed, not copied: both are on the same drive`. If a rename fails because something holds a file open (or the two places turn out to be different drives, `EXDEV`), it copies instead. If anything fails before the new place is in use, everything is put back and the message says where it is. If something around the move fails afterwards (a profile that cannot be written, the user environment), the data is already in the new place, the exit code is 1 and the notes say what to do by hand.

### `verify`

```text
$ claude-relocate verify
claude-relocate 1.0.0  verify
  info  Moved by claude-relocate on 2026-10-16: C:\Users\me\.claude is now D:\Claude (one folder). Manifest: D:\Claude\relocate-manifest.json.
  ok    D:\Claude exists.
  ok    D:\Claude\.claude.json exists (127 KB).
  ok    42 sessions in 3 projects under D:\Claude\projects; the move carried 42; newest 2026-10-16.
        -work-shop  14 sessions, newest 2026-10-16
        -work-blog  14 sessions, newest 2026-10-15
        -home-notes  14 sessions, newest 2026-10-14
  ok    C:\Users\me\.bashrc sets CLAUDE_CONFIG_DIR=D:\Claude.
  ok    C:\Users\me\Documents\WindowsPowerShell\profile.ps1 sets CLAUDE_CONFIG_DIR=D:\Claude.
  ok    The Windows user environment sets CLAUDE_CONFIG_DIR=D:\Claude.
  ok    C:\Users\me\.claude -> D:\Claude resolves.
  ok    C:\Users\me\.claude.json -> D:\Claude\.claude.json resolves.
  ok    claude --version with CLAUDE_CONFIG_DIR=D:\Claude: 2.1.295 (Claude Code) (C:\Users\me\AppData\Roaming\Claude\claude-code\2.1.295\d2e29494ec83\claude.EXE).
  ok    This terminal already has CLAUDE_CONFIG_DIR set to the destination.

Every check passed.
Open a new terminal so that it starts with CLAUDE_CONFIG_DIR, then start claude there. Terminals that were open before the move keep the old environment.
```

(Run in a terminal where the variable was set, with the real Claude Code binary first on `PATH`.) Each line is a check: `ok`, `info`, `warn` (another line also sets the variable: the later one wins), `skip` (claude is not on `PATH`) or `FAIL` (a profile without its block or with another value, a link that does not resolve, a folder or `.claude.json` that is missing, a `projects/` that cannot be read). It exits 1 if any check failed and changes nothing. The session list reads file names and times only. Run before a move, it checks the folder in use now.

### `undo`

```text
$ claude-relocate undo --yes
claude-relocate 1.0.0  undo
  removed the link C:\Users\me\.claude
  removed the link C:\Users\me\.claude.json
  moving D:\Claude\.claude.json back to C:\Users\me\.claude.json
  copying D:\Claude back to C:\Users\me\.claude
  took the block out of C:\Users\me\.bashrc (backup: C:\Users\me\.bashrc.bak-claude-relocate-20261016-094533)
  took the block out of C:\Users\me\Documents\WindowsPowerShell\profile.ps1 (backup: C:\Users\me\Documents\WindowsPowerShell\profile.ps1.bak-claude-relocate-20261016-094533)
  removed CLAUDE_CONFIG_DIR from the Windows user environment
Undone. D:\Claude is back at C:\Users\me\.claude
  copied and checked, then the copy in the new place was removed

Open a new terminal. If this terminal has CLAUDE_CONFIG_DIR set, it still points at the old place: unset it here too.
```

Whatever was written to the new place since the move (new sessions, changed settings) comes back with it. It finds the manifest in the folder the terminal names, or in the folder a profile block or the Windows user environment names (a terminal opened before the move still names the old place). It refuses, and changes nothing, when Claude is running, when something has been created at the old place since (a folder with files in it, a file, a link elsewhere), when `.claude.json` has been created next to it again, or when there is no room to copy back. `--dry-run` lists the steps. A move that was made on top of an earlier one restores the earlier manifest, so two undos go back two moves.

### `status`

```text
$ claude-relocate status
claude-relocate 1.0.0  status
config folder   C:\Users\me\.claude  (the default: CLAUDE_CONFIG_DIR is not set in this terminal; a link to D:\Claude)
.claude.json    C:\Users\me\.claude.json  (a link; next to the config folder)
moved           C:\Users\me\.claude to D:\Claude on 2026-10-16 (one folder, by copy)
                manifest: C:\Users\me\.claude\relocate-manifest.json

link            C:\Users\me\.claude -> D:\Claude  (resolves)
link            C:\Users\me\.claude.json -> D:\Claude\.claude.json  (resolves)

A terminal started now will have:
  windows     CLAUDE_CONFIG_DIR=D:\Claude  (HKCU\Environment: the user environment, where programs started from the Start menu or Explorer get their variables)
  bash        CLAUDE_CONFIG_DIR=D:\Claude  (C:\Users\me\.bashrc)
  powershell  CLAUDE_CONFIG_DIR=D:\Claude  (C:\Users\me\Documents\WindowsPowerShell\profile.ps1)
This terminal: CLAUDE_CONFIG_DIR is not set.
```

It always exits 0. It reads the same places as `verify` and changes nothing.

### The JSON documents

`--json` prints one object on stdout whose first fields are `schema` (1), `tool`, `version` and `command`, then `ok`. Errors, including usage errors, are `{"ok": false, "error": "..."}`. The three read-only commands are meant to be called by other programs:

- `plan`: `platform`, `home`, `origin` (`configDir`, `source`, `exists`, `isLink`, `claudeJson`, `claudeJsonInside`, `claudeJsonExists`, `relocated`), `kinds` (each with `kind`, `label`, `bytes`, `files`, `links`, `entries`, `destination`), `entries` (every top-level item with its `kind`, `type`, `bytes`, `files`), `total`, `destination` (`requested`, `mode`: `single` or `xdg-split`, `config`, `state`, `cache`, `parts`, `method`, `groups`, `existedBefore`), `space` (`path`, `needBytes`, `freeBytes`, `ok`), `env` (`profiles`, `notWritten`, `registry`, `variable`, `skipped`), `processes`, `references`, `warnings`, `problems` (each with a `code` and a `message`) and `links`. `ok` is false when there is a problem.
- `status`: `thisTerminal`, `configDir`, `claudeJson`, `moved` (`from`, `to`, `mode`, `method`, `date`, `manifest`, or null), `links`, `profiles`, `windowsEnvironment`, `shell` and `newTerminals`.
- `verify`: `checks` (each with `id`, `level` and `message`), `sessions` (`path`, `sessions`, and `projects` with `name`, `sessions`, `newest`), `manifest`, `destination` and `found`.

`move` and `undo` print `steps` (what would be done, or was), `method`, `warnings` and `incomplete`; a refusal adds `refused`, `problems` and `error`, a missing `--yes` adds `needsYes`, and `--dry-run` adds `dryRun`. `move` also prints `plan`, `files`, `bytes` and `manifest`.

## How it works

It reads, on your machine only: the folder named by `CLAUDE_CONFIG_DIR` (a relative path is taken from the working folder) or `~/.claude`, and `.claude.json` inside it when the variable is set or next to it (`~/.claude.json`) when it is not; the names, sizes and file times of everything in the folder; the text of `settings.json` and `settings.local.json` in it, to find the scripts of hooks and of the status line that live in the folder and the lines that spell its path; the shell profiles it knows (to see whether its block is there); on Windows the `CLAUDE_CONFIG_DIR` value of the user environment (`reg query`); the process list (`tasklist` on Windows, `ps` elsewhere); and the free space of the drives involved.

**The move.** `move` builds the plan again and refuses on any problem before it changes anything. Then, in this order:

1. The data. On one drive the folder is renamed. On another it is copied with every file time (and mode, on Linux and macOS) kept; links are copied as links; the copy is compared with the original (same names, kinds, sizes, file times to within two seconds, link targets); only then does anything else happen. The original stays until step 5. A marker file, `.claude-relocate-incomplete`, is in the new folder while it is being filled, so an interrupted copy is recognised and `plan` says it can be deleted.
2. `.claude.json` from next to the folder goes into the new folder when the variable was not set. Claude Code reads `<CLAUDE_CONFIG_DIR>/.claude.json` when the variable is set, even when it names `~/.claude`, and `~/.claude.json` when it is not (checked, see below). A `.claude.json` that was already inside the old folder is kept beside it as `.claude.json.before-relocate`.
3. `relocate-manifest.json` is written in the new folder.
4. `CLAUDE_CONFIG_DIR` goes into the profiles and the Windows user environment.
5. After a copy, the original is renamed aside and deleted; with `--link` a junction or symbolic link takes its place. If it is interrupted while deleting, a folder `.claude.claude-relocate-old` next to the old place can be deleted by hand.
6. The manifest is written again with what was done.

A failure in steps 1 to 3 puts everything back as it was, including the folders the move made on the way, and says so. File times matter: Claude Code's cleanup of old sessions goes by the modification time of the session file (see [claude-session-tidy](https://github.com/nrzz/claude-session-tidy)), so a copy that stamped every file with today's date would make a month of sessions look new. The comparison checks names, sizes, times and link targets; it does not hash file contents.

**Links inside the folder.** An absolute link into the folder is re-aimed at the same place in the new one; a relative link that stays inside is left alone; a relative link that leaves the folder (to a dotfiles repository, say) becomes absolute so that it still points at the same thing; any other absolute link stays. What a link points to is never copied, counted or removed.

**The manifest** is `relocate-manifest.json` in the new folder. It records where the folder came from and went to, the method, the counts, the sessions carried, each profile block (what was there before, the line ending, the backup), the Windows user environment value that was there before and its type, the links, and for `--xdg` the parts that went behind links. `undo` needs nothing else. Anyone who can write to your home folder can plant one, so `undo` refuses one that does not name this tool and this schema, and `undo --dry-run` shows the steps first.

**Profiles.** The block is three lines between `# claude-relocate start` and `# claude-relocate end`: `export CLAUDE_CONFIG_DIR='...'` for bash and zsh, `set -gx CLAUDE_CONFIG_DIR '...'` for fish, `$env:CLAUDE_CONFIG_DIR = '...'` for PowerShell, with the path quoted so that spaces, quotes and `$` come back exactly (the quoting is tested by sourcing the block in the real shell where one is installed). It goes into every profile that exists: `~/.bashrc`, `~/.bash_profile`, `~/.profile`, `~/.zshrc`, `~/.zshenv`, `$XDG_CONFIG_HOME/fish/config.fish` and, on Windows, `Documents\PowerShell\profile.ps1` and `Documents\WindowsPowerShell\profile.ps1`. When none exists for the shell in use (`$SHELL`), the main one is created (not on Windows). The file is backed up next to itself first (`.bashrc.bak-claude-relocate-<time>`); line endings and a byte-order mark are kept; a profile that is a symbolic link is written through; a profile that is not UTF-8 text (UTF-16, an ANSI code page) is left alone, and `plan` says so. `undo` cuts the block out, restores a block it had replaced, keeps lines you added since, and deletes a file the move created if nothing else is in it. Shells it does not know (nushell, xonsh, csh) get nothing: `plan` names the value to set.

**The Windows user environment.** `HKCU\Environment\CLAUDE_CONFIG_DIR` is written as a plain string (`REG_SZ`) with `reg.exe`, so programs started afterwards from the Start menu or Explorer get it. A value that was there before is kept with its type and put back by `undo`. Programs that are already running keep their old environment.

**`--xdg`.** The config folder is `$XDG_CONFIG_HOME/claude`, the state folder `$XDG_STATE_HOME/claude` and the cache folder `$XDG_CACHE_HOME/claude` (the defaults are `~/.config`, `~/.local/state` and `~/.cache`; a variable that is not an absolute path is ignored, as the specification says). On Linux and macOS these parts of the config folder go to the state folder: `projects`, `file-history`, `session-env`, `uploads`, `tasks`, `todos`, `shell-snapshots`, `backups`, `debug`; and these to the cache folder: `plugins/cache`, `statsig`, `usage-data`. Each is replaced in the config folder by a symbolic link. Settings, skills, `CLAUDE.md`, history, the plugin lists and `.claude.json` stay in the config folder. On Windows there is no split: the links would be junctions, and the split was only tried there to see what the binary does with them (below).

**What it leaves alone.**

- The desktop app's own folder, `%APPDATA%\Claude` on Windows (#57998). On the machine used for this README it holds one folder per Claude Code build the app has downloaded, under `claude-code\<version>`; the config folder is a different one.
- The VS Code extension's own settings.
- The macOS keychain entry that holds your login. It is neither read nor moved; if Claude Code asks you to log in after a move on macOS, that may be why (not verified here).
- Project folders: a `.claude/` folder or a `CLAUDE.md` inside a repository stays in the repository.
- Hooks, scripts and settings of yours that spell the old path. `plan` finds the lines in `settings.json` and `settings.local.json` and warns; `--link` keeps them working, or change them.
- Links from an earlier move that lead to the folder. Moving a moved folder again warns that they will lead nowhere; run `undo` first.

**Which parts of Claude Code honour `CLAUDE_CONFIG_DIR`.** The command line Claude Code does, on Windows with 2.1.295 and 2.1.299 (checked, see below), and CI repeats the checks on Linux and macOS with the newest release. A program that ignores the variable, or a hook that spells the old path, needs `--link`. The desktop app's bundled Claude Code and the VS Code extension were not tried: #30538 reports that the extension ignores the variable.

### Privacy

Nothing leaves your machine: no network request, no telemetry, no account. It reads names, sizes and file times, and the text of `settings.json` and `settings.local.json`; it does not parse a session, `.credentials.json` or `.claude.json`. A copy to another drive carries their bytes like every other file, with their permissions on Linux and macOS; on Windows the new files take the permissions the new folder hands down, which were not compared with the old ones. It writes only the new folder and its manifest, profile blocks (after a backup), the Windows user environment value, and links, and only with `--yes`. It starts `tasklist` or `ps`, `reg` on Windows, `df` or PowerShell for free space on a Node older than 18.15, and `claude --version` in `verify`.

## What was verified, and how

Checked on 2026-10-16 on Windows 11 (10.0.26300) with Node 24.19.0 and Claude Code 2.1.295 and 2.1.299 (the builds bundled with the desktop app). CI runs the unit tests on Linux, macOS and Windows with Node 20, 22 and 24 and on Linux with Node 18, and the real-binary checks on Linux and macOS against the newest npm release of Claude Code; the badge at the top shows the latest run.

- **312 automated tests** (`npm test`, Node's own runner, no dependencies, about 46 seconds, most of it the PowerShell profile check; on Node 20 and newer `node --test` also reports each of the 3 helper files under `test/` as a passing test, so the runner's 315 is 312 without them). With `E2E_CLAUDE` unset, 297 pass and 15 are skipped: the 8 real-binary checks, and 7 that this machine cannot run (zsh, fish and PowerShell 7 are not installed; permission bits, named pipes and a read-only parent folder are POSIX only). With `E2E_CLAUDE` pointing at Claude Code 2.1.295, 305 pass, and with 2.1.299, 305; none fail. They cover the folder inventory and its kinds, the plan and every refusal, a rename, the copy that `EXDEV` forces and a copy to a really different drive, `--link`, the `--xdg` split behind links, profiles for bash, zsh, fish and PowerShell (quoting, line endings, a missing final line break, a byte-order mark, a file that is not UTF-8), the Windows user environment (through a scratch registry key), a claude process that is running, no room, a destination that is not empty or inside the folder, paths with spaces, links inside the folder, a copy that stops half way, `undo` back to the exact tree (compared file by file with content and file time, also after two moves), `verify` and `status` before and after, the text and JSON of every command, the command line and its exit codes, and the package files. Nothing reads or writes outside temporary folders: `test/helpers.mjs` points `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR`, the XDG variables and the registry key at throwaway places before any test runs.
- **Which `.claude.json` Claude Code reads, put to the binary.** A `.claude.json` with one `userID` was placed inside the config folder and another next to it, and a `claude -p` run against a fake Messages API on 127.0.0.1 sent its `device_id`. With `CLAUDE_CONFIG_DIR` set, even to `~/.claude` itself, the file inside the folder was the one read. With it unset, the file next to the folder (`~/.claude.json`) was. That is why a move that sets the variable carries `.claude.json` into the folder. With `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` set and `CLAUDE_CONFIG_DIR` unset, the binary wrote everything to `~/.claude` and ignored a `settings.json` in `$XDG_CONFIG_HOME/claude` (2.1.295, Windows; the test prints what the binary does on Linux and macOS in CI).
- **A moved folder works.** `test/e2e-claude.test.mjs` makes the binary write a session, has the tool move the config folder (a profile and the scratch user environment included), and then runs the binary with `CLAUDE_CONFIG_DIR` at the new place. `claude --version` runs. `claude -p` writes its transcript under the new `projects/`. `--resume` of the session written before the move sends the whole history to the model. A `SessionStart` hook and an `env` value from the moved `settings.json` fire and apply. The `device_id` of every request is the `userID` of the moved `.claude.json`. Nothing is created at the old place or in the home folder. `verify`, with the binary first on `PATH`, finds the session list, the version, the profile and the user environment. `undo` brings the old place back, and the binary resumes a session that was written at the new place. This passed with Claude Code 2.1.295 and 2.1.299.
- **`--link`.** In a default `~/.claude` world, after `move --link`, the binary with no variable set resumes the session, reads `.claude.json` and runs a hook whose command spells the old path, all through the junction and the file link, and new transcripts land in the new folder. After a move without `--link`, that hook does not run (the session itself works), which is what `plan` warns about.
- **Plugins.** The binary cloned a marketplace (a local git repository, reached through git's `insteadOf`, so nothing used the network) and installed a plugin from it. After the move, `claude plugin list` shows it enabled and its `SessionStart` hook fires with `CLAUDE_PLUGIN_ROOT` below the new folder, though `installed_plugins.json` and `known_marketplaces.json` still hold the old absolute paths. The tool leaves both files as the binary wrote them.
- **The `--xdg` split, with the binary.** A session written and resumed through a linked `projects/`, a new transcript written into the state folder, a plugin hook fired from behind a linked `plugins/cache`, and `undo`. On Windows this was run with junctions, because `--xdg` does not split there; CI runs it with symbolic links on Linux and macOS.
- **Claude running.** On this machine, with the desktop app and Claude Code open (19 and 20 `claude.exe` processes were listed on two runs), `move --yes` was refused and changed nothing. The unit tests use a fake process list; a separate test starts a program called `claude` and checks that the real `tasklist` or `ps` lists it.
- **A really different drive.** A generated 147.9 MB config folder with 190 files moved from C: to D:, copied, checked and removed behind a junction, then undone, as the examples above show. The suite does the same with a small folder when the machine has a second drive (D: here), and with a forced `EXDEV` everywhere.
- **`claude --version` sends no request.** A fake API on 127.0.0.1 listening while it ran received none, and it created nothing in the config folder.
- **The shells.** The block was sourced by the real bash and by Windows PowerShell 5.1 for 18 awkward folder names (19 for PowerShell, which also treats curly quotes as quotes): spaces, quotes, `$`, backticks, `%`, `^`, non-ASCII letters, backslashes, a leading and a trailing space, a tab. zsh, fish and PowerShell 7 run the same check where they are installed (CI).

## Not verified

- **The Claude desktop app's bundled Claude Code, the VS Code extension and the JetBrains integration** were not tried with a moved folder. Whether they read `CLAUDE_CONFIG_DIR` from the Windows user environment is unknown; #30538 reports that the VS Code extension ignores it. `--link` is the way for anything that ignores the variable.
- **macOS.** Nothing was run on a Mac by hand. CI runs the suite and the real-binary checks there. The login Claude Code keeps in the macOS keychain is neither read nor moved, and whether it follows the config folder is not known here.
- **Linux and macOS beyond what CI ran.** The author's machine is Windows. The symbolic-link split of `--xdg`, file modes and the real zsh and fish checks are exercised only in CI; what Claude Code does with the XDG variables on Linux and macOS is printed by a test there and not asserted.
- **Claude Code versions other than 2.1.295 and 2.1.299.** CI installs the newest npm release every week and on every push, so a release that changes where Claude Code keeps things shows up there as a red job.
- **A PowerShell profile in a redirected Documents folder** (OneDrive) is not found; the Windows user environment covers every shell. **A profile in UTF-16** is left alone, not edited.
- **Network shares and UNC paths**, **FAT and exFAT drives** (file times are compared to within two seconds for them), **removable drives that disappear half way**, and **a config folder with a million files** (the time it takes) were not tried.
- **Permissions of copied files on Windows.** A copy to another drive gives the files the permissions the new folder passes down; they were not compared with the old ones, so check who can read `.credentials.json` on a shared drive.
- **Windows without Developer Mode.** A symbolic link to a file (`~/.claude.json` with `--link`) needs Developer Mode or an administrator; the move then reports it as a note after the data is already in place. The junction for the folder needs neither.
- **Programs that were already running** keep the environment they started with; the tool cannot change that.

## Files

| Path | What it is |
| --- | --- |
| `bin/claude-relocate.mjs` | The command |
| `src/cli.mjs` | The options, the help, the exit codes and `--json` |
| `src/env.mjs`, `src/inventory.mjs`, `src/plan.mjs`, `src/xdg.mjs` | Which folder is the config folder; what is in it and of which kind; the plan and every reason to refuse; the parts `--xdg` splits off |
| `src/move.mjs`, `src/transfer.mjs`, `src/walk.mjs` | The move and its rollback; one rename or copy-check-delete; snapshots, copies that keep file times, links, removal that never follows a link |
| `src/undo.mjs`, `src/manifest.mjs` | Undo; the manifest a move leaves |
| `src/profiles.mjs`, `src/winenv.mjs` | The block in shell profiles; the Windows user environment |
| `src/verify.mjs`, `src/status.mjs`, `src/render.mjs` | The two read-only commands; the text the commands print |
| `src/sys.mjs`, `src/procs.mjs`, `src/space.mjs`, `src/util.mjs`, `src/version.mjs` | The parts of the machine the commands touch, which tests replace; running claude processes; free space and drives; small helpers; the version |
| `test/` | `npm test`; `e2e-claude.test.mjs` runs against the real binary when `E2E_CLAUDE` is set, with `claude-sandbox.mjs` and `record-hook.mjs` |
| `.github/workflows/` | `test.yml` (the suite on three systems) and `e2e.yml` (the real binary on two) |
| `CHANGELOG.md`, `ROADMAP.md`, `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md` | The usual |

Related: [claude-session-tidy](https://github.com/nrzz/claude-session-tidy) lists and deletes the sessions in the folder this tool moves, and [claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor) reads its settings files.

## Contributing

Issues and pull requests are welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [good first issues](https://github.com/nrzz/claude-relocate/issues?q=is%3Aopen+label%3A%22good+first+issue%22). A report from macOS or Linux about the desktop app, the VS Code extension or the keychain would settle what is listed above as not verified. Questions go to [Discussions](https://github.com/nrzz/claude-relocate/discussions); security reports go through [SECURITY.md](SECURITY.md).

## Part of the Claude Code toolkit

Small, dependency-free tools that make Claude Code cheaper, safer and easier to share, all in the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit):

- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself
- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers
- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD
- [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails): safety presets that stop risky commands and edits
- [claude-code-notify](https://github.com/nrzz/claude-code-notify): a ping when Claude needs you or finishes
- [claude-cost-guard](https://github.com/nrzz/claude-cost-guard): daily and weekly token budgets with zero-token warnings
- [claude-md-doctor](https://github.com/nrzz/claude-md-doctor): what your CLAUDE.md costs every session, and how to slim it
- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command
- [claude-session-replay](https://github.com/nrzz/claude-session-replay): search past sessions and export one as an HTML replay
- [claude-chat-ferry](https://github.com/nrzz/claude-chat-ferry): continue a Cursor or Antigravity chat in Claude Code, or hand a session to them
- [claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor): why a permission prompt appeared, dead rules, rules from your history
- [claude-session-tidy](https://github.com/nrzz/claude-session-tidy): list, delete, keep and restore your sessions before the 30-day sweep
- [claude-hook-bench](https://github.com/nrzz/claude-hook-bench): run every hook with the JSON Claude Code sends, and see what each one does
- [claude-settings-doctor](https://github.com/nrzz/claude-settings-doctor): a commented settings.jsonc that builds settings.json, the merged settings with their source, a lint against the schema

Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on.

If one of them saves you tokens, a star on its repository helps other people find it, and following [@nrzz](https://github.com/nrzz) on GitHub shows you new tools and releases.

## License

MIT
