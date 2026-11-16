#!/usr/bin/env bash
# Hourly maintenance for every registered integration root. Safe to rerun; failures do not skip other roots.
set -uo pipefail
slipjay_bin="${1:-$(command -v slipjay)}"
state="${SLIPJAY_STATE_HOME:-$HOME/.slipjay/state}"
status=0
while IFS= read -r root; do
  [ -d "$root" ] || continue
  (cd "$root" && "$slipjay_bin" maintain) || status=1
done < <(python3 - "$state/workspaces" <<'PY'
import glob, json, os, sys
roots = set()
for path in glob.glob(os.path.join(sys.argv[1], '*.json')):
    try:
        root = json.load(open(path)).get('integrationRoot')
        if isinstance(root, str) and '\n' not in root:
            roots.add(root)
    except (OSError, ValueError):
        pass
for root in sorted(roots):
    print(root)
PY
)
exit "$status"
