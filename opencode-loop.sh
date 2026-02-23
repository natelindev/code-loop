#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEFAULT_CONFIG="$HOME/.opencode-loop.conf"
CONFIG_FILE="$DEFAULT_CONFIG"

DEFAULT_MODEL_PLAN="github-copilot/claude-opus-4.6"
DEFAULT_MODEL_IMPLEMENT="github-copilot/claude-sonnet-4.6"
DEFAULT_MODEL_REVIEW="github-copilot/gpt-5.2-codex"
DEFAULT_MODEL_FIX="github-copilot/claude-sonnet-4.6"
DEFAULT_MODEL_COMMIT="github-copilot/gemini-3-flash-preview"
DEFAULT_MODEL_PR="github-copilot/gemini-3-flash-preview"
DEFAULT_MODEL_BRANCH="github-copilot/gemini-3-flash-preview"

SUPPORTED_MODELS=()

# Hard-coded paid-plan multipliers (synced from scripts/cost)
COST_MODELS=(
  "Claude Haiku 4.5"
  "Claude Opus 4.5"
  "Claude Opus 4.6"
  "Claude Opus 4.6 (fast mode) (preview)"
  "Claude Sonnet 4"
  "Claude Sonnet 4.5"
  "Claude Sonnet 4.6"
  "Gemini 2.5 Pro"
  "Gemini 3 Flash"
  "Gemini 3 Pro"
  "Gemini 3.1 Pro"
  "GPT-4.1"
  "GPT-4o"
  "GPT-5 mini"
  "GPT-5.1"
  "GPT-5.1-Codex"
  "GPT-5.1-Codex-Mini"
  "GPT-5.1-Codex-Max"
  "GPT-5.2"
  "GPT-5.2-Codex"
  "GPT-5.3-Codex"
  "Grok Code Fast 1"
  "Raptor mini"
)
COST_PAID_MULTIPLIERS=(
  "0.33"
  "3"
  "3"
  "30"
  "1"
  "1"
  "1"
  "1"
  "0.33"
  "1"
  "1"
  "0"
  "0"
  "0"
  "1"
  "1"
  "0.33"
  "1"
  "1"
  "1"
  "1"
  "0.25"
  "0"
)

RUN_MODE="bg"
DO_INIT=0
DO_DRY_RUN=0
SKIP_PLAN=0
LOG_OPENCODE_DETAIL=0
PLAN_TEXT=""
PLAN_FILE_PATH=""
PLAN_RUNTIME_DIR="${OPENCODE_LOOP_PLAN_DIR:-$HOME/.opencode-loop/plans}"
PLAN_FILE_USED=""
REPO_DIR=""
USER_PROMPT=""
AUTO_APPROVE_EXTERNAL_DIRECTORY="false"
OPENCODE_RUNTIME_CONFIG_HOME=""

REPO_ROOT=""
REPO=""
REPO_URL=""
ORIGIN_REPO=""
ORIGIN_OWNER=""
PUSH_TARGET=""
PUSH_BRANCH_OWNER=""
MAIN_BRANCH=""
BRANCH_NAME=""
TARGET_DIR=""
LOG_FILE=""
PR_URL=""

strip_ansi() {
  sed 's/\x1b\[[0-9;]*m//g'
}

trim() {
  sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//'
}

log() {
  local step="$1"
  shift
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$ts] [$step] $*"
}

usage() {
  cat <<'EOF'
Usage:
  opencode-loop.sh [OPTIONS] "your prompt here"

Options:
  --init              Create default config file
  --fg                Run in foreground
  --bg                Run in background (default)
  --config <path>     Use custom config file
  --dry-run           Validate config + dependencies + repo context only
  --skip-plan         Skip the planning phase (provide plan via --plan-file or in prompt)
  --plan-file <path>  Path to a file containing a pre-written plan
  --repo-dir <path>   Run against a specific repo directory
  --log-opencode      Log detailed output from opencode run calls
  -h, --help          Show this help

Environment variable overrides (take precedence over config file):
  OPENCODE_LOOP_WORKSPACE_ROOT, OPENCODE_LOOP_MODEL_PLAN,
  OPENCODE_LOOP_MODEL_IMPLEMENT, OPENCODE_LOOP_MODEL_REVIEW,
  OPENCODE_LOOP_MODEL_FIX, OPENCODE_LOOP_MODEL_COMMIT,
  OPENCODE_LOOP_MODEL_PR, OPENCODE_LOOP_MODEL_BRANCH,
  OPENCODE_LOOP_MAX_RETRIES, OPENCODE_LOOP_NOTIFICATION_SOUND,
  OPENCODE_LOOP_AUTO_APPROVE_EXTERNAL_DIRECTORY
EOF
}

init_config() {
  local target_config="$1"
  if [ -f "$target_config" ]; then
    echo "Config already exists: $target_config"
    echo "Edit it directly if you want to change values."
    return 0
  fi

  cat > "$target_config" <<'EOF'
#!/usr/bin/env bash

WORKSPACE_ROOT="$HOME/opencode-workspaces"

MODEL_PLAN="$DEFAULT_MODEL_PLAN"
MODEL_IMPLEMENT="$DEFAULT_MODEL_IMPLEMENT"
MODEL_REVIEW="$DEFAULT_MODEL_REVIEW"
MODEL_FIX="$DEFAULT_MODEL_FIX"
MODEL_COMMIT="$DEFAULT_MODEL_COMMIT"
MODEL_PR="$DEFAULT_MODEL_PR"
MODEL_BRANCH="$DEFAULT_MODEL_BRANCH"

if ! declare -p POST_CLONE_COMMANDS >/dev/null 2>&1; then
  POST_CLONE_COMMANDS=("pnpm i")
fi

MAX_RETRIES=3
if ! declare -p RETRY_DELAYS >/dev/null 2>&1; then
  RETRY_DELAYS=(10 30 60)
fi

NOTIFICATION_SOUND=true
AUTO_APPROVE_EXTERNAL_DIRECTORY=false
EOF

  chmod 600 "$target_config" || true
  echo "Created config: $target_config"
  echo "-----"
  cat "$target_config"
  echo "-----"
}

