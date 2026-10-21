@echo off
rem Restart FlyBot brain with handover: old brain plays until the new one writes brain\ready.flag
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart_brain.ps1"
