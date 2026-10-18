#!/usr/bin/env bash
# Stage one fresh, checksummed GitHub Release draft. Intentionally NOT idempotent:
# retrying into any existing draft risks publishing stale, unchecksummed assets.
# Recovery is a separate, deliberate maintainer action, never auto --clobber.
set -euo pipefail

: "${GITHUB_REF_NAME:?Release tag must be supplied by GitHub Actions}"
: "${GITHUB_REPOSITORY:?Repository must be supplied by GitHub Actions}"

release_dir="${1:-release-assets}"
if [[ ! -d "$release_dir" || ! -f "$release_dir/checksums.txt" ]]; then
  echo "Missing release assets directory or checksums.txt" >&2
  exit 2
fi

# Flattening, naming, and manifest production happened in earlier CI steps.
# Repeat the critical checks independently immediately before any GitHub write.
if find "$release_dir" -mindepth 1 -maxdepth 1 ! -type f -print -quit | grep -q .; then
  echo "Release assets must consist of top-level regular files only" >&2
  exit 2
fi
mapfile -d '' release_files < <(find "$release_dir" -mindepth 1 -maxdepth 1 \
  -type f -print0 | sort -z)
if (( ${#release_files[@]} < 2 )); then
  echo "Expected checksums.txt and at least one release asset" >&2
  exit 2
fi

# Validate complete checksum coverage and the exact local inventory. The
# release pipeline generates simple controlled filenames (no spaces/newlines).
expected_names=()
for file in "${release_files[@]}"; do
  name="${file##*/}"
  if [[ "$name" == *[$'\n\r\t ']* || "$name" == .* ]]; then
    echo "Unsafe release asset filename" >&2
    exit 2
  fi
  expected_names+=("$name")
done
mapfile -t checksum_names < <(awk '{print $2}' "$release_dir/checksums.txt" | sort)
mapfile -t data_names < <(printf '%s\n' "${expected_names[@]}" \
  | grep -v '^checksums.txt$' | sort)
if [[ "${#checksum_names[@]}" -ne "${#data_names[@]}" ]] \
   || [[ "$(printf '%s\n' "${checksum_names[@]}")" != "$(printf '%s\n' "${data_names[@]}")" ]]; then
  echo "Checksum manifest does not exactly describe local release assets" >&2
  exit 2
fi
(cd "$release_dir" && sha256sum --status -c checksums.txt)

# Deliberately refuse *all* pre-existing releases (drafts AND published).
# A previous draft may contain assets not in this run's checksum manifest.
# A retry must explicitly retire the old draft under maintainer control.
if gh release view "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  echo "Refusing existing GitHub Release (including drafts): $GITHUB_REF_NAME" >&2
  exit 3
fi

gh release create "$GITHUB_REF_NAME" "${release_files[@]}" \
  --repo "$GITHUB_REPOSITORY" \
  --verify-tag \
  --title "$GITHUB_REF_NAME" \
  --draft \
  --generate-notes

# A green job requires an exact remotely observed asset list. A failed
# verification leaves the release in *draft* state for manual examination.
remote_json="$(gh release view "$GITHUB_REF_NAME" \
  --repo "$GITHUB_REPOSITORY" --json isDraft,assets)"
if [[ "$(jq -r '.isDraft' <<<"$remote_json")" != true ]]; then
  echo "Expected a draft; GitHub reports a non-draft release" >&2
  exit 3
fi
mapfile -t remote_names < <(jq -r '.assets[].name' <<<"$remote_json" | sort)
mapfile -t sorted_expected < <(printf '%s\n' "${expected_names[@]}" | sort)
if [[ "${#remote_names[@]}" -ne "${#sorted_expected[@]}" ]] \
  || [[ "$(printf '%s\n' "${remote_names[@]}")" != "$(printf '%s\n' "${sorted_expected[@]}")" ]]; then
  echo "Remote draft asset inventory differs from exact checksummed assets" >&2
  exit 3
fi
printf 'DRAFT_STAGED_ASSET_INVENTORY_VERIFIED=%s\n' "${#remote_names[@]}"
