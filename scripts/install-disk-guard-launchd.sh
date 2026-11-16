#!/usr/bin/env bash
# Install the five-minute pressure pass and hourly repository maintenance as user LaunchAgents.
# --no-load writes the files without loading them (for inspection/tests).
set -euo pipefail
if [ "${1:-}" != "" ] && [ "${1:-}" != "--no-load" ]; then echo 'Usage: install-disk-guard-launchd.sh [--no-load]' >&2; exit 1; fi
slipjay_bin="$(command -v slipjay)" || { echo 'slipjay is not on PATH' >&2; exit 1; }
command -v python3 >/dev/null
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.slipjay/state"
install -m 755 "$here/maintain.sh" "$HOME/.slipjay/maintain.sh"
python3 - "$slipjay_bin" <<'PY'
import os, plistlib, sys
home = os.path.expanduser('~')
for label, seconds, args in [
    ('com.pechhe.slipjay-disk', 300, [sys.argv[1], 'disk']),
    ('com.pechhe.slipjay-maintain', 3600, ['/bin/bash', home + '/.slipjay/maintain.sh', sys.argv[1]]),
]:
    unit = dict(Label=label, ProgramArguments=args, StartInterval=seconds, RunAtLoad=True,
                ProcessType='Background', Nice=10, WorkingDirectory=home,
                EnvironmentVariables=dict(PATH=os.environ['PATH']),
                StandardOutPath=home + '/.slipjay/state/' + label + '.log',
                StandardErrorPath=home + '/.slipjay/state/' + label + '.log')
    with open(home + '/Library/LaunchAgents/' + label + '.plist', 'wb') as f:
        plistlib.dump(unit, f)
PY
if [ "${1:-}" != "--no-load" ]; then
  for name in com.pechhe.slipjay-disk com.pechhe.slipjay-maintain; do
    unit="$HOME/Library/LaunchAgents/$name.plist"
    launchctl bootout "gui/$(id -u)" "$unit" 2>/dev/null || true
    launchctl enable "gui/$(id -u)/$name"
    launchctl bootstrap "gui/$(id -u)" "$unit"
    launchctl print "gui/$(id -u)/$name"
  done
fi
