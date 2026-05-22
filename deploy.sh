#!/bin/bash
# ACC Health Insurance UW Automation Platform — Deploy Script
# Usage: ./deploy.sh "commit message"

set -e

MSG="${1:-Update platform}"

echo "=== ACC Health UW Automation — Deploy ==="
echo "Commit: $MSG"
echo ""

cd "$(dirname "$0")"

if [ ! -d ".git" ]; then
  echo "Initializing git repository..."
  git init
  git remote add origin git@github.com:nileshsatpute82/acc-insurance-uw.git
  git branch -M main
fi

git add -A
git status
echo ""

git commit -m "$MSG"
git push origin main

echo ""
echo "✅ Deployed! Render will auto-deploy from main branch."
echo "   Backend:  https://insuranceuwapi.acc.ltd"
echo "   Frontend: https://insuranceuw.acc.ltd"
echo "   Version:  4.0.0"
