#!/usr/bin/env bash
# One-time bootstrap for the "Phantomresearch Daily" podcast pipeline on the
# Grok bot cloud VM (Debian-ish, CPU-only, 16 GB RAM, root available).
#
#   bash scripts/podcast/bot/setup.sh
#
# Idempotent: every step is skipped when it is already done. Each step is
# recorded into ~/.config/podcast-bot/setup.log, with a final health check
# via scripts/podcast/bot/doctor.sh (setup exits with doctor's exit code).
#
# Optional environment variables:
#   IRODORI_SERVER_DIR   directory of the user-provided Irodori-TTS-Server
#                        install; when set, a systemd unit is installed from
#                        the shipped template. Unset => gentle skip message.
#   IRODORI_SERVER_BIN   executable inside IRODORI_SERVER_DIR
#                        (default: run.sh; adjust if yours differs)
#   PODCAST_REPO_URL     clone target when the current directory is NOT a
#                        checkout of this repo yet
#   APT_PROXY            optional http(s) proxy for apt (mirror-restricted
#                        distros may need it)
#
# VoiceStudio deployment follows docs/install/docker.md (verified 2026-10-18):
#   image  ghcr.io/debpalash/voicestudio:stable   (linux/amd64 only! CPU profile)
#   run    docker run -d --name omnivoice -p 127.0.0.1:3900:3900
#                 -e OMNIVOICE_API_KEY=... -v omnivoice-data:/app/omnivoice_data ...
#   volume omnivoice-data:/app/omnivoice_data  (model cache + profiles + settings)
#   env    OMNIVOICE_TTS_BACKEND=omnivoice-gguf
#          OMNIVOICE_ANALYTICS_DISABLED=1
# Engine docs: docs/engines/omnivoice-gguf.md; auth model: docs/api-auth.md.
#
# NOTE: the image ships OMNIVOICE_SERVER_MODE=1. With OMNIVOICE_API_KEY set
# (needed for admin actions such as creating voice profiles from the web UI),
# every NON-loopback request must present a credential. Our TTS adapter talks
# to the container's port mapping from the host, so it arrives as a
# non-loopback peer inside the container; we exempt the Docker bridge subnet
# with OMNIVOICE_TRUSTED_NETWORKS=172.16.0.0/12 so the un-authenticated
# adapter keeps working. Trusted networks never unlock the admin surface.
# The published port stays bound to 127.0.0.1, so nothing is reachable from
# outside the machine.

set -euo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# this script lives at <repo>/scripts/podcast/bot/, so the repo root is 3 levels up
REPO_ROOT="$(cd "${BOT_DIR}/../../.." && pwd)"
if [ ! -f "${REPO_ROOT}/scripts/podcast/daily.mjs" ]; then
  echo "setup.sh: repo root not found above ${BOT_DIR} (expected scripts/podcast/daily.mjs)" >&2
  exit 1
fi

CONFIG_DIR="${HOME}/.config/podcast-bot"
LOG_FILE="${CONFIG_DIR}/setup.log"
API_KEY_FILE="${CONFIG_DIR}/omnivoice-api-key"

VOICESTUDIO_IMAGE="ghcr.io/debpalash/voicestudio:stable"
VOICESTUDIO_CONTAINER="omnivoice"

APT_PROXY_CONF="/etc/apt/apt.conf.d/95podcast-bot-proxy"

mkdir -p "${CONFIG_DIR}"

record() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"${LOG_FILE}"
}

step()   { record "step: $*"; echo "==> $*"; }
warn()   { record "WARN: $*"; echo "warning: $*" >&2; }
notice() { record "note: $*"; echo "-- $*"; }

if [ "$(id -u)" -eq 0 ]; then
  SUDO=()
else
  SUDO=(sudo)
  step "running as non-root; sudo will be used (root is expected on the bot VM)"
fi

# ---------------------------------------------------------------- apt proxy ---
if [ "${APT_PROXY:-}" != "" ] && [ ! -f "${APT_PROXY_CONF}" ]; then
  step "configuring apt proxy (${APT_PROXY})"
  printf 'Acquire::http::Proxy "%s";\nAcquire::https::Proxy "%s";\n' \
    "${APT_PROXY}" "${APT_PROXY}" >"${CONFIG_DIR}/95podcast-bot-proxy.conf"
  "${SUDO[@]}" install -m 644 "${CONFIG_DIR}/95podcast-bot-proxy.conf" "${APT_PROXY_CONF}"
  record "apt proxy written: ${APT_PROXY_CONF}"
fi

# ------------------------------------------------------------- apt packages ---
apt_ensure() {
  local missing=() pkg
  for pkg in "$@"; do
    if ! dpkg -s "${pkg}" >/dev/null 2>&1; then
      missing+=("${pkg}")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    step "installing apt packages: ${missing[*]}"
    "${SUDO[@]}" apt-get update -o Acquire::Retries=5
    DEBIAN_FRONTEND=noninteractive "${SUDO[@]}" apt-get install -y ${APT_EXTRA_FLAGS:-} "${missing[@]}"
    record "installed: ${missing[*]}"
  else
    record "apt packages already present: $*"
  fi
}

