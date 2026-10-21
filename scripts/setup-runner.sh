#!/usr/bin/env bash
# Install the SlipJay runner as a systemd user service on this host.
#
#   scripts/setup-runner.sh <owner/name>=<git url> [<owner/name>=<git url> ...]
#
# Needs `slipjay` (bun global install), `jj`, `bws` and `corepack` (bundled with Node 20/22; Node 25+
# needs `npm i -g corepack`) on PATH, and the Bitwarden secret SLIPJAY_RUNNER_TOKEN. Re-running rewrites the config and unit and restarts.
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: $0 <owner/name>=<git url> ..." >&2; exit 2; }
for tool in slipjay jj bws bun corepack loginctl systemctl; do
  command -v "$tool" >/dev/null || { echo "missing $tool on PATH" >&2; exit 1; }
done

home="$HOME/.slipjay/runner"
mkdir -p "$home" "$HOME/.config/systemd/user"
chmod 700 "$home"

# The runner commits as this identity (GitHub must link its email to the owner) and
# sets its jj settings in each warm checkout, so it needs nothing from the host's jj config.
name="${SLIPJAY_RUNNER_USER_NAME:-$(git config --global user.name)}"
email="${SLIPJAY_RUNNER_USER_EMAIL:-$(git config --global user.email)}"
[ -n "$name" ] && [ -n "$email" ] || { echo "set SLIPJAY_RUNNER_USER_NAME and SLIPJAY_RUNNER_USER_EMAIL (or git's global user)" >&2; exit 1; }
# Serialized by bun, so names with quotes or backslashes stay valid JSON. Settings this script does not own
# (such as "build") survive a re-run.
bun -e '
import { existsSync, readFileSync } from "node:fs";
const [host, name, email, existing, ...pairs] = process.argv.slice(1);
const repos = Object.fromEntries(pairs.map((pair) => { const at = pair.indexOf("="); return [pair.slice(0, at), { url: pair.slice(at + 1) }]; }));
const kept = existsSync(existing) ? JSON.parse(readFileSync(existing, "utf8")) : {};
console.log(JSON.stringify({ ...kept, name: host, listen: { host: "127.0.0.1", port: 7787 }, repos, jj: { "user.name": name, "user.email": email } }));
' "$(hostname -s)" "$name" "$email" "$home/config.json" "$@" > "$home/config.json.tmp"
mv "$home/config.json.tmp" "$home/config.json"

# A stop asks the runner alone to finish an integration in flight: systemd would signal every process in the
# unit, the jj and git commands the runner started among them, and bws (the unit's main process) does not
# forward signals. $1 is that main process; it is left alone, and so is everything outside the unit's cgroup.
cat > "$home/stop-runner.sh" <<'STOP'
#!/bin/sh
cg=$(sed -n 's/^0:://p' /proc/self/cgroup)
[ -n "$cg" ] || { echo "stop-runner: no unified (cgroup v2) hierarchy, so the runner cannot be found; systemd stops the whole unit at once" >&2; exit 1; }
runner() { pgrep --cgroup "$cg" -f 'runner [s]erve' | grep -vx "$1"; }
pids=$(runner "$1")
[ -n "$pids" ] || { echo "stop-runner: no runner process in $cg (or pgrep lacks --cgroup); systemd stops the whole unit at once" >&2; exit 1; }
echo "$pids" | xargs kill -TERM
while runner "$1" | grep -q .; do sleep 1; done
STOP
chmod 755 "$home/stop-runner.sh"

# Corepack shims for pnpm, so installs run the exact version a repository's `packageManager` pins. A global
# pnpm that finds a newer pin switches to it itself and rewrites pnpm-lock.yaml, which fails the landing.
# The shims sit first on the unit's PATH, ahead of any global pnpm.
shims="$home/corepack-bin"
mkdir -p "$shims"
corepack enable --install-directory "$shims" pnpm

# PATH as this login shell sees it, so gate commands find bun, jj and node.
cat > "$HOME/.config/systemd/user/slipjay-runner.service" <<UNIT
[Unit]
Description=SlipJay runner
After=network-online.target

[Service]
Environment=PATH=$shims:$PATH
Environment=COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ExecStart=$(command -v bws) run -- $(command -v slipjay) runner serve
Restart=always
RestartSec=5
KillMode=control-group
# A stop waits for an integration in flight to publish (stop-runner.sh), up to this long, before systemd signals the group.
ExecStop=$home/stop-runner.sh \${MAINPID}
TimeoutStopSec=900

[Install]
WantedBy=default.target
UNIT

loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable slipjay-runner.service
systemctl --user restart slipjay-runner.service
systemctl --user --no-pager status slipjay-runner.service | head -5
