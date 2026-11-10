#!/usr/bin/env bash
# Install the disk guard on this host: the rescue script `ExecStartPre=-` steps use, and a systemd user
# timer that runs `slipjay disk` every five minutes (the pressure pass). Re-running rewrites both.
#
#   scripts/install-disk-guard.sh
#
# The units a service needs to restart through a full disk (no start limit, the rescue step) are the
# service's own setup: the runner's by scripts/setup-runner.sh, T3's by the machine playbook.
set -euo pipefail

for tool in systemctl; do
  command -v "$tool" >/dev/null || { echo "missing $tool on PATH" >&2; exit 1; }
done
slipjay_bin="$(command -v slipjay)" || { echo "slipjay is not on PATH" >&2; exit 1; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$HOME/.local/bin" "$HOME/.config/systemd/user"
install -m 755 "$here/disk-rescue.sh" "$HOME/.local/bin/slipjay-disk-rescue"

cat > "$HOME/.config/systemd/user/slipjay-disk.service" <<UNIT
[Unit]
Description=SlipJay disk-pressure pass

[Service]
Type=oneshot
ExecStart=$slipjay_bin disk
Nice=10
UNIT

cat > "$HOME/.config/systemd/user/slipjay-disk.timer" <<'UNIT'
[Unit]
Description=SlipJay disk-pressure pass every five minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=15s

[Install]
WantedBy=timers.target
UNIT

# The timer must outlive the login session, as the runner's unit does.
loginctl enable-linger "${USER:-$(id -un)}" 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now slipjay-disk.timer
systemctl --user --no-pager list-timers slipjay-disk.timer | head -3
