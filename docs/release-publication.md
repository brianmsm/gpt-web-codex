# Publishing a privacy-curated release

This is an **operator checklist**, not a permission for ChatGPT to publish anything. The shell-first MCP bridge can execute powerful OS commands; Git credential/ref changes are reserved for a trusted maintainer.

## Why a release needs an explicit Git ref review

GPT Web Codex v2.3.0 has a reconstructed public development history. Private deployment journals and recovery scripts remain reachable from **local development branches**. A pre-existing local tag named `v2.3.0` was created before reconstruction and may still point to that private history.

**Do not use `git push --tags`, `git push --mirror`, `git push --all`, or `git push --follow-tags` from a checkout holding private refs.** A draft GitHub Release does *not* keep uploaded Git objects private. Never push an unreviewed local tag merely because its name matches the package version.

## Pre-publication approval gate

Perform these checks without modifying the real tunnel, your protected GWC installation or research worktrees:

1. Obtain independent privacy, code and release-workflow review of the **exact candidate commit SHA**. Any change to the candidate requires new review; an earlier R1/R2 result does not automatically apply to the changed HEAD.
2. Confirm a clean isolated worktree, a stable public `main` baseline, frozen package/version metadata, and a dependency/functional test run.
3. Check the exact public ancestor closure and all *newly reachable* Git blobs/commit messages against your private-path and credential policy. Inherited public history remains a separate concern: changing HEAD does not erase prior public Git commits.
4. Confirm `git rev-parse 'refs/tags/v2.3.0^{}'` returns the **approved sanitized HEAD**, not the older private-history development commit. If it doesn't, **stop**. The maintainer must explicitly authorize replacing/recreating the local annotated tag only after reviewing the target and all local refs. No bulk ref push.
5. Verify the remote refs through read-only commands such as `git ls-remote origin refs/heads/main refs/tags/v2.3.0` before any write. Do not publish a tag until its exact object graph is checked.
6. Review the platform matrix on GitHub Actions (Windows, Linux and macOS) and the generated binary assets. Inspect checksums, licenses/notices and signatures. Local Linux-only `bun run verify` is not proof of all platforms.

## Draft-first release publication

The workflow `.github/workflows/release.yml` now runs `scripts/stage-release-draft.sh` for publishing. It deliberately **refuses any existing GitHub Release at the same tag**, even a draft. This avoids silently retaining old assets not included in a regenerated checksum manifest.

For a fresh release, the script checks the exact local checksum inventory, creates a new `--draft` release, and verifies the **complete remote asset-name inventory**. It does not mark the release public. Any partial draft or verification failure requires explicit maintainer review before a retry. Do not silently delete or overwrite a draft; first inspect its contents and decide whether to retire it.

The GitHub token is read-only for build jobs; only the publish job may write release contents. The final visible release must be promoted *manually*, only after binaries, checksums and metadata are reviewed.

## Development history provenance

The public commit sequence is an intentionally **privacy-curated reconstruction**, not a lossless export of every internal commit. Original author names/dates are retained for selected implementation milestones; rewritten committer dates and commit hashes necessarily differ. Installation-specific private diagnostics and mappings are withheld, and should not be attached to a public GitHub Release.

## Not part of this procedure

This document does **not** authorize a tag move, branch merge, push, GitHub Release creation, systemd restart, browser-profile migration, or deletion of local/private state. Each requires a separately approved operator action.