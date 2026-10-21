@echo off
rem Only the teacher and the engineer, no brain: they work through the queue while this window is open.
rem Close night.cmd first (its guard runs the teacher too). Stop: close this window.
title flybot-teacher
cd /d "%~dp0"
echo Waiting 35 s for the old guard to exit...
timeout /t 35 /nobreak >nul
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0brain_guard.ps1" -Log "%~dp0data\night.log"
echo Teacher is running. Progress: data\guard.log and the Teacher tab in the audit app. Close this window to stop.
:wait
timeout /t 3600 /nobreak >nul
goto wait
