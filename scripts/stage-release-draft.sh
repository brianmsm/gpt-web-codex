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
  if [[ ! "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ \
        || "$name" == *. || ${#name} -gt 255 ]]; then
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

# A 404 for a release is meaningful only after authenticating the repository
# context and verifying that this token can read releases and push contents.
# `gh api --include` is the documented GitHub CLI interface that provides the
# actual HTTP status line. Never infer absence from the CLI exit status alone.
if [[ ! "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
   || [[ ! "$GITHUB_REF_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]] \
   || [[ -z "${GH_TOKEN:-}" ]] \
   || [[ "${GH_HOST:-github.com}" != github.com ]]; then
  echo "Untrusted GitHub repository, tag, or missing authenticated GH_TOKEN" >&2
  exit 3
fi

api_dir="$(mktemp -d)"
trap 'rm -rf -- "$api_dir"' EXIT
api_raw="$api_dir/response"
api_body="$api_dir/body"
api_status=''
api_exit=0

# Python's strict JSON decoder rejects duplicate object keys and non-finite
# constants, which jq would otherwise normalize before our schema checks.
strict_json_file() {
  python3 -B - "$1" <<'PY_JSON'
import json
from pathlib import Path
import sys


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON object field')
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError('non-JSON numeric constant')


try:
    with Path(sys.argv[1]).open(encoding='utf-8') as handle:
        json.load(handle, object_pairs_hook=unique_pairs, parse_constant=reject_constant)
except (OSError, UnicodeError, ValueError, TypeError):
    sys.exit(1)
PY_JSON
}

# Decode exactly one HTTP status line and header block from `gh api -i`.
# The body remains byte-for-byte intact for jq to validate independently.
# Ambiguous headers, non-JSON content, absent bodies, and malformed replies
# must never be interpreted as a confirmed release 404.
github_api_get() {
  local endpoint="$1"
  if gh api --hostname github.com --method GET --include "$endpoint" >"$api_raw" 2>"$api_dir/stderr"; then
    api_exit=0
  else
    api_exit=$?
  fi
  api_status="$(python3 -B - "$api_raw" "$api_body" <<'PY_HTTP'
import pathlib
import re
import sys

try:
    raw = pathlib.Path(sys.argv[1]).read_bytes()
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError('oversized HTTP output')
    separator = re.search(rb'\r?\n\r?\n', raw)
    if separator is None:
        raise ValueError('missing HTTP header separator')
    header_lines = raw[:separator.start()].splitlines()
    if len(header_lines) < 2 or len(header_lines) > 200:
        raise ValueError('invalid HTTP headers')
    status = re.fullmatch(
        rb'HTTP/(?:1\.[01]|2(?:\.0)?|3(?:\.0)?) ([1-5][0-9][0-9])(?: [^\r\n]*)?',
        header_lines[0],
    )
    if status is None:
        raise ValueError('invalid HTTP status line')
    fields = []
    for line in header_lines[1:]:
        if b':' not in line or line[0] in b' \t':
            raise ValueError('malformed HTTP header')
        key, value = line.split(b':', 1)
        if re.fullmatch(rb'[A-Za-z0-9-]+', key) is None:
            raise ValueError('invalid header name')
        fields.append((key.lower(), value.strip().lower()))
    content_type = [value for key, value in fields if key == b'content-type']
    if len(content_type) != 1 or re.fullmatch(
        rb'application/(?:[a-z0-9.-]+\+)?json(?:\s*;[^\r\n]*)?', content_type[0]
    ) is None:
        raise ValueError('missing or ambiguous JSON content type')
    body = raw[separator.end():]
    if not body.strip():
        raise ValueError('empty HTTP body')
    pathlib.Path(sys.argv[2]).write_bytes(body)
    print(status.group(1).decode('ascii'))
except (OSError, ValueError, UnicodeError, IndexError):
    sys.exit(1)
PY_HTTP
)" || return 1
}

if ! github_api_get "repos/$GITHUB_REPOSITORY" \
   || [[ "$api_exit" -ne 0 || "$api_status" != 200 ]] \
   || ! strict_json_file "$api_body" \
   || ! jq --slurp -e --arg repo "$GITHUB_REPOSITORY" '
        length == 1 and (.[0] | type == "object") and
        (.[0].full_name | type == "string") and
        ((.[0].full_name | ascii_downcase) == ($repo | ascii_downcase)) and
        (.[0].permissions | type == "object") and
        (.[0].permissions.push == true)
      ' "$api_body" >/dev/null; then
  echo "Cannot establish authenticated repository identity and write access" >&2
  exit 3
fi

# A readable release listing distinguishes a working Releases API from a
# misleading 404 caused by an inaccessible API or repository.
if ! github_api_get "repos/$GITHUB_REPOSITORY/releases?per_page=1" \
   || [[ "$api_exit" -ne 0 || "$api_status" != 200 ]] \
   || ! strict_json_file "$api_body" \
   || ! jq --slurp -e 'length == 1 and (.[0] | type == "array")' "$api_body" >/dev/null; then
  echo "Cannot establish authenticated GitHub Releases read access" >&2
  exit 3
fi

# Deliberately refuse *all* existing releases, including drafts. An HTTP 404
# with a GitHub JSON Not Found body and gh's normal HTTP failure status is the
# only accepted absence. All network/permission/rate-limit/ambiguous failures
# are non-mutating; even a timeout after printing a 404 must be rejected.
if ! github_api_get "repos/$GITHUB_REPOSITORY/releases/tags/$GITHUB_REF_NAME"; then
  echo "Cannot establish GitHub Release existence (invalid HTTP reply)" >&2
  exit 3
fi
if [[ "$api_status" == 200 && "$api_exit" -eq 0 ]]; then
  echo "Refusing existing GitHub Release (including drafts): $GITHUB_REF_NAME" >&2
  exit 3
fi
if [[ "$api_status" != 404 || "$api_exit" -ne 1 ]] \
   || ! strict_json_file "$api_body" \
   || ! jq --slurp -e '
        length == 1 and (.[0] | type == "object") and
        (.[0].message == "Not Found") and
        ((.[0].status? // "404" | tostring) == "404")
      ' "$api_body" >/dev/null; then
  echo "Cannot prove GitHub Release absence; refusing creation" >&2
  exit 3
fi

gh release create "$GITHUB_REF_NAME" "${release_files[@]}" \
  --repo "github.com/$GITHUB_REPOSITORY" \
  --verify-tag \
  --title "$GITHUB_REF_NAME" \
  --draft \
  --generate-notes

# A green job requires an exact remotely observed asset list. A failed
# verification leaves the release in *draft* state for manual examination.
remote_json="$(gh release view "$GITHUB_REF_NAME" \
  --repo "github.com/$GITHUB_REPOSITORY" --json isDraft,assets)"
# The entire gh reply must be exactly one parseable JSON object. `--slurp`
# parses the *whole* stream before assessing our predicate; checking jq's exit
# code directly prevents partial output from being mistaken for success.
expected_json="$(jq -cn '$ARGS.positional' --args "${expected_names[@]}")"
printf '%s' "$remote_json" >"$api_dir/postflight.json"
if ! strict_json_file "$api_dir/postflight.json" \
   || ! jq --slurp -e --argjson expected "$expected_json" '
    length == 1 and (.[0] | type == "object") and
    (.[0].isDraft | type == "boolean") and (.[0].isDraft == true) and
    (.[0].assets | type == "array") and
    (all(.[0].assets[];
       type == "object" and (.name | type == "string") and
       (.name | length > 0 and length <= 255) and
       (.name | test("^[A-Za-z0-9][A-Za-z0-9._+-]*$")) and
       (.name | endswith(".") | not))) and
    ((.[0].assets | map(.name | ascii_downcase) | unique | length)
      == (.[0].assets | length)) and
    ((.[0].assets | map(.name) | sort) == ($expected | sort))
  ' <<<"$remote_json" >/dev/null; then
  echo "Remote release response is invalid or draft asset names differ" >&2
  exit 3
fi
printf 'DRAFT_STAGED_ASSET_INVENTORY_VERIFIED=%s\n' "${#expected_names[@]}"
