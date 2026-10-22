#!/usr/bin/env bash
# Compatibility entrypoint for GitHub Actions. All release mutations and REST
# validation are performed by the bounded Python client, without using GH CLI.
set -euo pipefail
exec python3 -B "$(dirname -- "${BASH_SOURCE[0]}")/stage_release_draft.py" "$@"