load_config() {
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: Config not found at $CONFIG_FILE"
    echo "Run: $0 --init"
    exit 1
  fi

  # Ensure values from config file take precedence over pre-exported shell env vars.
  unset WORKSPACE_ROOT MODEL_PLAN MODEL_IMPLEMENT MODEL_REVIEW MODEL_FIX MODEL_COMMIT MODEL_PR MODEL_BRANCH MAX_RETRIES NOTIFICATION_SOUND AUTO_APPROVE_EXTERNAL_DIRECTORY
  unset POST_CLONE_COMMANDS RETRY_DELAYS

  # shellcheck disable=SC1090
  source "$CONFIG_FILE"

  WORKSPACE_ROOT="${WORKSPACE_ROOT:-$HOME/opencode-workspaces}"
  MODEL_PLAN="${MODEL_PLAN:-$DEFAULT_MODEL_PLAN}"
  MODEL_IMPLEMENT="${MODEL_IMPLEMENT:-$DEFAULT_MODEL_IMPLEMENT}"
  MODEL_REVIEW="${MODEL_REVIEW:-$DEFAULT_MODEL_REVIEW}"
  MODEL_FIX="${MODEL_FIX:-$DEFAULT_MODEL_FIX}"
  MODEL_COMMIT="${MODEL_COMMIT:-$DEFAULT_MODEL_COMMIT}"
  MODEL_PR="${MODEL_PR:-$DEFAULT_MODEL_PR}"
  MODEL_BRANCH="${MODEL_BRANCH:-$DEFAULT_MODEL_BRANCH}"
  MAX_RETRIES="${MAX_RETRIES:-3}"
  NOTIFICATION_SOUND="${NOTIFICATION_SOUND:-true}"
  AUTO_APPROVE_EXTERNAL_DIRECTORY="${AUTO_APPROVE_EXTERNAL_DIRECTORY:-false}"

  if ! [[ "$MAX_RETRIES" =~ ^[0-9]+$ ]]; then
    MAX_RETRIES=3
  fi
  if [ "$MAX_RETRIES" -gt 3 ]; then
    MAX_RETRIES=3
  fi
  if [ "$MAX_RETRIES" -lt 1 ]; then
    MAX_RETRIES=1
  fi

  if ! declare -p POST_CLONE_COMMANDS >/dev/null 2>&1; then
    POST_CLONE_COMMANDS=("pnpm i")
  fi

  if ! declare -p RETRY_DELAYS >/dev/null 2>&1; then
    RETRY_DELAYS=(10 30 60)
  fi

  # Environment variable overrides (for Electron app integration)
  [ -n "${OPENCODE_LOOP_WORKSPACE_ROOT:-}" ] && WORKSPACE_ROOT="$OPENCODE_LOOP_WORKSPACE_ROOT"
  [ -n "${OPENCODE_LOOP_MODEL_PLAN:-}" ] && MODEL_PLAN="$OPENCODE_LOOP_MODEL_PLAN"
  [ -n "${OPENCODE_LOOP_MODEL_IMPLEMENT:-}" ] && MODEL_IMPLEMENT="$OPENCODE_LOOP_MODEL_IMPLEMENT"
  [ -n "${OPENCODE_LOOP_MODEL_REVIEW:-}" ] && MODEL_REVIEW="$OPENCODE_LOOP_MODEL_REVIEW"
  [ -n "${OPENCODE_LOOP_MODEL_FIX:-}" ] && MODEL_FIX="$OPENCODE_LOOP_MODEL_FIX"
  [ -n "${OPENCODE_LOOP_MODEL_COMMIT:-}" ] && MODEL_COMMIT="$OPENCODE_LOOP_MODEL_COMMIT"
  [ -n "${OPENCODE_LOOP_MODEL_PR:-}" ] && MODEL_PR="$OPENCODE_LOOP_MODEL_PR"
  [ -n "${OPENCODE_LOOP_MODEL_BRANCH:-}" ] && MODEL_BRANCH="$OPENCODE_LOOP_MODEL_BRANCH"
  [ -n "${OPENCODE_LOOP_MAX_RETRIES:-}" ] && MAX_RETRIES="$OPENCODE_LOOP_MAX_RETRIES"
  [ -n "${OPENCODE_LOOP_NOTIFICATION_SOUND:-}" ] && NOTIFICATION_SOUND="$OPENCODE_LOOP_NOTIFICATION_SOUND"
  [ -n "${OPENCODE_LOOP_AUTO_APPROVE_EXTERNAL_DIRECTORY:-}" ] && AUTO_APPROVE_EXTERNAL_DIRECTORY="$OPENCODE_LOOP_AUTO_APPROVE_EXTERNAL_DIRECTORY"
  [ -n "${OPENCODE_LOOP_LOG_OPENCODE_DETAIL:-}" ] && LOG_OPENCODE_DETAIL="$OPENCODE_LOOP_LOG_OPENCODE_DETAIL"

  case "$(printf '%s' "${LOG_OPENCODE_DETAIL:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on)
      LOG_OPENCODE_DETAIL=1
      ;;
    *)
      LOG_OPENCODE_DETAIL=0
      ;;
  esac

  case "$(printf '%s' "${AUTO_APPROVE_EXTERNAL_DIRECTORY:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on)
      AUTO_APPROVE_EXTERNAL_DIRECTORY="true"
      ;;
    *)
      AUTO_APPROVE_EXTERNAL_DIRECTORY="false"
      ;;
  esac
}

refresh_supported_models() {
  local models_raw
  local line
  models_raw=$(retry_with_backoff opencode models github-copilot 2>/dev/null || true)

  if [ -z "$(echo "$models_raw" | grep '^github-copilot/' || true)" ]; then
    echo "Error: Could not determine supported models from OpenCode CLI."
    echo "Run manually: opencode models github-copilot"
    exit 1
  fi

  SUPPORTED_MODELS=()
  while IFS= read -r line; do
    [ -n "$line" ] && SUPPORTED_MODELS+=("$line")
  done < <(echo "$models_raw" | grep '^github-copilot/' | sort -u)
}

model_is_supported() {
  local model="$1"
  local supported

  for supported in "${SUPPORTED_MODELS[@]}"; do
    if [ "$supported" = "$model" ]; then
      return 0
    fi
  done

  return 1
}

