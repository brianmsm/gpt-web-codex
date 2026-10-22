# Archived release governance — 2026-10-23

This branch preserves the **pre-simplification** GPT Web Codex v2.3.0 source publication system. Do **not** merge it into `main` just to recover a release tag or change remote tags.

## Frozen source

- Starting `main` merge commit: `f02d05bfb1f639ab5634a786bd6835b8b1791a19`
- Tree: `29bd608ca0738b50ecbc3d596be7c398b9f98ba0`
- Exact original files remain in the parent commit; this archived-branch document is the only additional change.
- Original publication implementation: `.github/workflows/release.yml`, `scripts/stage-release-draft.sh`, `scripts/stage_release_draft.py`, `scripts/release_build_identity.py`
- Original tests: `tests/test_stage_release_draft.py`, `tests/test_release_build_identity.py`, `launcher/tests/release-draft-safety.test.cjs`
- Original procedures: `docs/release-publication.md`

## External GitHub configuration snapshot

As observed on 2026-10-23 for `brianmsm/gpt-web-codex`:

- Environment: `release-staging`.
- Required reviewer: GitHub user `brianmsm` (user ID `28207224`).
- `prevent_self_review=false`: manual self-review was allowed, **not** an independent review.
- Wait timer: 0.
- Custom deployment branch/tag policy was enabled, with **one** allowed entry: `{type:"tag", name:"v2.3.0"}`.
- Environment variables: empty; `RELEASE_APPROVED_COMMIT_SHA` was **not** set.
- GitHub repository tag rulesets: none. The tag `v2.3.0` did not exist on the remote.
- Repository Actions default `GITHUB_TOKEN` permissions: read; workflow's `publish` job requests `contents: write`.
- A deployment to this environment has **not** verified the runner's effective permissions or draft visibility.

GitHub environment settings and repo rulesets are **not stored in Git**. Restoring this archival branch's source alone does not restore those external settings. The original system also required separate manual approval, a source SHA whitelist, checks of remote tag identity and real-runner validation.

## Restoration guide

To resurrect the high-assurance system someday, start from this branch and review the differences to the then-current default branch. Restore the required workflow/scripts/tests and configure a guarded GitHub Environment manually. Review your tag provenance, artifacts and GitHub permission semantics anew. Never push local historical tags with `--tags`, `--all`, `--mirror` or `--follow-tags`: a preexisting local `v2.3.0` tag was documented as reaching historical private content.

This archive is a code/configuration reference, not a release approval or an authorization to publish.