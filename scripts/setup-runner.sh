#!/usr/bin/env bash
# Install the SlipJay runner as a systemd user service on this host.
#
#   scripts/setup-runner.sh <owner/name>=<git url> [<owner/name>=<git url> ...]
#
# Needs `slipjay` (bun global install), `jj` and `bws` on PATH, and the Bitwarden
# secret SLIPJAY_RUNNER_TOKEN. Re-running rewrites the config and unit and restarts.
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: $0 <owner/name>=<git url> ..." >&2; exit 2; }
for tool in slipjay jj bws loginctl systemctl; do
  command -v "$tool" >/dev/null || { echo "missing $tool on PATH" >&2; exit 1; }
done

home="$HOME/.slipjay/runner"
mkdir -p "$home" "$HOME/.config/systemd/user"
chmod 700 "$home"

repos=""
for pair in "$@"; do
  name="${pair%%=*}" url="${pair#*=}"
  repos="$repos${repos:+,}\"$name\":{\"url\":\"$url\"}"
done
printf '{"name":"%s","listen":{"host":"127.0.0.1","port":7787},"repos":{%s}}\n' "$(hostname -s)" "$repos" > "$home/config.json"

# PATH as this login shell sees it, so gate commands find bun, jj and node.
cat > "$HOME/.config/systemd/user/slipjay-runner.service" <<UNIT
[Unit]
Description=SlipJay runner
After=network-online.target

[Service]
Environment=PATH=$PATH
ExecStart=$(command -v bws) run -- $(command -v slipjay) runner serve
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
UNIT

loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable slipjay-runner.service
systemctl --user restart slipjay-runner.service
systemctl --user --no-pager status slipjay-runner.service | head -5
