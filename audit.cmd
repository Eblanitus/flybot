@echo off
chcp 65001 >nul
rem Аудит мухи: запускает локальный сервер (порт 3300) и открывает страницу в браузере. Если уже запущен — просто открывает.
cd /d "%~dp0"
curl.exe -s -o nul --max-time 2 http://127.0.0.1:3300/
if %errorlevel%==0 goto open
start "flybot-audit" /min node audit\server.js
set /a n=0
:wait
timeout /t 1 /nobreak >nul
curl.exe -s -o nul --max-time 2 http://127.0.0.1:3300/
if %errorlevel%==0 goto open
set /a n+=1
if %n% lss 15 goto wait
echo Audit server did not start. Check that Node.js is installed: node -v
pause
exit /b 1
:open
start "" http://127.0.0.1:3300