pick_supported_fallback() {
  local preferred="$1"

  if model_is_supported "$preferred"; then
    echo "$preferred"
    return 0
  fi

  if [ "${#SUPPORTED_MODELS[@]}" -gt 0 ]; then
    echo "${SUPPORTED_MODELS[0]}"
    return 0
  fi

  return 1
}

ensure_supported_model() {
  local var_name="$1"
  local current_value="$2"
  local preferred_default="$3"

  if model_is_supported "$current_value"; then
    return 0
  fi

  local fallback
  fallback=$(pick_supported_fallback "$preferred_default") || {
    echo "Error: No supported OpenCode models are available."
    exit 1
  }

  echo "Warning: $var_name model '$current_value' is not supported by OpenCode; using '$fallback' instead."
  printf -v "$var_name" '%s' "$fallback"
}

validate_configured_models() {
  ensure_supported_model MODEL_PLAN "$MODEL_PLAN" "$DEFAULT_MODEL_PLAN"
  ensure_supported_model MODEL_IMPLEMENT "$MODEL_IMPLEMENT" "$DEFAULT_MODEL_IMPLEMENT"
  ensure_supported_model MODEL_REVIEW "$MODEL_REVIEW" "$DEFAULT_MODEL_REVIEW"
  ensure_supported_model MODEL_FIX "$MODEL_FIX" "$DEFAULT_MODEL_FIX"
  ensure_supported_model MODEL_COMMIT "$MODEL_COMMIT" "$DEFAULT_MODEL_COMMIT"
  ensure_supported_model MODEL_PR "$MODEL_PR" "$DEFAULT_MODEL_PR"
  ensure_supported_model MODEL_BRANCH "$MODEL_BRANCH" "$DEFAULT_MODEL_BRANCH"
}

preflight_checks() {
  for cmd in git gh opencode jq nohup; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "Error: $cmd is not installed."
      exit 1
    fi
  done

  local gh_auth_output=""
  local gh_auth_status=0
  gh_auth_output=$(retry_with_backoff gh auth status 2>&1) || gh_auth_status=$?

  if [ "$gh_auth_status" -ne 0 ] && ! echo "$gh_auth_output" | grep -Eiq 'Active account:[[:space:]]*true'; then
    echo "Error: gh is not authenticated for GitHub API access."
    if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ]; then
      echo "Detected GH_TOKEN/GITHUB_TOKEN in environment, but gh auth still failed."
    else
      echo "No GH_TOKEN/GITHUB_TOKEN detected in environment."
    fi
    echo "Run: gh auth login"
    echo "Or set a token: export GH_TOKEN=<your_token>"
    echo "$gh_auth_output"
    exit 1
  fi

  if [ "$gh_auth_status" -ne 0 ]; then
    log "PRECHECK" "gh auth status returned non-zero, but active account is present; continuing."
  fi

  refresh_supported_models
  validate_configured_models

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Error: Not a git repository."
    exit 1
  fi

  REPO_URL=$(git config --get remote.origin.url || true)
  if [ -z "$REPO_URL" ]; then
    echo "Error: No remote origin configured for this repository."
    exit 1
  fi
}

is_network_error() {
  local output="$1"
  echo "$output" | grep -Eiq 'network|timeout|timed out|connection|connect:|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|temporary failure|name resolution|could not resolve host|no route to host|tls|ssl|x509|handshake|dial tcp|i/o timeout|unexpected eof|service unavailable|bad gateway|gateway timeout|http[[:space:]]*5[0-9][0-9]|http[[:space:]]*429|rate limit|secondary rate limit'
}

retry_with_backoff() {
  local attempt=1
  local output
  local status
  local is_opencode_run=0
  local streamed_output=0

  if [ "${1:-}" = "opencode" ] && [ "${2:-}" = "run" ]; then
    is_opencode_run=1
  fi

  while [ "$attempt" -le "$MAX_RETRIES" ]; do
    status=0

    if [ "$LOG_OPENCODE_DETAIL" -eq 1 ] && [ "$is_opencode_run" -eq 1 ]; then
      local stream_file
      stream_file=$(mktemp)

      # Stream opencode output live to stderr (so callers using command substitution still show logs)
      # while also capturing full output for downstream parsing.
      "$@" > >(tee "$stream_file" >&2) 2> >(tee -a "$stream_file" >&2) || status=$?
      output=$(cat "$stream_file")
      rm -f "$stream_file"
      streamed_output=1
    else
      output=$("$@" 2>&1) || status=$?
      streamed_output=0
    fi

    if [ "$status" -eq 0 ]; then
      echo "$output"
      return 0
    fi

    if [ "$streamed_output" -ne 1 ]; then
      echo "$output" >&2
    fi

    if ! is_network_error "$output"; then
      return "$status"
    fi

    if [ "$attempt" -ge "$MAX_RETRIES" ]; then
      return "$status"
    fi

    local delay_idx=$((attempt - 1))
    local delay="${RETRY_DELAYS[$delay_idx]:-${RETRY_DELAYS[-1]}}"
    log "RETRY" "Network error detected. attempt=$attempt/$MAX_RETRIES, sleeping ${delay}s"
    sleep "$delay"
    attempt=$((attempt + 1))
    status=0
  done

  return 1
}

cleanup_text_output() {
  echo "$1" | strip_ansi | grep -v '^>' | sed '/^$/d' | trim
}

parse_repo_from_url() {
  local url="$1"
  local repo=""

  case "$url" in
    git@github.com:*)
      repo="${url#git@github.com:}"
      ;;
    https://github.com/*)
      repo="${url#https://github.com/}"
      ;;
    ssh://git@github.com/*)
      repo="${url#ssh://git@github.com/}"
      ;;
    *)
      repo=""
      ;;
  esac

  repo="${repo%.git}"

  if echo "$repo" | grep -Eq '^[^/]+/[^/]+$'; then
    echo "$repo"
  else
    echo ""
  fi
}

