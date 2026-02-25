#!/usr/bin/env bash

if [ -z "${BASH_VERSION:-}" ] || [ -n "${POSIXLY_CORRECT:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

# git-autofix: Find PR review findings from github-actions bot, fix them with
#              opencode (fix model), then commit, push, wait for
#              required PR checks, and auto-merge (unless --skip-merge).

DEFAULT_MODEL_FIX="github-copilot/claude-sonnet-4.6"
MODEL_FIX="${OPENCODE_LOOP_MODEL_FIX:-$DEFAULT_MODEL_FIX}"
SKIP_MERGE=0
TARGET_BRANCH=""

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
  pr-autofix.sh [--branch <name>] [--skip-merge]

Options:
  --branch <name>  Run against a specific local branch
  --skip-merge   Skip waiting for required checks and skip auto-merge
  -h, --help     Show this help

Environment:
  OPENCODE_LOOP_MODEL_FIX   Override the fix model (default: github-copilot/claude-sonnet-4.6)
EOF
}

fail() {
  local phase="$1"
  shift
  log "$phase" "Error: $*"
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-merge)
      SKIP_MERGE=1
      shift
      ;;
    --branch)
      shift
      if [ $# -eq 0 ]; then
        echo "Error: --branch requires a value"
        usage
        exit 1
      fi
      TARGET_BRANCH="$1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: Unknown option '$1'."
      usage
      exit 1
      ;;
  esac
done

cleanup() {
  rm -f "${REVIEW_FILE:-}" "${FILTERED_REVIEW_FILE:-}" "${CHANGED_FILES_FILE:-}" "${DIFF_FILE:-}" "${RAW_COMMENTS_FILE:-}" "${COMMENTS_JSON_FILE:-}"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "INIT" "Not a git repository."

for cmd in gh opencode jq; do
  if ! command -v "$cmd" &> /dev/null; then
    fail "INIT" "$cmd is not installed."
  fi
done

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
BRANCH="$CURRENT_BRANCH"

if [ -n "$TARGET_BRANCH" ]; then
  BRANCH="$TARGET_BRANCH"
  if ! git show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
    fail "INIT" "Branch '$TARGET_BRANCH' does not exist locally."
  fi

  if [ "$CURRENT_BRANCH" != "$TARGET_BRANCH" ]; then
    log "INIT" "Switching branch from $CURRENT_BRANCH to $TARGET_BRANCH"
    if ! git checkout "$TARGET_BRANCH" >/dev/null 2>&1; then
      fail "INIT" "Failed to checkout branch '$TARGET_BRANCH'."
    fi
  fi
fi

if [[ "$BRANCH" == "main" || "$BRANCH" == "master" ]]; then
  fail "INIT" "Current branch is $BRANCH. Switch to a feature branch with an open PR."
fi

log "INIT" "Target branch: $BRANCH"
started_at=$(date +%s)

# ---------------------------------------------------------------------------
# 1. Find the open PR for the current branch
# ---------------------------------------------------------------------------

PR_JSON=$(gh pr view "$BRANCH" --json number,url,baseRefName 2>/dev/null || true)
if [ -z "$PR_JSON" ]; then
  fail "INIT" "No open PR found for branch '$BRANCH'."
fi

PR_NUMBER=$(echo "$PR_JSON" | jq -r '.number')
PR_URL=$(echo "$PR_JSON" | jq -r '.url')
PR_BASE_REF=$(echo "$PR_JSON" | jq -r '.baseRefName // empty')
log "INIT" "Found PR #$PR_NUMBER: $PR_URL"

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
if [ -z "$REPO" ]; then
  fail "INIT" "Could not detect current GitHub repository."
fi

# ---------------------------------------------------------------------------
# 2. Fetch github-actions bot comment that contains "Findings"
# ---------------------------------------------------------------------------

phase_start=$(date +%s)
log "REVIEW" "Starting findings retrieval from PR comments"
RAW_COMMENTS_FILE=$(mktemp)
COMMENTS_JSON_FILE=$(mktemp)

if ! gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate > "$RAW_COMMENTS_FILE" 2>/dev/null; then
  fail "REVIEW" "Failed to fetch PR comments from GitHub API."
fi

# First try a strict jq parse; if that fails (e.g. raw control chars in comment
# bodies), fall back to python's tolerant JSON decoder and re-emit valid JSON.
if ! jq -s 'add' "$RAW_COMMENTS_FILE" > "$COMMENTS_JSON_FILE" 2>/dev/null; then
  if ! command -v python3 >/dev/null 2>&1; then
    fail "REVIEW" "Could not parse PR comments JSON with jq, and python3 is unavailable for fallback parsing."
  fi

  if ! python3 -c '
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8", errors="replace") as f:
    payload = f.read()

decoder = json.JSONDecoder(strict=False)
idx = 0
merged = []

while True:
    while idx < len(payload) and payload[idx].isspace():
        idx += 1
    if idx >= len(payload):
        break

    obj, idx = decoder.raw_decode(payload, idx)
    if isinstance(obj, list):
        merged.extend(obj)
    else:
        merged.append(obj)

with open(sys.argv[2], "w", encoding="utf-8") as out:
    json.dump(merged, out)
' "$RAW_COMMENTS_FILE" "$COMMENTS_JSON_FILE" 2>/dev/null; then
    fail "REVIEW" "Failed to parse PR comments from GitHub API output."
  fi
fi

# Pick the LAST github-actions comment whose body contains "Findings"
REVIEW_COMMENT_JSON=$(jq '
  [.[] | select(
    (.user.login == "github-actions" or .user.login == "github-actions[bot]") and
    (.body | contains("Findings"))
  )] | last // empty
' "$COMMENTS_JSON_FILE")

REVIEW_COMMENT=$(echo "$REVIEW_COMMENT_JSON" | jq -r '.body // empty')
REVIEW_COMMENT_NODE_ID=$(echo "$REVIEW_COMMENT_JSON" | jq -r '.node_id // empty')

if [ -z "$REVIEW_COMMENT" ]; then
  log "REVIEW" "No github-actions comment with 'Findings' found on PR #$PR_NUMBER."
  log "REVIEW" "Available github-actions comments:"
  jq -r '
    .[] | select(.user.login | test("github-actions"))
    | "  - \(.user.login): \(.body[:100])..."' "$COMMENTS_JSON_FILE" 2>/dev/null || log "REVIEW" "  (none)"
  exit 1
fi

log "REVIEW" "Found review comment with findings"

REVIEW_FILE=$(mktemp)
echo "$REVIEW_COMMENT" > "$REVIEW_FILE"

# ---------------------------------------------------------------------------
# 2.5 Filter findings to current changed files only
# ---------------------------------------------------------------------------

if [ -z "$PR_BASE_REF" ]; then
  PR_BASE_REF="main"
  git show-ref --verify --quiet refs/heads/main || PR_BASE_REF="master"
fi

CHANGED_FILES_FILE=$(mktemp)
if ! git diff --name-only "$PR_BASE_REF...HEAD" > "$CHANGED_FILES_FILE" 2>/dev/null; then
  : > "$CHANGED_FILES_FILE"
fi

CHANGED_COUNT=$(wc -l < "$CHANGED_FILES_FILE" | tr -d '[:space:]')
log "REVIEW" "Changed files vs $PR_BASE_REF: $CHANGED_COUNT"

FILTERED_REVIEW_FILE=$(mktemp)

if [ "$CHANGED_COUNT" -gt 0 ] && command -v python3 >/dev/null 2>&1; then
  if python3 -c '
import re
import sys

review_path = sys.argv[1]
changed_path = sys.argv[2]
output_path = sys.argv[3]

def normalize(path):
  p = path.strip().strip("`\".,:;()[]{}<>")
  p = p.replace("\\\\", "/")
  if p.startswith("./"):
    p = p[2:]
  while "//" in p:
    p = p.replace("//", "/")
  return p

with open(review_path, "r", encoding="utf-8", errors="replace") as f:
  review = f.read()

with open(changed_path, "r", encoding="utf-8", errors="replace") as f:
  changed_files = [normalize(line) for line in f if line.strip()]

changed_set = set(changed_files)
basename_map = {}
for path in changed_files:
  base = path.rsplit("/", 1)[-1]
  basename_map.setdefault(base, set()).add(path)

file_pattern = re.compile(r"[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)+(?:\.[A-Za-z0-9._-]+)?")

def block_related(block):
  refs = [normalize(m.group(0)) for m in file_pattern.finditer(block)]
  if not refs:
    return False
  for ref in refs:
    if ref in changed_set:
      return True
    base = ref.rsplit("/", 1)[-1]
    if base in basename_map and len(basename_map[base]) == 1:
      return True
  return False

blocks = re.split(r"\n\s*\n", review)
if not blocks:
  filtered = review
else:
  related = [block_related(block) for block in blocks]
  keep = [False] * len(blocks)

  for i, is_related in enumerate(related):
    if not is_related:
      continue
    keep[i] = True
    if i - 1 >= 0 and not related[i - 1]:
      keep[i - 1] = True
    if i + 1 < len(blocks) and not related[i + 1]:
      keep[i + 1] = True

  for i, block in enumerate(blocks):
    lowered = block.lower()
    if any(token in lowered for token in ("findings", "summary", "review", "overall")):
      keep[i] = True

  selected = [block for i, block in enumerate(blocks) if keep[i] and block.strip()]
  filtered = "\n\n".join(selected).strip()

with open(output_path, "w", encoding="utf-8") as out:
  out.write(filtered if filtered else review)
' "$REVIEW_FILE" "$CHANGED_FILES_FILE" "$FILTERED_REVIEW_FILE" 2>/dev/null; then
  FILTERED_REVIEW_LEN=$(wc -c < "$FILTERED_REVIEW_FILE" | tr -d '[:space:]')
  if [ "$FILTERED_REVIEW_LEN" -gt 0 ]; then
    REVIEW_FILE="$FILTERED_REVIEW_FILE"
    log "REVIEW" "Filtered findings to current changed files"
  fi
fi
fi

phase_end=$(date +%s)
log "REVIEW" "Completed in $((phase_end - phase_start))s"

# ---------------------------------------------------------------------------
# 3. Use opencode (Claude Sonnet 4.6) to fix the review findings + lint/build
# ---------------------------------------------------------------------------

PROMPT="You are a senior developer fixing code review findings from a CI bot on a GitHub Pull Request.

The attached file contains the review comments/findings posted by the CI bot.

Your tasks (in order):
1. Read and understand every finding in the attached review.
2. Fix ALL issues mentioned in the review by editing the relevant source files in this project.
3. After addressing the review, also fix any remaining build errors and lint errors.
4. Make sure the code compiles and passes linting after your changes.

Rules:
- Do NOT add new features or refactor beyond what is needed.
- Keep changes minimal and focused on the findings and build/lint fixes.
- Do NOT delete or rename files unless a finding explicitly asks for it."

phase_start=$(date +%s)
log "FIX" "Starting fix phase with model $MODEL_FIX"
opencode run \
  -m "$MODEL_FIX" \
  -f "$REVIEW_FILE" \
  -- "$PROMPT"

phase_end=$(date +%s)
log "FIX" "Completed in $((phase_end - phase_start))s"

# ---------------------------------------------------------------------------
# 4. Commit and push
# ---------------------------------------------------------------------------

phase_start=$(date +%s)
log "COMMIT" "Preparing commit"
if [ -z "$(git status --porcelain)" ]; then
  log "COMMIT" "No file changes were made. Nothing to commit"
  finished_at=$(date +%s)
  log "DONE" "PR unchanged: $PR_URL"
  log "DONE" "Total duration: $((finished_at - started_at))s"
  exit 0
fi

git add -A

# Generate a commit message from the staged diff
DIFF_FILE=$(mktemp)
git diff --staged > "$DIFF_FILE"

COMMIT_PROMPT="Generate a concise conventional commit message for the attached git diff.
These changes fix code review findings from a CI bot on a GitHub Pull Request.
Format: fix: <description>
Output ONLY the raw commit message text. No markdown, no backticks, no quotes, no preamble."

RAW_MSG=$(opencode run \
  -m "$MODEL_FIX" \
  -f "$DIFF_FILE" \
  -- "$COMMIT_PROMPT" 2>&1)

COMMIT_MSG=$(echo "$RAW_MSG" \
  | sed 's/\x1b\[[0-9;]*m//g' \
  | grep -v '^>' \
  | sed '/^$/d' \
  | sed 's/^[[:space:]]*//' \
  | sed 's/[[:space:]]*$//' \
  | head -n 1)

if [ -z "$COMMIT_MSG" ]; then
  COMMIT_MSG="fix: address PR review findings"
fi

log "COMMIT" "Committing with message: $COMMIT_MSG"
git commit -m "$COMMIT_MSG"

phase_end=$(date +%s)
log "COMMIT" "Completed in $((phase_end - phase_start))s"

phase_start=$(date +%s)
log "PUSH" "Pushing branch $BRANCH"
git push origin "$BRANCH"
phase_end=$(date +%s)
log "PUSH" "Completed in $((phase_end - phase_start))s"

log "DONE" "PR updated: $PR_URL"

# ---------------------------------------------------------------------------
# 5. Mark the github-actions findings comment as resolved (minimized)
# ---------------------------------------------------------------------------

if [ -n "$REVIEW_COMMENT_NODE_ID" ]; then
  log "PR" "Marking findings comment as resolved"
  gh api graphql -f query="
mutation {
  minimizeComment(input: {subjectId: \"$REVIEW_COMMENT_NODE_ID\", classifier: RESOLVED}) {
    minimizedComment {
      isMinimized
    }
  }
}" >/dev/null 2>&1 && log "PR" "Comment marked as resolved" || log "PR" "Warning: Could not minimize comment (requires write access)"
fi

# ---------------------------------------------------------------------------
# 6. Wait for required PR checks and auto-merge
# ---------------------------------------------------------------------------

phase_start=$(date +%s)
if [ "$SKIP_MERGE" -eq 1 ]; then
  log "PR" "Skipped waiting for checks and auto-merge (--skip-merge enabled)"
  phase_end=$(date +%s)
  log "PR" "Completed in $((phase_end - phase_start))s"
  finished_at=$(date +%s)
  log "DONE" "Total duration: $((finished_at - started_at))s"
  exit 0
fi

log "PR" "Waiting for required PR checks"
if ! gh pr checks "$PR_NUMBER" --watch --required; then
  fail "PR" "Required PR checks did not pass. PR was not merged."
fi

log "PR" "Required checks passed. Enabling auto-merge"
if gh pr merge "$PR_NUMBER" --auto --delete-branch >/dev/null 2>&1; then
  log "PR" "Auto-merge enabled (or PR merged immediately)"
else
  log "PR" "Warning: Could not enable auto-merge. You may need approvals or additional permissions"
fi

phase_end=$(date +%s)
log "PR" "Completed in $((phase_end - phase_start))s"
finished_at=$(date +%s)
log "DONE" "Total duration: $((finished_at - started_at))s"
