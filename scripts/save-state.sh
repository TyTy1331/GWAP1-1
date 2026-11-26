#!/usr/bin/env bash
# Pushes state/ to the bot-state branch as one snapshot commit with no history (the branch never grows).
# The journal files inside it keep every trade. Needs GH_TOKEN and GITHUB_REPOSITORY.
set -e
cd state
[ -f state.json ] || exit 0
git add state.json journal 2>/dev/null || git add state.json
if git rev-parse -q --verify HEAD >/dev/null && git diff --cached --quiet; then echo "state unchanged"; exit 0; fi
git checkout -q --orphan "snapshot-$(date +%s%N)"
git -c user.name=nowick-bot -c user.email=nowick-bot@users.noreply.github.com commit -q -m "state $(date -u +%FT%TZ)"
git push -q -f "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" HEAD:bot-state