resolve_repo_and_push_target() {
  REPO=""
  PUSH_TARGET=""
  PUSH_BRANCH_OWNER=""

  local remote_names=""
  if git remote get-url origin >/dev/null 2>&1; then
    remote_names="origin"
  fi

  local remote_name remote_url repo_candidate
  for remote_name in $(git remote); do
    [ "$remote_name" = "origin" ] && continue
    if [ -n "$remote_names" ]; then
      remote_names="$remote_names $remote_name"
    else
      remote_names="$remote_name"
    fi
  done

  for remote_name in $remote_names; do
    remote_url=$(git remote get-url "$remote_name" 2>/dev/null || true)
    repo_candidate=$(parse_repo_from_url "$remote_url")
    if [ -n "$repo_candidate" ]; then
      REPO="$repo_candidate"
      PUSH_TARGET="$remote_name"
      PUSH_BRANCH_OWNER="${repo_candidate%%/*}"
      break
    fi
  done

  if [ -z "$REPO" ] && git remote get-url origin >/dev/null 2>&1; then
    local origin_url origin_path upstream_remote upstream_url
    origin_url=$(git remote get-url origin 2>/dev/null || true)
    origin_path="$origin_url"
    [[ "$origin_path" =~ ^file:// ]] && origin_path="${origin_path#file://}"

    if [ -d "$origin_path/.git" ] || [ -f "$origin_path/HEAD" ]; then
      for upstream_remote in $(git -C "$origin_path" remote); do
        upstream_url=$(git -C "$origin_path" remote get-url "$upstream_remote" 2>/dev/null || true)
        repo_candidate=$(parse_repo_from_url "$upstream_url")
        if [ -n "$repo_candidate" ]; then
          REPO="$repo_candidate"
          PUSH_TARGET="$upstream_url"
          PUSH_BRANCH_OWNER="${repo_candidate%%/*}"
          break
        fi
      done
    fi
  fi

  if [ -z "$REPO" ]; then
    REPO=$(retry_with_backoff gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
    REPO=$(echo "$REPO" | tail -n 1 | trim)
    if [ -n "$REPO" ]; then
      PUSH_BRANCH_OWNER="${REPO%%/*}"
    fi
  fi

  if [ -z "$PUSH_TARGET" ]; then
    PUSH_TARGET="origin"
  fi
}

wait_for_remote_branch() {
  local branch="$1"
  local max_attempts=6
  local attempt=1

  while [ "$attempt" -le "$max_attempts" ]; do
    if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
      return 0
    fi

    if [ "$attempt" -lt "$max_attempts" ]; then
      log "PUSH" "Remote branch '$branch' not visible yet (attempt $attempt/$max_attempts); retrying in 2s"
      sleep 2
    fi

    attempt=$((attempt + 1))
  done

  return 1
}

branch_has_commits_ahead() {
  local base_ref="$1"
  local head_ref="$2"

  local ahead_count
  ahead_count=$(git rev-list --count "$base_ref..$head_ref" 2>/dev/null || echo "0")
  [ "$ahead_count" -gt 0 ]
}

detect_repo_context() {
  REPO_ROOT=$(git rev-parse --show-toplevel)
  REPO=$(retry_with_backoff gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
  REPO=$(echo "$REPO" | tail -n 1 | trim)

  ORIGIN_REPO=$(parse_repo_from_url "$REPO_URL")
  if [ -n "$ORIGIN_REPO" ]; then
    ORIGIN_OWNER="${ORIGIN_REPO%%/*}"
  fi

  MAIN_BRANCH=$(retry_with_backoff gh repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || true)
  MAIN_BRANCH=$(echo "$MAIN_BRANCH" | tail -n 1 | trim)
  if [ -z "$MAIN_BRANCH" ]; then
    MAIN_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || true)
  fi

  if [ -z "$MAIN_BRANCH" ]; then
    MAIN_BRANCH="main"
    git show-ref --verify --quiet refs/heads/main || MAIN_BRANCH="master"
  fi

  if [ -z "$REPO" ] && [ -n "$ORIGIN_REPO" ]; then
    REPO="$ORIGIN_REPO"
  fi

  if [ -z "$REPO" ]; then
    echo "Error: Could not detect current GitHub repository."
    exit 1
  fi
}

generate_branch_name() {
  local branch_prompt
  branch_prompt="Generate a short kebab-case slug with exactly 2-3 concise words (no dates, no prefixes, no extra text) summarizing this task: $USER_PROMPT"

  local raw
  raw=$(retry_with_backoff opencode run -m "$MODEL_BRANCH" -- "$branch_prompt" || true)
  local cleaned
  cleaned=$(cleanup_text_output "$raw" | head -n 1 | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | sed 's/--*/-/g' | sed 's/^-*//' | sed 's/-*$//')

  local compact=""
  local token count
  count=0
  IFS='-' read -r -a _branch_tokens <<< "$cleaned"
  for token in "${_branch_tokens[@]}"; do
    [ -z "$token" ] && continue
    if [[ "$token" =~ ^[0-9]+$ ]]; then
      continue
    fi
    case "$token" in
      the|a|an|and|or|for|from|with|that|this|into|after|before|when|while|opencode|detailed|output|run)
        continue
        ;;
    esac
    token="${token:0:10}"
    compact="${compact:+$compact-}$token"
    count=$((count + 1))
    if [ "$count" -ge 3 ]; then
      break
    fi
  done

  cleaned=$(echo "$compact" | cut -c1-28 | sed 's/-*$//')

  if [ -z "$cleaned" ]; then
    cleaned="task-$RANDOM"
  fi

  BRANCH_NAME="opencode/$cleaned"
}

setup_target_paths() {
  local branch_slug
  branch_slug=$(echo "$BRANCH_NAME" | sed 's#/#-#g')
  TARGET_DIR="$WORKSPACE_ROOT/$branch_slug"
  LOG_FILE="$TARGET_DIR/opencode-loop.log"
}

setup_logging() {
  mkdir -p "$TARGET_DIR"
  touch "$LOG_FILE"
  exec > >(tee -a "$LOG_FILE") 2>&1
}

notify_success() {
  local url="$1"
  osascript -e "display notification \"PR ready: $url\" with title \"OpenCode Loop\"" >/dev/null 2>&1 || true
  if [[ "$NOTIFICATION_SOUND" == "true" ]]; then
    afplay /System/Library/Sounds/Glass.aiff >/dev/null 2>&1 || true
  fi
}

notify_error() {
  local msg="$1"
  osascript -e "display notification \"$msg\" with title \"OpenCode Loop\"" >/dev/null 2>&1 || true
  if [[ "$NOTIFICATION_SOUND" == "true" ]]; then
    afplay /System/Library/Sounds/Glass.aiff >/dev/null 2>&1 || true
  fi
}

normalize_model_for_cost_file() {
  local raw_model="$1"
  local lowered
  lowered=$(echo "$raw_model" | tr '[:upper:]' '[:lower:]')

  case "$lowered" in
    *claude-opus-4.6*fast*|*claude-opus-4-6*fast*|*claude-opus-4.6*preview*|*claude-opus-4-6*preview*)
      echo "Claude Opus 4.6 (fast mode) (preview)"
      ;;
    *claude-opus-4.6*|*claude-opus-4-6*)
      echo "Claude Opus 4.6"
      ;;
    *claude-opus-4.5*|*claude-opus-4-5*)
      echo "Claude Opus 4.5"
      ;;
    *claude-sonnet-4.6*|*claude-sonnet-4-6*)
      echo "Claude Sonnet 4.6"
      ;;
    *claude-sonnet-4.5*|*claude-sonnet-4-5*)
      echo "Claude Sonnet 4.5"
      ;;
    *claude-sonnet-4*)
      echo "Claude Sonnet 4"
      ;;
    *gemini-3-flash*)
      echo "Gemini 3 Flash"
      ;;
    *gemini-3-1-pro*)
      echo "Gemini 3.1 Pro"
      ;;
    *gemini-3-pro*)
      echo "Gemini 3 Pro"
      ;;
    *gemini-2-5-pro*)
      echo "Gemini 2.5 Pro"
      ;;
    *gpt-5.3-codex*)
      echo "GPT-5.3-Codex"
      ;;
    *gpt-5.2-codex*)
      echo "GPT-5.2-Codex"
      ;;
    *gpt-5.1-codex-mini*)
      echo "GPT-5.1-Codex-Mini"
      ;;
    *gpt-5.1-codex-max*)
      echo "GPT-5.1-Codex-Max"
      ;;
    *gpt-5.1-codex*)
      echo "GPT-5.1-Codex"
      ;;
    *gpt-5-mini*)
      echo "GPT-5 mini"
      ;;
    *gpt-5.2*)
      echo "GPT-5.2"
      ;;
    *gpt-5.1*)
      echo "GPT-5.1"
      ;;
    *gpt-4.1*)
      echo "GPT-4.1"
      ;;
    *gpt-4o*)
      echo "GPT-4o"
      ;;
    *)
      echo ""
      ;;
  esac
}

