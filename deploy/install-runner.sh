#!/usr/bin/env bash
# يثبّت GitHub Actions runner على الخادم كخدمة، فيُنشر من GitHub دون مفتاح SSH.
# يطلب رمز التسجيل (يظهر في GitHub: Settings → Actions → Runners → New self-hosted runner، بعد --token).
set -euo pipefail
REPO_URL=https://github.com/bdr83/FLEET
DIR=/opt/fleet/runner
read -rp "Runner token: " TOKEN </dev/tty
# يقبل الرمز وحده أو سطر GitHub كاملًا (./config.sh ... --token XXXX)
case "$TOKEN" in *--token*) TOKEN=${TOKEN##*--token }; TOKEN=${TOKEN%% *};; esac
TOKEN=$(printf '%s' "$TOKEN" | tr -d '[:space:]')
[ -n "$TOKEN" ] || { echo "no token"; exit 1; }
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
mkdir -p "$DIR" && cd "$DIR"
if [ ! -x ./config.sh ]; then
  # آخر إصدار من تحويل صفحة latest (بلا أنابيب تنكسر مع pipefail)
  latest=$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/actions/runner/releases/latest)
  V=${latest##*/v}
  [ -n "$V" ] && [ "$V" != "$latest" ] || { echo "could not find the runner version"; exit 1; }
  curl -fsSL -o runner.tgz "https://github.com/actions/runner/releases/download/v$V/actions-runner-linux-x64-$V.tar.gz"
  tar xzf runner.tgz && rm runner.tgz
  ./bin/installdependencies.sh >/dev/null
fi
export RUNNER_ALLOW_RUNASROOT=1
./config.sh --unattended --replace --url "$REPO_URL" --token "$TOKEN" --name "$(hostname)-fleet" --labels fleet-pilot --work _work
./svc.sh install root >/dev/null && ./svc.sh start >/dev/null
./svc.sh status | grep -m1 -E "active|Active" || true
echo "runner installed: $(hostname)-fleet (label fleet-pilot)"
