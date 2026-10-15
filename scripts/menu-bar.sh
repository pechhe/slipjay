#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
build="$root/.build/menu-bar"
app="$build/SlipJay.app"
installed="$HOME/Applications/SlipJay.app"
plist="$HOME/Library/LaunchAgents/com.pechhe.slipjay-menubar.plist"
compile() {
  mkdir -p "$app/Contents/MacOS"
  sdk=$(xcrun --sdk macosx --show-sdk-path)
  arch=$(uname -m)
  xcrun swiftc -sdk "$sdk" -target "$arch-apple-macosx13.0" -parse-as-library "$root/macos/RunnerContract.generated.swift" "$root/macos/RunnerModel.swift" "$root/macos/StatusPolicy.swift" "$root/macos/ControlPolicy.swift" "$root/macos/App.swift" -o "$app/Contents/MacOS/SlipJay"
  cp "$root/macos/Info.plist" "$app/Contents/Info.plist"
}
case "${1:-}" in
  build) compile ;;
  test)
    mkdir -p "$build"
    xcrun swiftc -sdk "$(xcrun --sdk macosx --show-sdk-path)" -target "$(uname -m)-apple-macosx13.0" "$root/macos/RunnerContract.generated.swift" "$root/macos/RunnerModel.swift" "$root/macos/StatusPolicy.swift" "$root/macos/ControlPolicy.swift" "$root/macos/Tests.swift" -o "$build/tests"
    "$build/tests" "$root/macos/fixtures/lifecycle.jsonl"
    ;;
  install)
    identity="${2:-${SLIPJAY_SIGNING_IDENTITY:-}}"
    [[ -n "$identity" ]] || { echo 'Supply a signing identity as argument 2 or SLIPJAY_SIGNING_IDENTITY' >&2; exit 1; }
    compile
    codesign --force --deep --sign "$identity" "$app"
    codesign --verify --deep --strict "$app"
    backup="$HOME/Library/Application Support/SlipJay/backups/$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$backup" "$HOME/Applications" "$(dirname "$plist")"
    [[ ! -e "$installed" ]] || ditto "$installed" "$backup/SlipJay.app"
    [[ ! -e "$plist" ]] || cp "$plist" "$backup/login-item.plist"
    launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
    ditto "$app" "$installed"
    python3 - "$plist" "$installed/Contents/MacOS/SlipJay" <<'PY'
import os,plistlib,sys
with open(sys.argv[1],'wb') as f:
 plistlib.dump({'Label':'com.pechhe.slipjay-menubar','ProgramArguments':[sys.argv[2]],'EnvironmentVariables':{'PATH':os.environ['PATH']},'RunAtLoad':True,'KeepAlive':False},f)
PY
    plutil -lint "$plist"
    launchctl enable "gui/$(id -u)/com.pechhe.slipjay-menubar"
    launchctl bootstrap "gui/$(id -u)" "$plist"
    echo "Installed; recovery backup: $backup"
    ;;
  status)
    codesign --verify --deep --strict "$installed"
    launchctl print "gui/$(id -u)/com.pechhe.slipjay-menubar" | python3 -c '
import re,sys
for line in sys.stdin:
 match = re.fullmatch(r"\s*(state|pid|runs|last exit code) = ([A-Za-z0-9_. -]+)\s*", line)
 if match: print(f"{match[1]}: {match[2].strip()}")
' 
    ;;
  *) echo 'Usage: scripts/menu-bar.sh <build|test|install [signing-identity]|status>' >&2; exit 2 ;;
esac
