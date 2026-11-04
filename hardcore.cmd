@echo off
chcp 65001 >nul
rem Хардкор-стенд, этап 1а: мир за миром без человека. Описание - hardcore\README.md.
rem Стоп: создай файл hardcore\data\STOP (доиграет мир и выйдет) или закрой окно.
title flybot-hardcore-stand
cd /d "%~dp0"
if not exist hardcore\config.json (
  echo Нет hardcore\config.json - скопируй hardcore\config.example.json и впиши serverDir.
  pause
  exit /b 1
)
node hardcore\stand.js hardcore\config.json
echo Стенд остановился, код %errorlevel%. Итоги: hardcore\data\worlds.jsonl и lives.jsonl, журнал: hardcore\data\stand.log
if exist hardcore\data\NEED_HUMAN.txt type hardcore\data\NEED_HUMAN.txt
pause
