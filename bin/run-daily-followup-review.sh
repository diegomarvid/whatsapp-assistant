#!/bin/zsh
set -euo pipefail

repo_dir="/Users/diegomarvid/Documents/whatsapp-assistant"
data_dir="$repo_dir/data/daily-followup-reviews"
run_date="$(TZ=America/Montevideo date +%F)"
codex_bin="$(command -v codex)"

mkdir -p "$data_dir"

if [[ "${1:-}" == "--dry-run" ]]; then
  cd "$repo_dir"
  ./bin/wa.js status
  GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/Users/diegomarvid/.config/gws-usemaspeak \
    gws gmail users messages list --params '{"userId":"me","maxResults":1}' >/dev/null
  print "Daily follow-up review prerequisites are healthy for $run_date."
  exit 0
fi

cd "$repo_dir"
export DAILY_FOLLOWUP_DATE="$run_date"
"$codex_bin" exec \
  --cd "$repo_dir" \
  --sandbox danger-full-access \
  --ask-for-approval never \
  --output-last-message "$data_dir/$run_date.codex-last-message.txt" \
  - < "$repo_dir/prompts/daily-followup-review.md" \
  >> "$data_dir/$run_date.run.log" 2>&1
