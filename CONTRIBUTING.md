# Contributing to claude-relocate

Thanks for helping. claude-relocate is a command line tool, part of the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit). The bar for a change is the bar the code already meets: it works on Windows, macOS and Linux, it is tested, it never wastes anyone's tokens, and it never loses a file.

## Start here

- **Good first issues:** [the issues labelled good first issue](https://github.com/nrzz/claude-relocate/issues?q=is%3Aopen+label%3A%22good+first+issue%22), and the ideas in [ROADMAP.md](ROADMAP.md).
- **Questions and ideas:** [Discussions](https://github.com/nrzz/claude-relocate/discussions).
- **Bugs:** [open an issue](https://github.com/nrzz/claude-relocate/issues/new/choose) with the Claude Code version (`claude --version`), your OS, `node --version`, the exact command and its output, and the output of `claude-relocate verify` and `claude-relocate status`. If a move stopped, say what is where now.

## Set up

There is nothing to install: the project has no dependencies.

```bash
git clone https://github.com/nrzz/claude-relocate
cd claude-relocate
npm test
```

- To try the tool by hand, give it a throwaway world: set `HOME`, `USERPROFILE` and `CLAUDE_CONFIG_DIR` to a temporary folder in the same command, and leave the environment alone with `--no-env`. Never point it at your real `~/.claude` while you are changing it.
- `E2E_CLAUDE=claude node --test test/e2e-claude.test.mjs` also puts the moved folders to the real Claude Code binary (see below).

## Where things are

| Path | What it holds |
| --- | --- |
| `bin/claude-relocate.mjs` | the command |
| `src/cli.mjs` | the options, the help, the exit codes, `--json` |
| `src/env.mjs` | which folder is the config folder, where `.claude.json` is, the XDG folders, the shell in use |
| `src/inventory.mjs`, `src/plan.mjs`, `src/xdg.mjs` | what is in the folder and of which kind; the plan and every reason to refuse; which parts `--xdg` splits off |
| `src/move.mjs`, `src/transfer.mjs`, `src/walk.mjs` | the move and its rollback; one rename or copy-check-delete; snapshots, copies that keep file times, links |
| `src/undo.mjs`, `src/manifest.mjs` | undo; the manifest the move leaves |
| `src/profiles.mjs`, `src/winenv.mjs` | the block in shell profiles; the Windows user environment |
| `src/verify.mjs`, `src/status.mjs`, `src/render.mjs` | the two read-only commands; the text the commands print |
| `src/sys.mjs`, `src/procs.mjs`, `src/space.mjs` | the parts of the machine the commands touch, replaceable in tests; running claude processes; free space and drives |
| `test/*.test.mjs` | unit and command tests; `e2e-claude.test.mjs` runs against the real binary when `E2E_CLAUDE` is set |

## House rules

1. **No dependencies.** Node built-ins only, Node 18 or newer, ES modules (`.mjs`). A pull request that adds a package to `dependencies` will not be merged. Only `src/procs.mjs`, `src/space.mjs`, `src/sys.mjs` and `src/winenv.mjs` may start a process, and nothing may open a network connection; a test fails otherwise.
2. **Every change comes with a test**, and `npm test` passes. CI runs the suite on Windows, macOS and Linux with Node 20, 22 and 24, and on Linux with Node 18, and the real-binary checks on Linux and macOS; a change that only works on one of them is not done. Paths with spaces, junctions and `EXDEV` are part of the job.
3. **Never touch real user data in tests.** `test/helpers.mjs` points `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR`, `APPDATA`, the XDG variables and the registry key of the test process at throwaway places the moment it loads; build a world with `world()` and run the tool in it. A test never reads or writes the real `~/.claude`, a real shell profile or `HKCU\Environment`.
4. **A move can be undone.** A change to what `move` writes needs the same change in `undo` and a test that compares the tree before the move with the tree after the undo. Anything that changes what the manifest means changes its `schema`.
5. **The binary is right.** A claim about how Claude Code behaves belongs in `test/e2e-claude.test.mjs`, run against the real binary, and in the README's "What was verified". Do not change a check to make a test pass without running it against the binary.
6. **Token cost is a feature.** The tool runs outside Claude and costs no tokens. If your change puts anything in front of Claude, say how many tokens in the pull request and update the README's "What it costs in tokens".
7. **Keep the README honest.** Its "What was verified, and how" section says what was checked and what was not. If your change affects either, update it in the same pull request.

## The real-binary checks

`test/e2e-claude.test.mjs` starts a fake Messages API on 127.0.0.1 and runs the real Claude Code binary against it, in a throwaway home folder: a session is written, the tool moves the config folder, and the binary has to behave as before from the new place (resume the session with its history, honour `settings.json`, read `.claude.json`, load a plugin installed earlier, work through the links). No model is reached and nothing leaves your machine.

```bash
E2E_CLAUDE=/path/to/claude node --test test/e2e-claude.test.mjs
```

## Pull requests

- One logical change per pull request, with its test. Commit messages in the imperative mood ("Leave a profile in UTF-16 alone").
- Fill in the pull request template; CI must be green on every job.
- Signed commits are welcome but not required.
- Plain, specific writing in docs, messages and comments.

## Releases (maintainers)

Bump the version in `src/version.mjs` and `package.json` (`npm test` fails until both agree), add a section to [CHANGELOG.md](CHANGELOG.md), tag `vX.Y.Z` and publish a GitHub release with the changelog section as its notes.

## Conduct and security

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.
