#!/usr/bin/env bash
set -euo pipefail
mode="${1:-git}"
target="${2:-.}"
case "$mode" in git|dir) ;; *) echo 'Expected git or dir scan mode.' >&2; exit 1 ;; esac
scanner_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/protonncord-gitleaks-8.30.1"
mkdir -p -- "$scanner_dir"
curl --fail --location --silent --show-error --output "$scanner_dir/gitleaks.tar.gz" https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
printf '%s  %s\n' 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb "$scanner_dir/gitleaks.tar.gz" | sha256sum --check --strict
tar -xzf "$scanner_dir/gitleaks.tar.gz" -C "$scanner_dir" gitleaks
if [[ "$mode" == git ]]; then
    "$scanner_dir/gitleaks" git "$target" --config .gitleaks.toml --redact --no-banner --log-opts=--all
else
    "$scanner_dir/gitleaks" dir "$target" --config .gitleaks.toml --redact --no-banner --max-archive-depth=2
fi
