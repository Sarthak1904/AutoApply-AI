#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

python_bin="python3"
if [[ -x backend/venv/bin/python ]]; then
  python_bin="backend/venv/bin/python"
fi

"$python_bin" -m compileall -q backend tests
"$python_bin" -m unittest discover -s tests -v

while IFS= read -r js_file; do
  node --check "$js_file"
done < <(rg --files extension extension-chrome backend/dashboard -g '*.js')

while IFS= read -r js_test; do
  node "$js_test"
done < <(rg --files tests/js extension/tests extension-chrome/tests -g '*.test.js')

"$python_bin" - <<'PY'
import json
from pathlib import Path

for manifest in (Path("extension/manifest.json"), Path("extension-chrome/manifest.json")):
    json.loads(manifest.read_text())
    print(f"validated {manifest}")
PY

git diff --check