get_paid_multiplier() {
  local model_label="$1"
  local i

  for i in "${!COST_MODELS[@]}"; do
    if [ "${COST_MODELS[$i]}" = "$model_label" ]; then
      echo "${COST_PAID_MULTIPLIERS[$i]}"
      return 0
    fi
  done

  echo ""
}

report_model_costs() {
  local did_run_fix="$1"
  local total="0"
  local unresolved=0

  log "COST" "Paid plan model multipliers from hard-coded table"

  local phases=("PLAN" "IMPLEMENT" "REVIEW" "FIX" "COMMIT" "PR" "BRANCH")
  local models=("$MODEL_PLAN" "$MODEL_IMPLEMENT" "$MODEL_REVIEW" "$MODEL_FIX" "$MODEL_COMMIT" "$MODEL_PR" "$MODEL_BRANCH")
  local i

  for i in "${!phases[@]}"; do
    local phase="${phases[$i]}"
    local model="${models[$i]}"

    if [ "$phase" = "FIX" ] && [ "$did_run_fix" -ne 1 ]; then
      log "COST" "$phase model=$model multiplier=0 (phase skipped)"
      continue
    fi

    local normalized multiplier
    normalized=$(normalize_model_for_cost_file "$model")

    if [ -z "$normalized" ]; then
      log "COST" "$phase model=$model multiplier=unknown (no mapping in script)"
      unresolved=1
      continue
    fi

    multiplier=$(get_paid_multiplier "$normalized")

    if [ -z "$multiplier" ]; then
      log "COST" "$phase model=$model mapped=$normalized multiplier=unknown (not found in cost file)"
      unresolved=1
      continue
    fi

    log "COST" "$phase model=$model mapped=$normalized multiplier=$multiplier"

    if [[ "$multiplier" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
      total=$(awk -v a="$total" -v b="$multiplier" 'BEGIN {printf "%.2f", a + b}')
    else
      unresolved=1
    fi
  done

  if [ "$unresolved" -eq 1 ]; then
    log "COST" "Estimated total multiplier (known entries only) = $total"
  else
    log "COST" "Estimated total multiplier = $total"
  fi
}

cleanup_workspace_on_success() {
  if [ -n "$TARGET_DIR" ] && [ -d "$TARGET_DIR" ]; then
    log "CLEANUP" "Removing local workspace: $TARGET_DIR"
    rm -rf "$TARGET_DIR"
  fi
}

ensure_plan_runtime_dir() {
  mkdir -p "$PLAN_RUNTIME_DIR"
  if [ ! -f "$PLAN_RUNTIME_DIR/.gitignore" ]; then
    printf '*\n!.gitignore\n' > "$PLAN_RUNTIME_DIR/.gitignore"
  fi
}

cleanup_plan_file() {
  if [ -n "$PLAN_FILE_USED" ] && [ -f "$PLAN_FILE_USED" ]; then
    log "CLEANUP" "Removing runtime plan file: $PLAN_FILE_USED"
    rm -f "$PLAN_FILE_USED"
  fi
}

cleanup_opencode_runtime_config() {
  if [ -n "$OPENCODE_RUNTIME_CONFIG_HOME" ] && [ -d "$OPENCODE_RUNTIME_CONFIG_HOME" ]; then
    rm -rf "$OPENCODE_RUNTIME_CONFIG_HOME"
    OPENCODE_RUNTIME_CONFIG_HOME=""
  fi
}

setup_opencode_runtime_config() {
  if [ "$AUTO_APPROVE_EXTERNAL_DIRECTORY" != "true" ]; then
    return 0
  fi

  local source_config_dir runtime_root override_file merged_file
  source_config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
  runtime_root=$(mktemp -d)
  OPENCODE_RUNTIME_CONFIG_HOME="$runtime_root"
  mkdir -p "$OPENCODE_RUNTIME_CONFIG_HOME/opencode"

  if [ -d "$source_config_dir" ]; then
    cp -R "$source_config_dir/." "$OPENCODE_RUNTIME_CONFIG_HOME/opencode/" 2>/dev/null || true
  fi

  override_file="$OPENCODE_RUNTIME_CONFIG_HOME/opencode/opencode.json"
  if [ -f "$override_file" ]; then
    merged_file=$(mktemp)
    if jq '.permission.external_directory = "allow"' "$override_file" > "$merged_file" 2>/dev/null; then
      mv "$merged_file" "$override_file"
    else
      rm -f "$merged_file"
      printf '{\n  "permission": {\n    "external_directory": "allow"\n  }\n}\n' > "$override_file"
    fi
  else
    printf '{\n  "permission": {\n    "external_directory": "allow"\n  }\n}\n' > "$override_file"
  fi

  export XDG_CONFIG_HOME="$OPENCODE_RUNTIME_CONFIG_HOME"
}

clone_and_prepare_repo() {
  mkdir -p "$WORKSPACE_ROOT"

  if [ -e "$TARGET_DIR" ]; then
    log "CLONE" "Removing existing target directory: $TARGET_DIR"
    rm -rf "$TARGET_DIR"
  fi

  local clone_source clone_mode
  if [ -n "${REPO_ROOT:-}" ] && [ -d "$REPO_ROOT/.git" ]; then
    clone_source="$REPO_ROOT"
    clone_mode="local"
  else
    clone_source="$REPO_URL"
    clone_mode="remote"
  fi

  log "CLONE" "Cloning from $clone_mode source $clone_source (branch=$MAIN_BRANCH) to $TARGET_DIR"
  if [ "$clone_mode" = "local" ]; then
    retry_with_backoff git clone --branch "$MAIN_BRANCH" --single-branch "$clone_source" "$TARGET_DIR" >/dev/null || return 1
  else
    retry_with_backoff git clone --branch "$MAIN_BRANCH" --single-branch --depth=1 "$clone_source" "$TARGET_DIR" >/dev/null || return 1
  fi

  cd "$TARGET_DIR" || return 1
  git checkout -b "$BRANCH_NAME" >/dev/null || return 1
  log "CLONE" "Checked out new branch: $BRANCH_NAME"
}

run_post_clone_commands() {
  if ! declare -p POST_CLONE_COMMANDS >/dev/null 2>&1; then
    log "SETUP" "No post-clone commands configured"
    return 0
  fi

  if [ "${#POST_CLONE_COMMANDS[@]}" -eq 0 ]; then
    log "SETUP" "No post-clone commands configured"
    return 0
  fi

  local cmd
  for cmd in "${POST_CLONE_COMMANDS[@]}"; do
    [ -z "$cmd" ] && continue
    log "SETUP" "Running post-clone command: $cmd"
    eval "$cmd" || return 1
  done
}

run_pipeline() {
  local started_at phase_start phase_end
  local did_run_fix=0
  started_at=$(date +%s)

  phase_start=$(date +%s)
  clone_and_prepare_repo || return 1
  phase_end=$(date +%s)
  log "CLONE" "Completed in $((phase_end - phase_start))s"

  phase_start=$(date +%s)
  run_post_clone_commands || return 1
  phase_end=$(date +%s)
  log "SETUP" "Completed in $((phase_end - phase_start))s"

  local prompt_file plan_file implement_prompt_file review_file diff_file commit_diff_file pr_diff_file
  prompt_file=$(mktemp)
  ensure_plan_runtime_dir
  plan_file=$(mktemp "$PLAN_RUNTIME_DIR/plan-XXXXXX.md")
  PLAN_FILE_USED="$plan_file"
  implement_prompt_file=$(mktemp)
  review_file=$(mktemp)
  diff_file=$(mktemp)
  commit_diff_file=$(mktemp)
  pr_diff_file=$(mktemp)
  trap "rm -f '$prompt_file' '$implement_prompt_file' '$review_file' '$diff_file' '$commit_diff_file' '$pr_diff_file'" EXIT

  printf '%s\n' "$USER_PROMPT" > "$prompt_file"

  if [ "$SKIP_PLAN" -eq 1 ]; then
    log "PLAN" "Skipped (user-provided plan)"
    if [ -n "$PLAN_TEXT" ]; then
      printf '%s\n' "$PLAN_TEXT" > "$plan_file"
    elif [ -n "$PLAN_FILE_PATH" ] && [ -f "$PLAN_FILE_PATH" ]; then
      cp "$PLAN_FILE_PATH" "$plan_file"
    else
      log "PLAN" "Error: --skip-plan requires --plan-file or OPENCODE_LOOP_PLAN_TEXT"
      return 1
    fi
    log "PLAN" "Plan saved to $plan_file"
  else
    phase_start=$(date +%s)
    log "PLAN" "Starting planning phase with model $MODEL_PLAN"
    local plan_raw plan_clean plan_prompt
    plan_prompt=$(cat <<EOF
You are running in non-interactive planning mode.

Hard rules:
- Do not ask follow-up questions.
- Do not output questions.
- Do not ask for clarification.
- If requirements are ambiguous or missing details, choose the best reasonable option and proceed.
- Briefly note assumptions, then provide a concrete execution plan.

User task:
$USER_PROMPT
EOF
)
    plan_raw=$(retry_with_backoff opencode run --agent plan -m "$MODEL_PLAN" -- "$plan_prompt") || return 1
    plan_clean=$(cleanup_text_output "$plan_raw")
    if [ -z "$plan_clean" ]; then
      log "PLAN" "Planning output was empty."
      return 1
    fi
    printf '%s\n' "$plan_clean" > "$plan_file"
    phase_end=$(date +%s)
    log "PLAN" "Completed in $((phase_end - phase_start))s. Plan saved to $plan_file"
  fi

  phase_start=$(date +%s)
  log "IMPLEMENT" "Starting implementation phase with model $MODEL_IMPLEMENT"
  cat > "$implement_prompt_file" <<EOF
Implement the following plan completely. Make all necessary code changes.

Original task:
$USER_PROMPT
EOF
  retry_with_backoff opencode run -m "$MODEL_IMPLEMENT" -f "$plan_file" -f "$implement_prompt_file" -- "Execute the attached plan in this repository. Use the second attachment as original task context." >/dev/null || return 1
  phase_end=$(date +%s)
  log "IMPLEMENT" "Completed in $((phase_end - phase_start))s"

  phase_start=$(date +%s)
  log "REVIEW" "Starting review phase with model $MODEL_REVIEW"
  local changed_files
  changed_files=$(git diff --name-only || true)
  printf '%s\n' "$changed_files" > "$diff_file"
  git diff >> "$diff_file"

  local review_prompt review_raw review_clean
  review_prompt="Review the following code changes critically. List specific issues (bugs, style, security, performance). If no issues, respond with exactly 'LGTM'. Format: one issue per line with file:line prefix."
  review_raw=$(retry_with_backoff opencode run -m "$MODEL_REVIEW" -f "$diff_file" -- "$review_prompt") || return 1
  review_clean=$(cleanup_text_output "$review_raw")
  printf '%s\n' "$review_clean" > "$review_file"
  phase_end=$(date +%s)
  log "REVIEW" "Completed in $((phase_end - phase_start))s"

  if ! echo "$review_clean" | grep -Eiq '^LGTM$'; then
    phase_start=$(date +%s)
    log "FIX" "Review found issues; running fix phase with model $MODEL_FIX"
    retry_with_backoff opencode run -m "$MODEL_FIX" -f "$review_file" -- "Fix all the following code review issues in this codebase. Use only the attached review comments as input." >/dev/null || return 1
    did_run_fix=1
    phase_end=$(date +%s)
    log "FIX" "Completed in $((phase_end - phase_start))s"
  else
    log "FIX" "Skipped fix phase because review response is LGTM"
  fi

  log "COMMIT" "Preparing commit"
  git add -A || return 1

  if [ -z "$(git status --porcelain)" ]; then
    log "COMMIT" "No changes after implementation/review. Nothing to commit."
    return 1
  fi

  git diff --staged > "$commit_diff_file" || return 1
  local commit_prompt commit_raw commit_msg
  commit_prompt="Generate a concise conventional commit message based on the attached git diff.
Follow these rules strictly:
- Format: <type>: <description>
- Allowed Types: feat, fix, chore, docs, style, refactor, perf, test.
- Imperative Mood: Use the imperative, present tense (e.g., 'add' instead of 'added').
- No Capitalization: Start the description with a lowercase letter.
- No Period: Do not end the subject line with a period.
Output ONLY the raw commit message text. No markdown, no backticks, no quotes, no preamble, no explanation."

  commit_raw=$(retry_with_backoff opencode run -m "$MODEL_COMMIT" -f "$commit_diff_file" -- "$commit_prompt") || return 1
  commit_msg=$(cleanup_text_output "$commit_raw" | head -n 1)
  if [ -z "$commit_msg" ]; then
    commit_msg="chore: apply opencode loop changes"
  fi

  log "COMMIT" "Committing with message: $commit_msg"
  git commit -m "$commit_msg" >/dev/null || return 1

  log "PUSH" "Pushing branch $BRANCH_NAME"
  resolve_repo_and_push_target
  if [ -z "$REPO" ]; then
    log "PUSH" "Error: Could not detect target GitHub repository for PR creation."
    return 1
  fi

  log "PUSH" "Using push target '$PUSH_TARGET' and PR repo '$REPO'"
  retry_with_backoff git push -u "$PUSH_TARGET" "$BRANCH_NAME" >/dev/null || return 1

  local base_ref head_ref
  if [ "$PUSH_TARGET" = "origin" ]; then
    if ! wait_for_remote_branch "$BRANCH_NAME"; then
      log "PUSH" "Error: Branch '$BRANCH_NAME' was pushed but is not visible on origin."
      return 1
    fi

    retry_with_backoff git fetch origin "$MAIN_BRANCH" "$BRANCH_NAME" >/dev/null || return 1
    base_ref="origin/$MAIN_BRANCH"
    head_ref="origin/$BRANCH_NAME"
  else
    base_ref="$MAIN_BRANCH"
    head_ref="HEAD"
  fi

  if ! branch_has_commits_ahead "$base_ref" "$head_ref"; then
    log "PR" "Error: No commits ahead of $base_ref on $head_ref."
    return 1
  fi

  phase_start=$(date +%s)
  log "PR" "Generating PR title and body with model $MODEL_PR"
  git diff "$MAIN_BRANCH...HEAD" > "$pr_diff_file" || return 1

  local pr_prompt pr_raw pr_clean title body
  pr_prompt="You are a tool that generates GitHub Pull Request descriptions.
Analyze the attached git diff and generate a concise title and a descriptive body.

TITLE Format: <type>: <description>
- Allowed Types: feat, fix, chore, docs, style, refactor, perf, test.
- Imperative Mood: Use the imperative, present tense (e.g., 'add' instead of 'added').
- No Capitalization: Start the description with a lowercase letter.
- No Period: Do not end the subject line with a period.

IMPORTANT: Your response MUST follow this exact format with NO preamble.
Format:
TITLE: <title>
BODY: <body>"

  pr_raw=$(retry_with_backoff opencode run -m "$MODEL_PR" -f "$pr_diff_file" -- "$pr_prompt") || return 1
  pr_clean=$(echo "$pr_raw" | strip_ansi | grep -v '^>' | sed '/^$/d')

  title=$(echo "$pr_clean" | grep -i "TITLE:" | head -n 1 | sed -E 's/^(\*\*)?[Tt][Ii][Tt][Ll][Ee]:(\*\*)?[[:space:]]*//')
  body=$(echo "$pr_clean" | sed -n '/[Bb][Oo][Dd][Yy]:/,$p' | sed -E '1s/^(\*\*)?[Bb][Oo][Dd][Yy]:(\*\*)?[[:space:]]*//')

  if [ -z "$title" ]; then
    title="chore: opencode loop update"
  fi
  if [ -z "$(echo "$body" | trim)" ]; then
    body="Automated update generated by opencode loop."
  fi

  local pr_head_ref="$BRANCH_NAME"
  if [ -n "$PUSH_BRANCH_OWNER" ]; then
    pr_head_ref="$PUSH_BRANCH_OWNER:$BRANCH_NAME"
  elif [ -n "$ORIGIN_OWNER" ]; then
    pr_head_ref="$ORIGIN_OWNER:$BRANCH_NAME"
  fi

  PR_URL=$(retry_with_backoff gh pr create --repo "$REPO" --base "$MAIN_BRANCH" --head "$pr_head_ref" --title "$title" --body "$body") || return 1
  PR_URL=$(echo "$PR_URL" | tail -n 1 | trim)

  phase_end=$(date +%s)
  log "PR" "Completed in $((phase_end - phase_start))s"
  log "DONE" "PR created: $PR_URL"

  local finished_at
  finished_at=$(date +%s)
  log "DONE" "Total duration: $((finished_at - started_at))s"

  report_model_costs "$did_run_fix"

  if [ -n "$PR_URL" ]; then
    cleanup_workspace_on_success
  fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --init)
        DO_INIT=1
        shift
        ;;
      --fg)
        RUN_MODE="fg"
        shift
        ;;
      --bg)
        RUN_MODE="bg"
        shift
        ;;
      --config)
        if [ $# -lt 2 ]; then
          echo "Error: --config requires a path"
          exit 1
        fi
        CONFIG_FILE="$2"
        shift 2
        ;;
      --dry-run)
        DO_DRY_RUN=1
        shift
        ;;
      --skip-plan)
        SKIP_PLAN=1
        shift
        ;;
      --plan-file)
        if [ $# -lt 2 ]; then
          echo "Error: --plan-file requires a path"
          exit 1
        fi
        PLAN_FILE_PATH="$2"
        SKIP_PLAN=1
        shift 2
        ;;
      --repo-dir)
        if [ $# -lt 2 ]; then
          echo "Error: --repo-dir requires a path"
          exit 1
        fi
        REPO_DIR="$2"
        shift 2
        ;;
      --log-opencode)
        LOG_OPENCODE_DETAIL=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      --)
        shift
        break
        ;;
      -* )
        echo "Error: Unknown option: $1"
        usage
        exit 1
        ;;
      *)
        if [ -z "$USER_PROMPT" ]; then
          USER_PROMPT="$1"
        else
          USER_PROMPT="$USER_PROMPT $1"
        fi
        shift
        ;;
    esac
  done

  if [ $# -gt 0 ]; then
    if [ -z "$USER_PROMPT" ]; then
      USER_PROMPT="$*"
    else
      USER_PROMPT="$USER_PROMPT $*"
    fi
  fi
}

