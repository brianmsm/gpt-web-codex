#!/usr/bin/env bash
# Compatibility entrypoint: GH CLI transport, draft only, no auto-publication.
set -euo pipefail
exec python3 -B "$(dirname -- "$0")/stage_release_draft.py" "$@"
