@echo off
chcp 65001 >nul
rem Новый мир (тот же сид): память о старом мире в архив, навыки остаются. "new_world.cmd check" - только показать.
title FlyBot - новый мир
if /i "%1"=="check" goto check
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\new_world.ps1" check
echo.
choice /c YN /m "Сбросить память старого мира"
if errorlevel 2 goto end
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\new_world.ps1"
goto end
:check
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\new_world.ps1" check
:end
pause
