@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Please install Node.js LTS from https://nodejs.org then run this again. & start "" https://nodejs.org & pause & exit /b)
if not exist node_modules\playwright-core (echo First run: installing the bank sign-in helper... & call npm install --no-audit --no-fund)
start "" http://127.0.0.1:8765
node ownbooks-bank-bridge.js
pause
