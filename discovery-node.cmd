@echo off
rem CareerAutopilot discovery node - double-clickable launcher (Windows).
rem
rem The first run installs what the node needs, asks for your CareerAutopilot
rem address and a discovery token once, then starts the node in THIS window and
rem prints the address of its dashboard. Close the window to stop the node:
rem nothing is installed that keeps running after it, and nothing starts at boot.
setlocal
cd /d "%~dp0"
title CareerAutopilot discovery node

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed, or it is not on PATH.
  echo   Install the LTS build from https://nodejs.org, then run this again.
  echo.
  pause
  exit /b 1
)

node autopilot/discovery-node-start.mjs %*
if errorlevel 1 (
  echo.
  echo   The node did not start, or it stopped with an error - the message above says why.
  echo.
  pause
  exit /b 1
)
