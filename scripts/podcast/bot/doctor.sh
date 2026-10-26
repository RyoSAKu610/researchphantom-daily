#!/usr/bin/env bash
# Health check for the "Phantomresearch Daily" bot VM setup.
#
#   bash scripts/podcast/bot/doctor.sh
#
# Exit code: 0 when every REQUIRED check passes, 1 otherwise.
# The Irodori :8088 check is advisory only: daily.mjs records per-language
# failures, so an unreachable Irodori simply leaves that day's JA without
# audio instead of crashing the run (missing audio is reported and re-tried
# once with the primary engines by daily.sh self-repair — edge-tts is banned
# from this pipeline; see scripts/podcast/bot/daily.sh).
#
# Env knobs:
#   QUIET=1            print failures only (still prints the final line)
#   VOICESTUDIO_HOST   default 127.0.0.1:3901 (local tts-hub)
#   IRODORI_HOST       default 127.0.0.1:8088
#   PODCAST_PREFETCH / PODCAST_SCRIPT_LLM (+ PODCAST_LLM_*)  status lines only

set -euo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# this script lives at <repo>/scripts/podcast/bot/, so the repo root is 3 levels up
REPO_ROOT="$(cd "${BOT_DIR}/../../.." && pwd)"
QUIET="${QUIET:-0}"
VS_HOST="${VOICESTUDIO_HOST:-127.0.0.1:3901}"
IRODORI_HOST="${IRODORI_HOST:-127.0.0.1:8088}"
API_KEY_FILE="${HOME}/.config/podcast-bot/omnivoice-api-key"

pass_count=0
fail_count=0

say() { [ "${QUIET}" = "1" ] || echo "$*"; }

# one required check passed
check_pass() {
  pass_count=$((pass_count + 1))
  say "  [ok]   $1${2:+ -- $2}"
}

# one required check failed
check_fail() {
  fail_count=$((fail_count + 1))
  echo "  [FAIL] $1 (reason: $2)"
  if [ $# -ge 3 ]; then echo "         hint: $3"; fi
}

# advisory notice that never affects the exit code
check_warn() {
  say "  [warn] $1 (reason: $2)"
  if [ $# -ge 3 ] && [ "$3" != "" ]; then say "         hint: $3"; fi
}

# ------------------------------------------------------------- node >= 20 -----
if command -v node >/dev/null 2>&1; then
  if NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)" \
     && [ "${NODE_MAJOR}" -ge 20 ]; then
    check_pass "node >= 20 installed ($(node --version))"
  else
    check_fail "node >= 20 installed" "found v$(node --version)" "run scripts/podcast/bot/setup.sh (NodeSource)"
  fi
else
  check_fail "node >= 20 installed" "node not found on PATH" "run scripts/podcast/bot/setup.sh"
fi

# ------------------------------------------------------------ ffmpeg/ffprobe --
for tool in ffmpeg ffprobe; do
  if command -v "${tool}" >/dev/null 2>&1; then
    check_pass "${tool} available ($(command -v "${tool}"))"
  else
    check_fail "${tool} available" "not found on PATH" "apt install ffmpeg"
  fi
done

# ----------------------------------------------- .venv-edge (removed) ---------
# edge-tts was removed from the pipeline; do not create .venv-edge. If one
# still exists it is leftover cruft — warn instead of fail.
if [ -d "${REPO_ROOT}/.venv-edge" ]; then
  say "  [warn] ${REPO_ROOT}/.venv-edge exists but edge-tts is no longer used; delete it: rm -rf .venv-edge"
fi

# --------------------------------------------------------- VoiceStudio (VS) ---
# OpenAI-compatible service root on :3901 (local tts-hub). Auth model (docs/api-auth.md):
# loopback is never gated, but through the Docker port mapping the peer looks
# non-loopback inside the container, so we fall back to the stored admin API
# key if an unauthenticated request is refused.
# curl always prints a status code via -w (000 when it cannot connect), so the
# only gap is a missing curl binary; normalize that to "000".
vs_curl() {
  printf '%s' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null || true)"
}

vs_code() {
  local path="$1"
  local code
  code="$(vs_curl "http://${VS_HOST}${path}")"
  if [ "${code}" = "" ]; then
    code="000"
  fi
  if [ "${code}" = "401" ] && [ -s "${API_KEY_FILE}" ]; then
    code="$(vs_curl -H "Authorization: Bearer $(cat "${API_KEY_FILE}")" "http://${VS_HOST}${path}")"
    if [ "${code}" = "" ]; then
      code="000"
    fi
  fi
  printf '%s' "${code}"
}

if command -v docker >/dev/null 2>&1; then
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx omnivoice; then
    check_pass "VoiceStudio container 'omnivoice' is running"
  else
    say "  [warn] VoiceStudio container 'omnivoice' not visible via docker (not running or no docker group); checking the HTTP surface directly"
  fi
else
  say "  [info] docker not installed; checking the HTTP surface directly"
fi

speech_code="$(vs_code "/.well-known/voicestudio-speech")"
if [ "${speech_code}" = "200" ]; then
  check_pass "VoiceStudio discovery endpoint (${VS_HOST}/.well-known/voicestudio-speech) answers 200"
else
  check_fail "VoiceStudio ${VS_HOST} reachable" \
    "discovery endpoint answered ${speech_code}" \
    "wait for startup (GET /startup/progress) or inspect: docker logs omnivoice"
