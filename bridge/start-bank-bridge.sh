#!/bin/sh
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Please install Node.js LTS from https://nodejs.org then run this again."; xdg-open https://nodejs.org; exit 1; }
[ -d node_modules/playwright-core ] || { echo "First run: installing the bank sign-in helper..."; npm install --no-audit --no-fund; }
(sleep 1; xdg-open http://127.0.0.1:8765 >/dev/null 2>&1) &
node ownbooks-bank-bridge.js
