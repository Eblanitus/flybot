@echo off
rem Night brain for FlyTest: restarts OpenCode in a loop, keeps body and runner alive.
rem Stop: close this window (or Ctrl+C, then Y).
set MODEL=opencode/deepseek-v4.1-flash-free
title flybot-night-brain
cd /d "%~dp0"
if not exist data mkdir data
:loop
curl.exe -s -m 3 http://127.0.0.1:3199/health >nul 2>&1 || start "flybot-body" /min cmd /c "cd /d %~dp0 && node bot.js localhost 25565 FlyTest 3199 >> data\flytest.out.log 2>&1"
curl.exe -s -m 3 http://127.0.0.1:3200/health >nul 2>&1 || start "flybot-brain-runner" /min cmd /c "cd /d %~dp0brain && node runner.js >> ..\data\runner.out.log 2>&1"
timeout /t 5 /nobreak >nul
echo. >> data\night.log
echo ===== [%date% %time%] brain start ===== >> data\night.log
echo [%time%] brain start
call opencode run --auto -m %MODEL% "You are the brain of the Minecraft bot FlyTest. Read brain/BRAIN_PROMPT.md and follow it exactly. The main long project is brain/PROJECT.md (The Abyss Citadel). Continue from where brain/notes.md says you stopped. Work in the loop snapshot - skill - wait without stopping. Before you finish this session, update brain/notes.md. Write notes in Russian." >> data\night.log 2>&1
echo [%time%] brain stopped, restarting in 15 s
timeout /t 15 /nobreak >nul
goto loop