fi

if [ "${speech_code}" = "200" ]; then
  voices="$(curl -s --max-time 10 "http://${VS_HOST}/v1/audio/voices" 2>/dev/null || true)"
  if [ -s "${API_KEY_FILE}" ] && [ -z "${voices}" ]; then
    voices="$(curl -s --max-time 10 "http://${VS_HOST}/v1/audio/voices" \
      -H "Authorization: Bearer $(cat "${API_KEY_FILE}")" 2>/dev/null || true)"
  fi
  if [ "${voices}" = "" ]; then
    check_warn "VoiceStudio voices list" \
      "GET /v1/audio/voices returned no body" \
      "the API-key gate may swallow it; verify with: curl \$VS_HOST/v1/audio/voices"
  else
    # A missing profile is REQUIRED-fail: without it that language permanently
    # records "failed" audio every day.
    for want in Phantom-ZH Phantom-DE Phantom-ES Phantom-RU Phantom-IT; do
      if printf '%s' "${voices}" | grep -q "${want}"; then
        check_pass "VoiceStudio voice profile ${want} registered"
      else
        check_fail "VoiceStudio voice profile ${want} registered" \
          "missing from GET /v1/audio/voices" \
          "create the cloned profile in the web UI first (see scripts/podcast/bot/README.md 'VoiceStudio voice profiles')"
      fi
    done
  fi
fi

# ------------------------------------------------------------ Irodori :8088 ---
# Simple TCP connect check (no need to speak OpenAI here). Advisory only:
# daily.mjs's per-language error design tolerates a missing JA engine.
irodori_port="${IRODORI_HOST##*:}"
if (exec 3<>"/dev/tcp/${IRODORI_HOST%:*}/${irodori_port}") 2>/dev/null; then
  check_warn "Irodori-TTS-Server on ${IRODORI_HOST}" "reachable (advisory check only)"
else
  check_warn "Irodori-TTS-Server on ${IRODORI_HOST}" "not reachable" \
    "JA audio simply records as failed for the day (nothing crashes). Start it: systemctl start irodori-tts"
fi

# ------------------------------------------- arXiv prefetch cache (advisory) --
# PODCAST_PREFETCH=1 makes daily.mjs read/refresh a local arXiv cache so a 429
# or offline morning does not shrink the episode. Status only; never fails.
if [ "${PODCAST_PREFETCH:-0}" = "1" ]; then
  cache_status="$(cd "${REPO_ROOT}" && node scripts/podcast/prefetch.mjs --status 2>/dev/null || true)"
  if [ "${cache_status}" = "" ]; then
    check_warn "arXiv prefetch cache" "status unavailable" "node scripts/podcast/prefetch.mjs --days 7"
  else
    cache_topics="$(printf '%s' "${cache_status}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(`${j.topics} topics, ${j.fresh} fresh, newest ${j.newest ?? "none"} (${j.dir})`)})' 2>/dev/null || echo "${cache_status}")"
    say "  [info] arXiv prefetch cache: ${cache_topics}"
  fi
else
  say "  [info] arXiv prefetch disabled (PODCAST_PREFETCH!=1); live arXiv fetch only"
fi

# ------------------------------------------------ local LLM scripts (advisory) --
# PODCAST_SCRIPT_LLM=1: daily.mjs narrates papers with a llama.cpp model and
# falls back to the template script on any problem, so this never fails.
if [ "${PODCAST_SCRIPT_LLM:-0}" = "1" ]; then
  llm_bin="${PODCAST_LLM_SERVER:-${HOME}/opt/llama.cpp/current/llama-server}"
  llm_model="${PODCAST_LLM_MODEL:-${HOME}/opt/llm-models/current.gguf}"
  if [ -n "${PODCAST_LLM_URL:-}" ]; then
    say "  [info] local LLM scripts: external server ${PODCAST_LLM_URL}"
  elif [ ! -x "${llm_bin}" ]; then
    check_warn "local LLM scripts" "llama-server not found: ${llm_bin}" "scripts fall back to the template; see README 'Local AI scripts'"
  elif [ ! -s "${llm_model}" ]; then
    check_warn "local LLM scripts" "model not found: ${llm_model}" "scripts fall back to the template; see README 'Local AI scripts'"
  else
    model_real="$(readlink -f "${llm_model}")"
    model_mb="$(( $(stat -c %s "${model_real}") / 1048576 ))"
    avail_mb="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
    say "  [info] local LLM scripts: $(basename "${model_real}") (${model_mb} MiB), RAM available ${avail_mb} MiB"
    if [ "${avail_mb}" -lt "$(( model_mb + 1024 ))" ]; then
      check_warn "local LLM memory" "MemAvailable ${avail_mb} MiB < model ${model_mb} MiB + 1 GiB" "generation may swap and hit the per-language timeout (template fallback)"
    fi
  fi
else
  say "  [info] local LLM scripts disabled (PODCAST_SCRIPT_LLM!=1); template scripts"
fi

# ---------------------------------------------------------------- summary -----
if [ "${fail_count}" -gt 0 ]; then
  echo "doctor: ${fail_count} required check(s) failed, ${pass_count} passed; see the [FAIL] lines above"
  exit 1
fi
echo "doctor: all checks passed"
