#!/usr/bin/env bash

if [ -z "${BASH_VERSION:-}" ] || [ -n "${POSIXLY_CORRECT:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

# git-autofix: Find PR review findings from github-actions bot, fix them with
#              opencode (Claude Sonnet 4.6), then commit, push, wait for
#              required PR checks, and auto-merge (unless --skip-merge).

MODEL="github-copilot/claude-sonnet-4.6"
SKIP_MERGE=0

for arg in "$@"; do
  case "$arg" in
    --skip-merge)
      SKIP_MERGE=1
      ;;
    *)
      echo "Error: Unknown option '$arg'."
      echo "Usage: $0 [--skip-merge]"
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

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Error: Not a git repository."; exit 1; }

for cmd in gh opencode jq; do
  if ! command -v "$cmd" &> /dev/null; then
    echo "Error: $cmd is not installed."
    exit 1
  fi
done

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" == "main" || "$BRANCH" == "master" ]]; then
  echo "Error: Current branch is $BRANCH. Switch to a feature branch with an open PR."
  exit 1
fi

echo "==> Branch: $BRANCH"

# ---------------------------------------------------------------------------
# 1. Find the open PR for the current branch
# ---------------------------------------------------------------------------

PR_JSON=$(gh pr view "$BRANCH" --json number,url,baseRefName 2>/dev/null || true)
if [ -z "$PR_JSON" ]; then
  echo "Error: No open PR found for branch '$BRANCH'."
  exit 1
fi

PR_NUMBER=$(echo "$PR_JSON" | jq -r '.number')
PR_URL=$(echo "$PR_JSON" | jq -r '.url')
PR_BASE_REF=$(echo "$PR_JSON" | jq -r '.baseRefName // empty')
echo "==> Found PR #$PR_NUMBER: $PR_URL"

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
if [ -z "$REPO" ]; then
  echo "Error: Could not detect current GitHub repository."
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Fetch github-actions bot comment that contains "Findings"
# ---------------------------------------------------------------------------

echo "==> Fetching PR comments..."
RAW_COMMENTS_FILE=$(mktemp)
COMMENTS_JSON_FILE=$(mktemp)

if ! gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate > "$RAW_COMMENTS_FILE" 2>/dev/null; then
  echo "Error: Failed to fetch PR comments from GitHub API."
  exit 1
fi

# First try a strict jq parse; if that fails (e.g. raw control chars in comment
# bodies), fall back to python's tolerant JSON decoder and re-emit valid JSON.
if ! jq -s 'add' "$RAW_COMMENTS_FILE" > "$COMMENTS_JSON_FILE" 2>/dev/null; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Error: Could not parse PR comments JSON with jq, and python3 is unavailable for fallback parsing."
    exit 1
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
    echo "Error: Failed to parse PR comments from GitHub API output."
    exit 1
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
  echo "Error: No github-actions comment with 'Findings' found on PR #$PR_NUMBER."
  echo ""
  echo "Available github-actions comments:"
  jq -r '
    .[] | select(.user.login | test("github-actions"))
    | "  - \(.user.login): \(.body[:100])..."' "$COMMENTS_JSON_FILE" 2>/dev/null || echo "  (none)"
  exit 1
fi

echo "==> Found review comment with findings."

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
echo "==> Changed files vs $PR_BASE_REF: $CHANGED_COUNT"

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
    echo "==> Filtered findings to current changed files."
  fi
fi
fi

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

echo "==> Running opencode to fix review findings..."
opencode run \
  -m "$MODEL" \
  -f "$REVIEW_FILE" \
  -- "$PROMPT"

echo ""
echo "==> opencode finished. Checking for changes..."

# ---------------------------------------------------------------------------
# 4. Commit and push
# ---------------------------------------------------------------------------

if [ -z "$(git status --porcelain)" ]; then
  echo "No file changes were made. Nothing to commit."
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
  -m "github-copilot/gemini-3-flash-preview" \
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

echo "==> Committing: $COMMIT_MSG"
git commit -m "$COMMIT_MSG"

echo "==> Pushing to origin/$BRANCH..."
git push origin "$BRANCH"

echo ""
echo "==> Done! PR #$PR_NUMBER updated with fixes."
echo "    $PR_URL"

# ---------------------------------------------------------------------------
# 5. Mark the github-actions findings comment as resolved (minimized)
# ---------------------------------------------------------------------------

if [ -n "$REVIEW_COMMENT_NODE_ID" ]; then
  echo "==> Marking findings comment as resolved..."
  gh api graphql -f query="
mutation {
  minimizeComment(input: {subjectId: \"$REVIEW_COMMENT_NODE_ID\", classifier: RESOLVED}) {
    minimizedComment {
      isMinimized
    }
  }
}" >/dev/null 2>&1 && echo "==> Comment marked as resolved." || echo "Warning: Could not minimize comment (requires write access)."
fi

# ---------------------------------------------------------------------------
# 6. Wait for required PR checks and auto-merge
# ---------------------------------------------------------------------------

if [ "$SKIP_MERGE" -eq 1 ]; then
  echo "==> --skip-merge enabled. Skipping PR checks wait and auto-merge."
  exit 0
fi

echo "==> Waiting for required PR checks to complete..."
if ! gh pr checks "$PR_NUMBER" --watch --required; then
  echo "Error: Required PR checks did not pass. PR was not merged."
  exit 1
fi

echo "==> Required checks passed. Enabling auto-merge..."
if gh pr merge "$PR_NUMBER" --auto --delete-branch >/dev/null 2>&1; then
  echo "==> Auto-merge enabled (or PR merged immediately)."
else
  echo "Warning: Could not enable auto-merge. You may need approvals or additional permissions."
fi
