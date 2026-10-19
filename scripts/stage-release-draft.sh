#!/usr/bin/env bash
# Stage one fresh, checksummed GitHub Release draft. Safe to retry only
# when a full new preflight proves that no draft or published release exists.
# Never reuse, replace, delete, or --clobber an existing release. GitHub's
# list-then-create API is not atomic against external concurrent writers.
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
    # gh api --include prints a CLI representation, not necessarily raw
    # on-the-wire framing. Do not compare Content-Length to decoded bytes or
    # expect chunk delimiters. Nonetheless, duplicate/invalid length headers,
    # an incoherent TE+CL combination or a final Location are ambiguous.
    lengths = [value for key, value in fields if key == b'content-length']
    transfers = [value for key, value in fields if key == b'transfer-encoding']
    locations = [value for key, value in fields if key == b'location']
    if len(lengths) > 1 or len(transfers) > 1 or locations:
        raise ValueError('ambiguous HTTP response headers')
    if lengths and (re.fullmatch(rb'(?:0|[1-9][0-9]*)', lengths[0]) is None
                    or transfers):
        raise ValueError('invalid or incompatible HTTP framing metadata')
    if transfers and transfers[0] not in (b'chunked',):
        raise ValueError('unrecognized transfer encoding metadata')
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

# A GET-by-tag 404 is NOT evidence that a draft is absent: the List
# Releases endpoint includes drafts for authorized callers. Fetch ALL pages
# with gh's documented --paginate --slurp (array of JSON pages). Do not pipe
# through jq: preserve the exit code from the *entire* CLI pagination command.
# Fail closed on even partial output combined with a transport/API failure.
list_file="$api_dir/release-pages.json"
if ! gh api --hostname github.com --method GET --paginate --slurp \
  "repos/$GITHUB_REPOSITORY/releases?per_page=100" >"$list_file" 2>"$api_dir/list-stderr"; then
  echo "Cannot retrieve complete authenticated GitHub Releases listing" >&2
  exit 3
fi
if [[ ! -s "$list_file" || $(wc -c <"$list_file") -gt 33554432 ]]; then
  echo "Empty or oversized GitHub Releases listing" >&2
  exit 3
fi

# Validate the exact raw JSON stream (including duplicate keys, extra data,
# invalid UTF-8 and NaN), page topology, all IDs and tags, plus title
# collisions. The ID set is retained to reject postflight reuse.
if ! python3 -B - "$list_file" "$GITHUB_REF_NAME" \
     "$api_dir/list-ids.json" "$api_dir/page-count" <<'PY_RELEASE_LIST'
import json
from pathlib import Path
import sys

def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate release/list JSON field')
        result[key] = value
    return result

def reject_constant(value):
    raise ValueError('non-JSON constant')

try:
    with Path(sys.argv[1]).open(encoding='utf-8') as handle:
        pages = json.load(handle, object_pairs_hook=unique_pairs,
                          parse_constant=reject_constant)
    if type(pages) is not list or not 1 <= len(pages) <= 256:
        raise ValueError('missing, ambiguous or oversized pagination')
    target = sys.argv[2].casefold()
    ids, tags = set(), set()
    for index, page in enumerate(pages):
        if type(page) is not list or len(page) > 100:
            raise ValueError('invalid page type/size')
        if index + 1 < len(pages) and len(page) != 100:
            raise ValueError('non-final partial or empty page')
        for release in page:
            if type(release) is not dict:
                raise ValueError('invalid release object')
            release_id = release.get('id')
            tag = release.get('tag_name')
            name = release.get('name')
            if (type(release_id) is not int or
                    not 0 < release_id <= 9007199254740991 or
                    type(tag) is not str or not tag or
                    type(release.get('draft')) is not bool or
                    type(release.get('prerelease')) is not bool or
                    not (name is None or type(name) is str)):
                raise ValueError('invalid release ID/tag/draft/name fields')
            if release_id in ids or tag in tags:
                raise ValueError('duplicated ID or ambiguous tag across pages')
            ids.add(release_id)
            tags.add(tag)
            if tag.casefold() == target or (name is not None and name.casefold() == target):
                raise ValueError('existing release or colliding release title')
    Path(sys.argv[3]).write_text(json.dumps(sorted(ids)), encoding='utf-8')
    Path(sys.argv[4]).write_text(str(len(pages)) + '\n', encoding='ascii')
except (OSError, ValueError, TypeError, UnicodeError) as exc:
    print('GitHub Release list cannot prove absence:', type(exc).__name__, file=sys.stderr)
    sys.exit(1)
PY_RELEASE_LIST
then
  echo "Cannot prove absence of draft/published release across all pages" >&2
  exit 3
fi

# Secondary boundary query: defend against detectable missing final pages
# even if a faulty pager returned exit 0 (e.g. a lost Link header). The first
# page after the slurped pages must be empty, with an unambiguous 200. This
# still cannot make multiple GET requests an atomic snapshot.
read -r page_count <"$api_dir/page-count"
if [[ ! "$page_count" =~ ^[1-9][0-9]*$ ]] \
   || ! github_api_get "repos/$GITHUB_REPOSITORY/releases?per_page=100&page=$((page_count + 1))" \
   || [[ "$api_exit" -ne 0 || "$api_status" != 200 ]] \
   || ! strict_json_file "$api_body" \
   || ! jq --slurp -e 'length == 1 and (.[0] | type == "array" and length == 0)' "$api_body" >/dev/null; then
  echo "Incomplete or inconsistent GitHub Releases pagination boundary" >&2
  exit 3
fi

# Complementary by-tag check. A documented 404 for published releases cannot
# overrule the exhaustive draft-inclusive listing. Only the combined clean
# observations authorize attempting one fresh release create; no exactly-once
# guarantee exists against concurrent external actors.
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
# Read directly into a file to preserve NUL bytes and all trailing data.
# A command substitution would silently drop NULs; gh must also exit cleanly
# even if it printed a complete-looking object before an error.
postflight="$api_dir/postflight.json"
if ! gh release view "$GITHUB_REF_NAME" \
  --repo "github.com/$GITHUB_REPOSITORY" --json isDraft,assets,databaseId,tagName >"$postflight"; then
  echo "GitHub Release postflight failed; draft requires manual review" >&2
  exit 3
fi
# The entire reply must be exactly one parseable JSON object. `--slurp`
# parses the *whole* stream before assessing our predicate; jq's exit code
# is checked directly, as is the strict JSON parser's own exit code.
expected_json="$(jq -cn '$ARGS.positional' --args "${expected_names[@]}")"
if ! strict_json_file "$postflight" \
   || ! jq --slurp -e --argjson expected "$expected_json" \
       --arg tag "$GITHUB_REF_NAME" --slurpfile prior "$api_dir/list-ids.json" '
    length == 1 and (.[0] | type == "object") and
    (.[0].tagName == $tag) and
    (.[0].databaseId | type == "number" and . > 0 and . <= 9007199254740991 and . == floor) and
    (([.[0].databaseId] | inside($prior[0])) | not) and
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
  ' "$postflight" >/dev/null; then
  echo "Remote release response is invalid or draft asset names differ" >&2
  exit 3
fi
printf 'DRAFT_STAGED_ASSET_INVENTORY_VERIFIED=%s\n' "${#expected_names[@]}"
