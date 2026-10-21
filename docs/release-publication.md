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
## R6 staging contract (pending independent audit; no authorization to publish)

The Bash entrypoint remains `scripts/stage-release-draft.sh`, but all authenticated
HTTP traffic is performed directly by the Python 3 standard-library REST client.
It performs no `gh release create`, tag writes, release updates/deletes, publishing,
retries, or remotely directed diagnostics. The only mutations are **one** release
creation POST and, once its immutable numeric ID is captured, one upload POST for
each verified local file. It never follows HTTP redirects and accepts an upload
URL only at the canonical `uploads.github.com` release-ID/repository path. The
client uses the system's certificate-verifying TLS context and bounded streaming.

**Mandatory independent approval:** before any tag-triggered workflow is run,
maintainers must (1) independently approve the exact sanitized release commit SHA
and its reachable history, (2) configure the `release-staging` GitHub Environment
with required reviewers and a protected environment variable named
`RELEASE_APPROVED_COMMIT_SHA` containing that full 40-hex SHA, (3) verify its
value independently of the tag push/GITHUB_SHA event, (4) confirm the GitHub
remote tag already exists and resolves to this approved commit, (5) resolve
R4T-03 runner token `permissions.push` and draft visibility in a separately
approved **read-only** diagnostic, and (6) resolve R4T-04 by integrating the
reviewed workflow on the default branch **before** the tag push. Missing approval
or unreadable permissions is a hard denial. The staging REST call includes
`target_commitish=RELEASE_APPROVED_COMMIT_SHA`, but GitHub ignores this field for
existing tags, so the client explicitly resolves the tag through Git refs and
annotated tag objects before creation, just before POST, and after upload.
These reads cannot eliminate external tag-move races between requests.

**State and partial effects:** a private local journal at
`$RELEASE_STAGE_JOURNAL` (created mode 0600 with exclusive creation, flushed
before POST) records state transitions, known release ID, uploaded asset IDs, and
manual-review outcomes; it never includes a token. An existing journal blocks
replay. `CREATE_ATTEMPTED` means a POST may have reached GitHub even if its
response was lost. Any subsequent failure becomes `MANUAL_REVIEW_REQUIRED`:
no automatic retry, deletion, upload continuation or reuse of a draft. GitHub
Actions concurrency serializes only runs with the same group and is not a
universal lock. A new Actions run has a different journal; remote list checks
still cannot promise exactly-once under external concurrency. Release IDs and
asset IDs are checked as positive integers, matched across POST and GET by-ID.

**Budget:** default 32 explicitly requested consecutive pages at `per_page=100`,
8 MiB per JSON response, 32 MiB cumulative JSON response bodies, 15 s per JSON REST operation, 1800 s per streamed asset upload, 180 s
preflight, and 3600 s overall. Each is enforced during
its request; budget exhaustion blocks rather than proceeding with an incomplete
inventory. Limits can be lowered/increased within audited caps using
`RELEASE_MAX_PAGES` (1–256), `RELEASE_MAX_RESPONSE_BYTES` (1 KiB–32 MiB),
`RELEASE_MAX_TOTAL_BYTES` (1 KiB–256 MiB), `RELEASE_REQUEST_TIMEOUT` (1–120 s),
`RELEASE_PREFLIGHT_SECONDS` (1–1200 s), and `RELEASE_OVERALL_SECONDS`
(1–21600 s), and `RELEASE_UPLOAD_TIMEOUT` (1–21600 s). A short page requires an explicitly empty next page. The sequence
is **not** an atomic GitHub snapshot; detectability of concurrent shifts is
limited, and uncertain states require human review.

**Integrity:** the client independently hashes `checksums.txt` and every
checksummed top-level regular file. HTTP uploads stream in 1 MiB chunks with
content-length and a second running SHA-256 check. The upload POST response and
GET-by-ID postflight and a separate **consecutively paginated GET-by-ID assets list**
must agree on release ID, asset IDs, names, `uploaded` state, size and
`sha256:<64 hex>` digests. The embedded assets array in a release response is
not presumed to be a complete inventory. GitHub REST documentation describes the
`digest` field for release assets; R6 deliberately fails closed if this field is
missing or null on a newly uploaded asset. These checks establish server-reported
binary SHA-256 equivalence to the local bytes, not publisher identity, software
provenance or a verified cryptographic signature. Actual multi-platform
artifacts remain a separate operational release gate.

No local private tag is to be moved by this implementation. In particular,
`v2.3.0` currently resolves to a private-history object in this checkout and
must be handled through a **separate** authorized, privacy-verified procedure.

## R7 focused safety corrections (awaiting independent audit)

The R7 staging changes are **not** permission to publish a tag or release.
They enforce the exact REST object identity in an optional HTTP 201 Location
header and in asset REST url fields, rather than trusting a shared path
prefix. The strict JSON decoder rejects numeric exponents that overflow the
supported finite range. Local release files are opened nonblocking and then
validated with fstat, preventing a FIFO swapped for an input file from
blocking the process before validation. The postflight's final local hash
checks share the global deadline, and a newly created journal's parent
directory is synced before any remote POST is attempted.

**Source and binary association across the build matrix:** each of the four
platform builds produces a release-source-<runner>.json file containing the
exact checked-out commit, GitHub workflow run ID/attempt, runner identity and
SHA-256 digests of the runtime archive and packaged installers. The publisher,
before generating final checksums or contacting the release API, requires all
four manifests to agree with the independently approved SHA, GITHUB_SHA,
the publisher's own checked-out HEAD, and the current workflow run; it also
rehashes and checks that the *entire downloaded artifact set* matches the
four original manifests. The manifest files themselves are included in the
draft's checksummed assets. These are **CI self-reported source/build records**,
not independently signed SLSA attestations or proof that a compiler behaved
correctly. Actual OS-specific signing, binary inspection and provenance
are separate gates.

**Non-atomic GitHub tag precondition:** the GitHub REST create-release API
may implicitly create the tag if an external actor deletes it after the
last verified GET and before POST. Repeating GET cannot close this race.
Before staging, an authorized maintainer must verify operational tag
protection/freeze, immutable release SHA approval, independently reviewed
default-branch integration and token/draft visibility on the real runner.
No automation should claim absolute no-implicit-tag-creation security under
arbitrary concurrent tag mutations. The private local v2.3.0 tag remains
blocked and must never be pushed by a bulk refspec. None of these gates has
been executed or authorized by R7 development.
