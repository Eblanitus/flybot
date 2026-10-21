@echo off
chcp 65001 >nul
rem Исполнитель выученных навыков: http://127.0.0.1:3200
rem Тело по умолчанию http://127.0.0.1:3199 (FlyBot_01). Для FlyBot: set BODY_URL=http://127.0.0.1:3099
title flybot-brain-runner
cd /d "%~dp0"
node runner.js
