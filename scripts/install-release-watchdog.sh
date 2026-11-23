#!/usr/bin/env bash
# Install the standalone release watchdog and enable its systemd user timer.
# Re-running updates both units and preserves the webhook unless explicitly supplied.
set -euo pipefail

webhook_url=
if [[ $# != 0 ]]; then
  if [[ $# != 2 || ${1:-} != --webhook-url || ! ${2:-} =~ ^https?://[^[:space:]/] || ${2:-} =~ [[:space:]] ]]; then
    echo "usage: $0 [--webhook-url <http-or-https-url>]" >&2
    exit 2
  fi
  webhook_url=$2
fi
command -v systemctl >/dev/null || { echo "missing systemctl on PATH" >&2; exit 1; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$HOME/.local/bin" "$HOME/.config/systemd/user" "$HOME/.config/slipjay"
install -m 755 "$here/release-watchdog-probe.ts" "$HOME/.local/bin/slipjay-release-watchdog-probe.ts"
if [[ -n $webhook_url ]]; then
  temp="$(mktemp "$HOME/.config/slipjay/.release-watchdog-webhook.XXXXXX")"
  trap 'rm -f "$temp"' EXIT
  chmod 600 "$temp"
  printf '%s\n' "$webhook_url" > "$temp"
  mv -f "$temp" "$HOME/.config/slipjay/release-watchdog-webhook.url"
fi

cat > "$HOME/.config/systemd/user/slipjay-release-watchdog-probe.service" <<'UNIT'
[Unit]
Description=SlipJay release watchdog probe

[Service]
Type=oneshot
Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env bun "%h/.local/bin/slipjay-release-watchdog-probe.ts"
UNIT

cat > "$HOME/.config/systemd/user/slipjay-release-watchdog-probe.timer" <<'UNIT'
[Unit]
Description=SlipJay release watchdog every ten minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=10min
OnCalendar=*:0/10
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# Persistent catch-up applies to calendar timers, not monotonic timers.
systemctl --user daemon-reload
systemctl --user enable --now slipjay-release-watchdog-probe.timer
