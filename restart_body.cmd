@echo off
rem Restart FlyBot body (bot.js) so core changes in lib\ and bot.js take effect. Brain, guard and night.cmd keep running.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart_body.ps1"
