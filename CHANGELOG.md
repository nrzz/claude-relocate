# Changelog

All notable changes to claude-relocate are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-10-28

- `plan` and `status`: report the free space of the drive the config folder is on, under `.claude.json`; `--json` carries `origin.freeBytes` in `plan` and `configDir.freeBytes` in `status`.
- Contributed by [@yoreva-01](https://github.com/yoreva-01) in [#2](https://github.com/nrzz/claude-relocate/pull/2), for the good first issue [#1](https://github.com/nrzz/claude-relocate/issues/1).
- The README's test count is the runner's again: 372 automated tests (375 with the 3 helper files), 356 passing without `E2E_CLAUDE` and 364 with it (the two new tests do not use the binary). It had said 370 before the pull request's two tests.

## [1.0.0] - 2026-10-16

- First release. `plan` shows what is in Claude Code's config folder and how big each kind is (settings, sessions, plugins, plugin cache, state and caches, `.claude.json`), where it would go, the room on the destination drive and every reason a move would be refused. `move --to <folder>` renames the folder on the same drive, or copies it to another drive, checks the copy against the original and only then removes the original; file times and links are kept. `move --xdg` uses `$XDG_CONFIG_HOME/claude`, and on Linux and macOS puts the sessions and other state in `$XDG_STATE_HOME/claude` and the caches in `$XDG_CACHE_HOME/claude`, each behind a symbolic link. `CLAUDE_CONFIG_DIR` is written into the bash, zsh, fish and PowerShell profiles that exist (after a backup) and into the Windows user environment; `--link` leaves a junction or symbolic link at the old place; a running claude process, a destination that is not empty or inside the folder, and no room are refused before anything changes. `verify` checks the profiles, the user environment, the folder, `.claude.json`, the links, the list of sessions and `claude --version`. `undo` reads `relocate-manifest.json` and puts everything back; `status` shows where things are. `--json` on every command, `--dry-run` on `move` and `undo`, nothing changes without `--yes`, exit codes 0, 1 and 2.
- Failure handling: the original is removed only after the copy has been checked and the original looked at once more (a folder that changes while it is copied stops the move with nothing changed; one that changes just after the copy was checked is kept); what a copy cannot remove from the old place (a file another program holds open) is named, and the rest is removed; a failure after the data moved is a note that says what to do by hand. Relative links that leave the folder (as GNU stow makes them) are written as absolute links, and come back as the same text on `undo`.
- Zero dependencies: Node 18 or newer and `node:` built-ins only. The tool runs no model and opens no network connection, so it costs no tokens.
- Checked against Claude Code 2.1.295 and 2.1.299 on Windows and 2.1.301 on Linux and macOS (CI): a moved folder works from its new place (a session written before the move resumes with its history, `settings.json` and `.claude.json` are read there, a plugin installed before the move loads, the links work), and which `.claude.json` the binary reads. `test/e2e-claude.test.mjs` repeats the checks; CI runs them on Linux and macOS with the newest npm release. See the README's "What was verified, and how".

[1.1.0]: https://github.com/nrzz/claude-relocate/releases/tag/v1.1.0
[1.0.0]: https://github.com/nrzz/claude-relocate/releases/tag/v1.0.0
