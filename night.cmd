@echo off
rem Night brain for FlyBot 0.1: restarts OpenCode in a loop, keeps body and runner alive.
rem Stop: close this window (or Ctrl+C, then Y).
rem Brain model: data\models.json (audit app, tab Models), re-read before EVERY session. This value is only a fallback.
set MODEL=opencode/minimax-m3.1-flash-free
title flybot-night-brain
cd /d "%~dp0"
if not exist data mkdir data
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0brain_guard.ps1" -Log "%~dp0data\night.log"
:loop
curl.exe -s -m 3 http://127.0.0.1:3199/health >nul 2>&1 || start "flybot-body" /min cmd /c "cd /d %~dp0 && node bot.js localhost 25565 FlyBot_01 3199 >> data\flybot.out.log 2>&1"
curl.exe -s -m 3 http://127.0.0.1:3200/health >nul 2>&1 || start "flybot-brain-runner" /min cmd /c "cd /d %~dp0brain && node runner.js >> ..\data\runner.out.log 2>&1"
timeout /t 5 /nobreak >nul
for /f "delims=" %%m in ('node "%~dp0models_config.js" get brain 2^>nul') do set MODEL=%%m
rem Body not in the world (no answer or ready=false, e.g. server offline) - do not start the brain, check again in 60 s.
curl.exe -s -m 5 http://127.0.0.1:3199/health 2>nul | findstr /r /c:"ready.:true" >nul
if errorlevel 1 (
  echo [%time%] body not in the world, brain waits 60 s
  timeout /t 60 /nobreak >nul
  goto loop
)
rem Handover in the loop too: tail of the previous brain session -> data\handover.md (the new brain reads it at start), fresh ready.flag.
node "%~dp0tools\handover_note.js" data\night.log data\handover.md >nul 2>&1
del /q brain\ready.flag >nul 2>&1
echo. >> data\night.log
echo ===== [%date% %time%] brain start, model %MODEL% ===== >> data\night.log
echo [%time%] brain start, model %MODEL%
call opencode run --auto -m %MODEL% "You are the brain of the Minecraft bot FlyBot_01. Read brain/BRAIN_PROMPT.md and follow it exactly. The main long project is brain/PROJECT.md (The Abyss Citadel). Continue from where brain/notes.md says you stopped. You are the architect: you do not control the bot, you only read its state and write the build goal line, the base line and blueprints. Work in the loop wait for events - check build progress and idle - update the goal line, without stopping. Keep brain/notes.md short and update it before you finish. Write notes in Russian." 2>&1 | node "%~dp0tools\tstamp.js" >> data\night.log
echo [%time%] brain stopped, restarting in 15 s
timeout /t 15 /nobreak >nul
goto loop