step "checking base packages (ffmpeg git curl ca-certificates python3 python3-venv unzip util-linux)"
apt_ensure ffmpeg git curl ca-certificates python3 python3-venv unzip util-linux
record "base packages ok"

# ----------------------------------------------------------------- Node.js ----
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 20 ] 2>/dev/null
}

if node_ok; then
  record "node.js already installed: $(node --version)"
else
  step "installing Node.js 22.x (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | "${SUDO[@]}" bash -
  DEBIAN_FRONTEND=noninteractive "${SUDO[@]}" apt-get install -y nodejs
  node_ok || { warn "node>=20 still not usable after NodeSource install"; }
  record "node.js installed: $(node --version)"
fi

# ------------------------------------------------------------------- repo -----
if [ ! -d "${REPO_ROOT}/.git" ] && [ ! -f "${REPO_ROOT}/scripts/podcast/daily.mjs" ]; then
  if [ "${PODCAST_REPO_URL:-}" != "" ]; then
    step "cloning repo into ${REPO_ROOT}"
    git clone "${PODCAST_REPO_URL}" "${REPO_ROOT}"
    record "cloned ${PODCAST_REPO_URL}"
  else
    warn "no .git and no PODCAST_REPO_URL: assuming the current directory is the repo checkout"
  fi
else
  record "repo already present at ${REPO_ROOT}"
fi

# commit identity for daily.sh pushes
if ! git -C "${REPO_ROOT}" config user.email >/dev/null 2>&1; then
  git -C "${REPO_ROOT}" config user.name "podcast-bot"
  git -C "${REPO_ROOT}" config user.email "podcast-bot@localhost"
  record "repo-local git identity set (podcast-bot)"
fi

# ------------------------------------------------------------- edge-tts venv --
step "preparing .venv-edge (edge-tts 7.3.1 pinned)"
if [ ! -x "${REPO_ROOT}/.venv-edge/bin/python" ]; then
  python3 -m venv "${REPO_ROOT}/.venv-edge"
  record "venv created"
else
  record "venv already present"
fi
EDGE_VERSION="$("${REPO_ROOT}/.venv-edge/bin/pip" show edge-tts 2>/dev/null | awk '/^Version:/{print $2}' || true)"
if [ "${EDGE_VERSION}" != "7.3.1" ]; then
  "${REPO_ROOT}/.venv-edge/bin/pip" install "edge-tts==7.3.1"
  record "edge-tts installed (${EDGE_VERSION:-none} -> 7.3.1)"
else
  record "edge-tts 7.3.1 already installed"
fi

# ----------------------------------------------------- Docker + VoiceStudio ---
docker_shell() {
  "${SUDO[@]}" docker "$@"
}

ensure_voicestudio() {
  if ! command -v docker >/dev/null 2>&1; then
    step "installing Docker (docker.io)"
    if apt_ensure docker.io; then
      "${SUDO[@]}" systemctl enable --now docker >/dev/null 2>&1 || true
      record "docker installed"
    else
      warn "docker.io could not be installed; see the native install docs"
      warn "  (docs/install/linux.md ships a desktop/app path - on a headless CPU VM"
      warn "  Docker is the only route that fits, so fix apt and re-run this script)."
      return 0
    fi
  fi

  # container already running?
  if docker_shell ps --format '{{.Names}}' 2>/dev/null | grep -qx "${VOICESTUDIO_CONTAINER}"; then
    record "VoiceStudio container already running (${VOICESTUDIO_CONTAINER})"
    return 0
  fi
  # container exists, stopped?
  if docker_shell ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "${VOICESTUDIO_CONTAINER}"; then
    step "starting existing container ${VOICESTUDIO_CONTAINER}"
    docker_shell start "${VOICESTUDIO_CONTAINER}"
    record "container started"
    return 0
  fi

  step "deploying VoiceStudio (${VOICESTUDIO_IMAGE}, linux/amd64, port 127.0.0.1:3900)"
  local image
  image="${VOICESTUDIO_IMAGE}"
  if [ "${VOICESTUDIO_IMAGE_MIRROR:-}" != "" ]; then
    image="${VOICESTUDIO_IMAGE_MIRROR}"   # e.g. palashdeb/omnivoice-studio:stable
  fi
  if ! docker_shell pull --platform linux/amd64 "${image}" 2>&1 | tail -3; then
    warn "docker pull failed; create the container manually per docs/install/docker.md"
    return 0
  fi

  # admin key for the web UI (profile creation). Storage: local file, never in the repo.
  mkdir -p "${CONFIG_DIR}"
  if [ ! -s "${API_KEY_FILE}" ]; then
    python3 -c 'import secrets; print(secrets.token_urlsafe(32))' >"${API_KEY_FILE}"
    chmod 600 "${API_KEY_FILE}"
    record "generated OMNIVOICE_API_KEY -> ${API_KEY_FILE}"
  else
    record "API key already present -> ${API_KEY_FILE}"
  fi
  local key
  key="$(cat "${API_KEY_FILE}")"

  if ! docker_shell run -d --name "${VOICESTUDIO_CONTAINER}" --platform linux/amd64 \
      --restart unless-stopped \
      -p 127.0.0.1:3900:3900 \
      -e OMNIVOICE_API_KEY="${key}" \
      -e OMNIVOICE_TRUSTED_NETWORKS=172.16.0.0/12 \
      -e OMNIVOICE_TTS_BACKEND=omnivoice-gguf \
      -e OMNIVOICE_ANALYTICS_DISABLED=1 \
      -v omnivoice-data:/app/omnivoice_data \
      "${image}" 2>&1 | tail -3; then
    warn "docker run failed; see docs/install/docker.md, then re-run this script"
    return 0
  fi
  record "container ${VOICESTUDIO_CONTAINER} started"
}

