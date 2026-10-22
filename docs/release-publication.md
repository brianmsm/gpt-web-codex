# Publish a release — single-maintainer workflow

The project is maintained by one person. ChatGPT can help prepare and verify a release, but **the maintainer decides when to create the tag and when to publish**.

## Normal workflow

1. **Finish and validate source.** Merge changes to the public main branch; ensure Linux, macOS and Windows CI are green. Release builds must come from the current main commit.
2. **Use a clean public-only clone.** Never publish tags from the original development checkout: an old **local v2.3.0 tag points at private history**. A separate public-only clone is available on the development machine; verify its exact path, Git status, current HEAD, local tags, and remote before using it.
3. **Check version and remote absence.** Both package.json and launcher/package.json must match the intended tag (v2.3.0). Verify the exact public main SHA, that refs/tags/v2.3.0 does not exist remotely, and that no draft or published release already uses it.
4. **Explicitly authorize one tag.** Only after inspecting the SHA and the reachable history, create a single **annotated** version tag at that SHA in the isolated public-only clone. Push **that one tag ref** to GitHub; no bulk operations:
   ~~~bash
   git tag -a v2.3.0 <verified-40-hex-main-commit> -m "GPT Web Codex v2.3.0"
   git push --no-follow-tags origin refs/tags/v2.3.0:refs/tags/v2.3.0
   ~~~
   **Never** use git push --tags, --mirror, --all, or --follow-tags from any checkout containing private refs.
5. **GitHub Actions builds and drafts.** The tag triggers four release builds (macOS ARM64 and Intel, Linux and Windows). The workflow verifies source-commit identity and SHA-256 of artifacts from all four jobs, stages a GitHub Release **draft**, and independently compares its uploaded file names, sizes and server-reported SHA-256 digests with the local checksums. There is no self-review checkpoint.
6. **Review and publish manually.** Inspect the workflow, checksums.txt, the release assets, notices/licenses and macOS/Windows signing status. Then use GitHub's **Publish release** action when you are satisfied. Nothing auto-publishes.

## Failure handling

- If build, check, tag resolution, upload, or draft verification fails, inspect the GitHub Actions result and any partial draft **before rerunning**. A failed upload can leave a partial remote draft; do not delete, overwrite, or retry it blindly.
- The script checks that the tag points to the **current public main HEAD**. If main advances while a release is being built, staging will deliberately refuse and require maintainer review.
- The GitHub CLI uses --verify-tag so draft creation must not silently create a missing tag; its --draft flag prevents automatic public release. The tag race cannot be made fully atomic, so use a single trusted operator and avoid concurrent tag changes.
- Release artifacts and SHA-256 are verified, but this does not magically sign binaries or prove that build tooling is free of compromise.

## Historical high-assurance workflow

The original environment reviewer gate, independent SHA variable approval, custom Python REST publisher, state journal, extensive adversarial tests and operator checklist are preserved as source and configuration guidance in the archived branch:

https://github.com/brianmsm/gpt-web-codex/tree/archive/release-governance-v2.3.0-20261023

The old GitHub Environment settings do not automatically follow a branch. The archived guide records their former values for restoration if a multi-maintainer governance model becomes useful again.

**No tag creation, source deployment, package installation, or release publication is implied by this documentation.**
