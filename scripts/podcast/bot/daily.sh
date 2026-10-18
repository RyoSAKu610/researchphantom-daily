#!/usr/bin/env bash
# One command that the Grok bot daily Routine (Skill/Routine) calls:
#
#   bash scripts/podcast/bot/daily.sh
#
# What it does (in order):
#   1. flock guard so two runs never overlap (missing flock => refuse to run)
#   2. git pull --ff-only for updates from the remote (warning only on failure;
#      the working tree here is the source of truth, never reset --hard)
#   3. run node scripts/podcast/daily.mjs --catchup with TZ=Asia/Tokyo and
#      PODCAST_TTS_MAP="ja:irodori,en:voicestudio,zh:voicestudio,ko:voicestudio"
#      (daily.mjs is idempotent: existing episode dates are skipped; missed
#      dates back within config.backfillDays=3 are refilled by --catchup)
#   4. BY DEFAULT (opt-out with PODCAST_FALLBACK_EDGE=0): dates whose audio
#      ended up missing (fully or in some languages) are regenerated once with
#      the pure edge-TTS map (ja/en/zh/ko all edge; daily.mjs --force per date)
#      so every episode always ships all four languages. The old opt-in
#      behaviour is preserved via PODCAST_FALLBACK_EDGE=0 when you want to
#      report server-type failures instead of re-synthesizing with edge.
#   5. commit episodes/state (and the rebuilt podcast-site/, if present) and
#      push to origin; the push triggers the GitHub Pages deploy workflow.
#
# Exit code follows daily.mjs: 0 ok / 3 episode written but no audio this run /
# 1 startup or pipeline error / 2 another run is in progress.
# All output is also appended to podcast/logs/daily-YYYYMMDD.log (JST date).

set -euo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# this script lives at <repo>/scripts/podcast/bot/, so the repo root is 3 levels up
REPO_ROOT="$(cd "${BOT_DIR}/../../.." && pwd)"

if ! command -v flock >/dev/null 2>&1; then
  echo "daily.sh: flock is required to prevent concurrent runs; aborting" >&2
  echo "hint: apt install util-linux" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "daily.sh: node is required; run scripts/podcast/bot/setup.sh first" >&2
  exit 2
fi

cd "${REPO_ROOT}"
mkdir -p podcast/logs podcast/state

TODAY="$(TZ=Asia/Tokyo date '+%Y-%m-%d')"
# daily.mjs writes its own podcast/logs/daily.log; the shell-level log for the
# day's Routine lives beside it with a date-stamped name.
LOG_FILE="podcast/logs/daily-$(TZ=Asia/Tokyo date '+%Y%m%d').log"

# ---- process lock -------------------------------------------------------------
exec 9>podcast/state/daily.sh.lock
flock -n 9 || {
  echo "daily.sh: another run appears in progress (podcast/state/daily.sh.lock)"; exit 2;
}

# everything below is logged + printed
exec > >(tee -a "${LOG_FILE}") 2>&1

echo "daily.sh: start (date ${TODAY}, log ${LOG_FILE})"
record() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"podcast/logs/daily.log"; }

# ---------------------------------------------------------------- git pull ----
if git remote get-url origin >/dev/null 2>&1; then
  if ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    echo "no upstream branch set yet (first run); skipping pull"
  elif ! git pull --ff-only --quiet; then
    echo "warning: git pull --ff-only failed (divergent or offline); continuing on the local tree"
  else
    echo "git pull --ff-only ok"
  fi
else
  echo "no git origin configured; skipping pull"
fi

# ------------------------------------------------------------ pod. pipeline ----
export TZ=Asia/Tokyo
# Per-language servers on this VM. PODCAST_TTS_ENGINE stays unset, so any
# language missing from the map would fall back to the historical qwen default
# (that can never happen while config.languages is exactly ja/en/zh/ko).
export PODCAST_TTS_MAP="${PODCAST_TTS_MAP:-ja:irodori,en:voicestudio,zh:voicestudio,ko:voicestudio}"
unset PODCAST_TTS_ENGINE || true

