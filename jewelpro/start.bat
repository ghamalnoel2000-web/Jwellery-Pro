@echo off
title JewelPro
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 22 LTS from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo Installing JewelPro files for the first time. This needs internet once...
  call npm install --omit=dev
)

node --no-warnings server.js
echo.
echo JewelPro has stopped.
pause
