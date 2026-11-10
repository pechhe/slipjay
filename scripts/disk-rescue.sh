#!/bin/sh
# Free space before a service starts, without needing anything that needs disk to run: plain POSIX
# shell, no SlipJay, Node or jj. A systemd unit runs it as `ExecStartPre=-` (the `-` means a failure
# never blocks the start), and an operator can run it by hand.
#
#   - at or above SLIPJAY_RESCUE_SHED_PERCENT (default 88): delete the regenerable paths;
#   - at or above SLIPJAY_RESCUE_CRITICAL_PERCENT (default 96): also delete the ballast file, the
#     reserve `slipjay disk` keeps for exactly this moment.
#
# Settings come from ~/.slipjay/disk-rescue.env (shell variable assignments, which every `slipjay disk` pass
# rewrites from the machine config's `disk` key, so this script and the policy never disagree) or from the environment.
# SLIPJAY_RESCUE_USAGE_PERCENT overrides the measured usage, for tests. Always exits 0.
home="${HOME:-/root}"
[ -f "$home/.slipjay/disk-rescue.env" ] && . "$home/.slipjay/disk-rescue.env"
shed="${SLIPJAY_RESCUE_SHED_PERCENT:-88}"
critical="${SLIPJAY_RESCUE_CRITICAL_PERCENT:-96}"
ballast="${SLIPJAY_RESCUE_BALLAST:-$home/.slipjay/disk-ballast}"
regenerable="${SLIPJAY_RESCUE_REGENERABLE:-/tmp/node-compile-cache}"
root="${SLIPJAY_RESCUE_ROOT:-/}"

usage="${SLIPJAY_RESCUE_USAGE_PERCENT:-}"
[ -n "$usage" ] || usage=$(df -P "$root" 2>/dev/null | awk 'NR==2 { gsub("%", "", $5); print $5 }')
case "$usage" in ''|*[!0-9]*) echo "disk-rescue: cannot read usage of $root" >&2; exit 0 ;; esac

say() { echo "disk-rescue: ${usage}% $*"; logger -t slipjay-disk-rescue "${usage}% $*" 2>/dev/null; }

if [ "$usage" -ge "$shed" ]; then
  # One path per whitespace-separated word; paths with spaces are not supported here, by design.
  for path in $regenerable; do
    [ -e "$path" ] && rm -rf "$path" && say "removed $path"
  done
fi
if [ "$usage" -ge "$critical" ] && [ -f "$ballast" ]; then
  rm -f "$ballast" && say "released ballast $ballast"
fi
exit 0