set +e
node scripts/podcast/daily.mjs --catchup
RC=$?
set -e
record "daily.mjs --catchup exit ${RC}"
if [ "${RC}" -gt 0 ]; then
  echo "daily.sh: daily.mjs exited ${RC}"
fi

# ------------------------------------------------------ default edge fallback -
FINAL_RC="${RC}"
# Default behaviour: for a completed run (0 or 3), dates that ended with
# missing audio (fully or in some languages) are regenerated once with the
# pure edge map so the four-language requirement always holds. Set
# PODCAST_FALLBACK_EDGE=0 to opt out (report server failures instead).
# Mirrors the "edge is the main safety net" policy from the bot README.
if [ "${PODCAST_FALLBACK_EDGE:-1}" != "0" ] && { [ "${RC}" -eq 0 ] || [ "${RC}" -eq 3 ]; }; then
  EDGE_ENABLED=true
else
  EDGE_ENABLED=false
fi
if [ "${EDGE_ENABLED}" = "true" ]; then
  DATES="$(node -e '
    const fs = require("fs");
    try {
      const cfg = JSON.parse(fs.readFileSync("scripts/podcast/config.json", "utf8"));
      const langs = Array.isArray(cfg.languages) ? cfg.languages : [];
      const s = JSON.parse(fs.readFileSync("podcast/state/status.json", "utf8"));
      const dates = (s.results || [])
        .filter(r => {
          if (!r || !r.ok || !Array.isArray(r.audioLanguages)) return false;
          return r.audioLanguages.filter(l => langs.includes(l)).length < langs.length;
        })
        .map(r => r.date);
      process.stdout.write(dates.join(" "));
    } catch (err) {
      process.stdout.write("");
    }
  ')"
  if [ "${DATES}" != "" ]; then
    for d in ${DATES}; do
      echo "daily.sh: edge fallback (default on) -> regenerating ${d} with edge TTS"
      set +e
      PODCAST_TTS_ENGINE=edge \
      PODCAST_TTS_MAP="ja:edge,en:edge,zh:edge,ko:edge" \
        node scripts/podcast/daily.mjs --date "${d}" --force
      RC2=$?
      set -e
      record "edge fallback ${d} exit ${RC2}"
      if [ "${RC2}" -eq 0 ]; then
        FINAL_RC=0
      fi
    done
  fi
fi

# ------------------------------------------------------------- commit + push --
# podcast-site/ is gitignored (the Pages workflow rebuilds it from episodes);
# git add -A therefore stages episodes/, podcast/state/ etc., and everything
# ignored is skipped.
STAGED=0
if ! git diff --quiet HEAD -- >/dev/null 2>&1 || [ -n "$(git status --porcelain --untracked-files=all 2>/dev/null | head -1)" ]; then
  STAGED=1
fi
if git config user.email >/dev/null 2>&1; then :; else
  git config user.email "podcast-bot@localhost"
  git config user.name "podcast-bot"
fi

if [ "${STAGED}" = "1" ]; then
  git add -A
  if ! git diff --cached --quiet; then
    if git commit -q -m "daily: ${TODAY} generated"; then
      echo "committed: daily: ${TODAY} generated"
    else
      echo "warning: git commit failed"
    fi
    if git remote get-url origin >/dev/null 2>&1; then
      if git push origin HEAD --quiet; then
        echo "pushed to origin $(git rev-parse --abbrev-ref HEAD)"
        echo "Pages deploy: GitHub Actions build should be running (workflow 'deploy')"
      else
        echo "warning: git push failed (non-fatal; the diff stays local for the next catchup)"
      fi
    fi
  fi
else
  echo "nothing to commit"
fi

record "daily.sh exit ${FINAL_RC}"
echo "daily.sh: done (exit ${FINAL_RC})"
echo "outputs: podcast/episodes/${TODAY}/  podcast/state/status.json  podcast-site/"
exit "${FINAL_RC}"
