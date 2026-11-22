#!/usr/bin/env bash
# يثبّت GitHub Actions runner على الخادم كخدمة، فيُنشر من GitHub دون مفتاح SSH.
# يطلب رمز التسجيل (يظهر في GitHub: Settings → Actions → Runners → New self-hosted runner، بعد --token).
set -euo pipefail
REPO_URL=https://github.com/bdr83/FLEET
DIR=/opt/fleet/runner
read -rp "Runner token: " TOKEN </dev/tty
[ -n "$TOKEN" ] || { echo "no token"; exit 1; }
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
mkdir -p "$DIR" && cd "$DIR"
if [ ! -x ./config.sh ]; then
  V=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | grep -m1 '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
  curl -fsSL -o runner.tgz "https://github.com/actions/runner/releases/download/v$V/actions-runner-linux-x64-$V.tar.gz"
  tar xzf runner.tgz && rm runner.tgz
  ./bin/installdependencies.sh >/dev/null
fi
export RUNNER_ALLOW_RUNASROOT=1
./config.sh --unattended --replace --url "$REPO_URL" --token "$TOKEN" --name "$(hostname)-fleet" --labels fleet-pilot --work _work
./svc.sh install root >/dev/null && ./svc.sh start >/dev/null
./svc.sh status | grep -m1 -E "active|Active" || true
echo "runner installed: $(hostname)-fleet (label fleet-pilot)"
