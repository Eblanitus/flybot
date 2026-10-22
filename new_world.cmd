@echo off
rem Новый мир (тот же сид): память о старом мире в архив, навыки остаются. "new_world.cmd check" - только показать.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\new_world.ps1" %1
pause
