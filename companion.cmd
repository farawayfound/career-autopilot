@echo off
rem Career-Ops Companion — double-clickable launcher (Windows).
rem
rem First run on a machine: installs dependencies, finds Chrome, asks for the
rem server URL + token once, walks you through loading the extension and signing
rem in, and builds "Career-Ops Companion.lnk" next to this file. Drag that
rem shortcut to the Desktop, then right-click it to pin it to the taskbar.
rem
rem Every run after that: a few checks, then the browser.
setlocal
cd /d "%~dp0"
title Career-Ops Companion

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed, or it is not on PATH.
  echo   Install the LTS build from https://nodejs.org, then run this again.
  echo.
  pause
  exit /b 1
)

node extension/setup-companion.mjs --launch %*
if errorlevel 1 (
  echo.
  echo   Setup or launch did not finish - the message above says why.
  echo.
  pause
  exit /b 1
)
