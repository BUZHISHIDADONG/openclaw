#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="${LOG_FILE:-/tmp/openclaw-gateway.log}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
RESTART_DELAY_SECONDS="${RESTART_DELAY_SECONDS:-1}"
STOP_PATTERN="${STOP_PATTERN:-openclaw-gateway|run-node.mjs gateway run --bind loopback --port 18789}"
NO_PROXY_TARGETS="open.feishu.cn,open.larksuite.com,127.0.0.1,localhost"
REQUIRED_NODE_MAJOR="24"

is_wsl() {
  [[ -n "${WSL_DISTRO_NAME-}" || -n "${WSL_INTEROP-}" ]] || grep -qiE "(microsoft|wsl)" /proc/version 2>/dev/null
}

append_csv() {
  local base="${1-}"
  local extra="${2-}"
  if [[ -n "$base" ]]; then
    printf '%s,%s' "$base" "$extra"
  else
    printf '%s' "$extra"
  fi
}

node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'
}

ensure_node24() {
  local major
  major="$(node_major || true)"
  if [[ "$major" == "$REQUIRED_NODE_MAJOR" ]]; then
    return 0
  fi

  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  local nvm_sh="$nvm_dir/nvm.sh"
  if [[ -s "$nvm_sh" ]]; then
    # shellcheck disable=SC1090
    source "$nvm_sh"
    unset npm_config_prefix || true
    nvm use "$REQUIRED_NODE_MAJOR" >/dev/null 2>&1 || true
  fi

  major="$(node_major || true)"
  if [[ "$major" == "$REQUIRED_NODE_MAJOR" ]]; then
    return 0
  fi

  local node24_bin_dir
  node24_bin_dir="$(ls -1d "$HOME"/.nvm/versions/node/v24.*/bin 2>/dev/null | sort -V | tail -n 1 || true)"
  if [[ -n "$node24_bin_dir" ]]; then
    export PATH="$node24_bin_dir:$PATH"
  fi

  major="$(node_major || true)"
  if [[ "$major" != "$REQUIRED_NODE_MAJOR" ]]; then
    echo "ERROR: Node ${REQUIRED_NODE_MAJOR}.x is required, current: $(node -v 2>/dev/null || echo 'not found')." >&2
    echo "Run: source ~/.nvm/nvm.sh && nvm install 24 && nvm use 24" >&2
    exit 1
  fi
}

append_space_flag() {
  local base="${1-}"
  local extra="${2-}"
  if [[ -n "$base" ]]; then
    printf '%s %s' "$base" "$extra"
  else
    printf '%s' "$extra"
  fi
}

run_gateway() {
  local no_proxy_combined
  local no_proxy_lower
  local node_options_combined
  local tsx_loader

  no_proxy_combined="$(append_csv "${NO_PROXY-}" "$NO_PROXY_TARGETS")"
  no_proxy_lower="$(append_csv "${no_proxy-}" "$NO_PROXY_TARGETS")"
  tsx_loader="$ROOT_DIR/node_modules/tsx/dist/loader.mjs"
  node_options_combined="$(append_space_flag "${NODE_OPTIONS-}" "--import $tsx_loader")"

  sleep "$RESTART_DELAY_SECONDS"
  pkill -f "$STOP_PATTERN" || true
  cd "$ROOT_DIR"

  exec env \
    PATH="$PATH" \
    NODE_OPTIONS="$node_options_combined" \
    OPENCLAW_INCLUDE_OPTIONAL_BUNDLED="${OPENCLAW_INCLUDE_OPTIONAL_BUNDLED:-1}" \
    OPENCLAW_BUNDLED_PLUGINS_DIR="${OPENCLAW_BUNDLED_PLUGINS_DIR:-$ROOT_DIR/dist-runtime/extensions}" \
    HTTP_PROXY="${HTTP_PROXY-}" \
    HTTPS_PROXY="${HTTPS_PROXY-}" \
    http_proxy="${http_proxy-}" \
    https_proxy="${https_proxy-}" \
    ALL_PROXY="${ALL_PROXY-}" \
    all_proxy="${all_proxy-}" \
    NO_PROXY="$no_proxy_combined" \
    no_proxy="$no_proxy_lower" \
    pnpm openclaw gateway run --bind loopback --port "$GATEWAY_PORT" --force --allow-unconfigured >> "$LOG_FILE" 2>&1
}

if ! is_wsl; then
  echo "ERROR: This script must run inside WSL." >&2
  exit 1
fi

ensure_node24

if ! command -v pnpm >/dev/null 2>&1; then
  echo "ERROR: pnpm not found in PATH." >&2
  exit 1
fi

if [[ "${1-}" == "--relay" ]]; then
  run_gateway
fi

if [[ "${1-}" == "--check" ]]; then
  echo "OK: WSL + Node $(node -v) + pnpm $(pnpm -v)"
  exit 0
fi

setsid -f env \
  ROOT_DIR="$ROOT_DIR" \
  LOG_FILE="$LOG_FILE" \
  GATEWAY_PORT="$GATEWAY_PORT" \
  STOP_PATTERN="$STOP_PATTERN" \
  RESTART_DELAY_SECONDS="$RESTART_DELAY_SECONDS" \
  PATH="$PATH" \
  OPENCLAW_INCLUDE_OPTIONAL_BUNDLED="${OPENCLAW_INCLUDE_OPTIONAL_BUNDLED:-1}" \
  OPENCLAW_BUNDLED_PLUGINS_DIR="${OPENCLAW_BUNDLED_PLUGINS_DIR:-$ROOT_DIR/dist-runtime/extensions}" \
  HTTP_PROXY="${HTTP_PROXY-}" \
  HTTPS_PROXY="${HTTPS_PROXY-}" \
  http_proxy="${http_proxy-}" \
  https_proxy="${https_proxy-}" \
  ALL_PROXY="${ALL_PROXY-}" \
  all_proxy="${all_proxy-}" \
  NO_PROXY="${NO_PROXY-}" \
  no_proxy="${no_proxy-}" \
  /bin/bash "$0" --relay

echo "gateway hard restart scheduled; node=$(node -v); log: $LOG_FILE"