ensure_voicestudio || true

# ------------------------------------------- OmniVoice GGUF weights pre-warm --
# Best effort, never fatal: the engine downloads its quant weights on first use
# (Serveurperso/OmniVoice-GGUF, pinned revision; CPU-only -> Q4_K_M, ~0.7 GB).
# Pre-warm here so the first daily episode is not a ~700 MB download. We do a
# tiny POST; if it times out the download is simply left to the container.
prewarm_weights() {
  if ! command -v docker >/dev/null 2>&1; then return 0; fi
  if ! docker_shell ps --format '{{.Names}}' 2>/dev/null | grep -qx "${VOICESTUDIO_CONTAINER}"; then
    return 0
  fi
  step "attempting OmniVoice GGUF weights pre-download (best effort, may take minutes)"
  local key="" auth=() code
  if [ -s "${API_KEY_FILE}" ]; then
    key="$(cat "${API_KEY_FILE}")"
    auth=(-H "Authorization: Bearer ${key}")
  fi
  # curl -w prints a status itself (000 when it cannot connect); only a missing
  # curl binary would leave the variable empty.
  code="$(curl -s -o /dev/null -w '%{http_code}' \
    ${auth[@]+"${auth[@]}"} \
    --max-time 420 \
    -H 'Content-Type: application/json' \
    -X POST http://127.0.0.1:3900/v1/audio/speech \
    -d '{"model":"omnivoice-gguf","input":"practice","voice":"alloy","response_format":"pcm"}' 2>/dev/null || true)"
  if [ "${code}" = "" ]; then
    code="000"
  fi
  if [ "${code}" = "200" ]; then
    record "weights are ready (speech endpoint answered 200)"
  else
    warn "weights pre-download did not finish here (HTTP ${code});"
    warn "  the first real generation will download them in the background."
    warn "  Watch with: ${SUDO[*]} docker logs -f ${VOICESTUDIO_CONTAINER}"
  fi
}

prewarm_weights || true

# --------------------------------------------------------------- Irodori ------
# Irodori-TTS-Server is a user-provided binary (OpenAI-compatible, must listen
# on 127.0.0.1:8088 /v1/audio/speech, caption voice "kanade"). We only wire the
# systemd unit when IRODORI_SERVER_DIR is provided; otherwise we print the
# template and a gentle message. A missing Irodori is acceptable: the pipeline
# records per-language failures, so JA simply skips audio on that day (see
# scripts/podcast/daily.mjs) - nothing crashes.
print_unit_template() {
  cat <<UNIT
[Unit]
Description=Irodori-TTS-Server (Phantomresearch Daily JA TTS)
After=network.target

[Service]
Type=simple
WorkingDirectory=__IRODORI_SERVER_DIR__
ExecStart=__IRODORI_SERVER_DIR__/__IRODORI_SERVER_BIN__
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
}

if [ "${IRODORI_SERVER_DIR:-}" != "" ] && [ -d "${IRODORI_SERVER_DIR}" ]; then
  BIN="${IRODORI_SERVER_BIN:-run.sh}"
  step "installing irodori-tts.service (dir=${IRODORI_SERVER_DIR}, bin=${BIN})"
  print_unit_template \
    | sed "s#__IRODORI_SERVER_DIR__#${IRODORI_SERVER_DIR}#g; s#__IRODORI_SERVER_BIN__#${BIN}#g" \
    | tee "${CONFIG_DIR}/irodori-tts.service" >/dev/null
  "${SUDO[@]}" install -m 644 "${CONFIG_DIR}/irodori-tts.service" /etc/systemd/system/irodori-tts.service
  "${SUDO[@]}" systemctl daemon-reload
  "${SUDO[@]}" systemctl enable --now irodori-tts.service >/dev/null 2>&1 \
    && record "irodori-tts.service enabled and started" \
    || warn "irodori-tts.service could not start (binary/config trouble) - check journalctl -u irodori-tts"
else
  notice "IRODORI_SERVER_DIR not set (or directory missing): skipping the Irodori unit."
  notice "This is fine for now: JA audio is allowed to fail per-day; set the env var"
  notice "and re-run later. The unit template:"
  print_unit_template | sed 's/^/    /'
fi

# --------------------------------------------------------------- doctor -------
step "final health check"
bash "${BOT_DIR}/doctor.sh"