main() {
  parse_args "$@"

  if [ "$DO_INIT" -eq 1 ]; then
    init_config "$CONFIG_FILE"
    exit 0
  fi

  # If --repo-dir specified, cd there before any git operations
  if [ -n "$REPO_DIR" ]; then
    if [ ! -d "$REPO_DIR" ]; then
      echo "Error: --repo-dir path does not exist: $REPO_DIR"
      exit 1
    fi
    cd "$REPO_DIR"
  fi

  load_config
  preflight_checks
  detect_repo_context

  if [ "$DO_DRY_RUN" -eq 1 ]; then
    echo "Dry run OK"
    echo "Config: $CONFIG_FILE"
    echo "Repo root: $REPO_ROOT"
    echo "Repo: $REPO"
    echo "Main branch: $MAIN_BRANCH"
    exit 0
  fi

  if [ -z "$USER_PROMPT" ]; then
    echo "Error: prompt is required unless using --init or --dry-run"
    usage
    exit 1
  fi

  if [ -n "${OPENCODE_LOOP_PROMPT:-}" ]; then
    USER_PROMPT="$OPENCODE_LOOP_PROMPT"
  fi

  # Pick up plan text from env var (used by Electron app)
  if [ -n "${OPENCODE_LOOP_PLAN_TEXT:-}" ]; then
    PLAN_TEXT="$OPENCODE_LOOP_PLAN_TEXT"
    SKIP_PLAN=1
  fi

  if [ -n "${OPENCODE_LOOP_BRANCH_NAME:-}" ]; then
    BRANCH_NAME="$OPENCODE_LOOP_BRANCH_NAME"
  else
    generate_branch_name
  fi

  setup_target_paths

  if [ "$RUN_MODE" = "bg" ] && [ "${__OPENCODE_LOOP_BG:-0}" != "1" ]; then
    mkdir -p "$TARGET_DIR"
    local pid
    nohup env \
      __OPENCODE_LOOP_BG=1 \
      OPENCODE_LOOP_PROMPT="$USER_PROMPT" \
      OPENCODE_LOOP_BRANCH_NAME="$BRANCH_NAME" \
      OPENCODE_LOOP_LOG_OPENCODE_DETAIL="$LOG_OPENCODE_DETAIL" \
      "$0" --fg --config "$CONFIG_FILE" >/dev/null 2>&1 &
    pid=$!
    disown "$pid" || true
    echo "Running in background. Log: $LOG_FILE. PID: $pid"
    exit 0
  fi

  setup_logging
  trap cleanup_opencode_runtime_config EXIT

  if ! setup_opencode_runtime_config; then
    log "INIT" "Error: failed to prepare OpenCode runtime config override"
    exit 1
  fi

  log "INIT" "Starting OpenCode loop"
  log "INIT" "Repo: $REPO"
  log "INIT" "Main branch: $MAIN_BRANCH"
  log "INIT" "Target branch: $BRANCH_NAME"
  log "INIT" "Workspace dir: $TARGET_DIR"
  if [ "$AUTO_APPROVE_EXTERNAL_DIRECTORY" = "true" ]; then
    log "INIT" "External-directory access auto-approval enabled"
  fi

  if run_pipeline; then
    cleanup_plan_file
    notify_success "$PR_URL"
  else
    cleanup_plan_file
    notify_error "OpenCode Loop failed. Check log: $LOG_FILE"
    exit 1
  fi
}

main "$@"
