@echo off
rem Eyes of the fly: frames from the real Minecraft window (spectator attached to FlyBot_01) -> Gemini Live -> data\eyes.log (the teacher reads it).
rem Needs: ffmpeg in PATH, Gemini key (GEMINI_API_KEY or opencode auth.json), datapack flyeyes in the world (node tools\eyes_install.js once, then /reload in game).
rem The observer client (FlyEyes) is started by eyes.js itself when the fly is in the world (data\eyes.json: autoClient; false = open the window by hand). Dry check: node tools\eyes.js --client-cmd
rem Settings: data\eyes.json (model, window, fps, width, askEverySec, maxOutputTokens), status: data\eyes_status.json. Check link: node tools\eyes.js --probe
rem Stop: close this window (or Ctrl+C, then Y).
title flybot-eyes
cd /d "%~dp0"
if not exist data mkdir data
:loop
echo ===== [%date% %time%] eyes start ===== >> data\eyes_console.log
node "%~dp0tools\eyes.js" 2>&1 | node "%~dp0tools\tstamp.js" >> data\eyes_console.log
rem console log over 2 MB -> eyes_console.log.1 (one old copy kept)
for %%A in (data\eyes_console.log) do if %%~zA GTR 2097152 move /y data\eyes_console.log data\eyes_console.log.1 >nul
echo [%time%] eyes stopped, restarting in 10 s
timeout /t 10 /nobreak >nul
goto loop
