# Перезапуск мозга с передачей управления:
# старый мозг играет, пока новый не прочитает заметки и не создаст brain\ready.flag
# ИЛИ не пошлёт первую команду телу (/do, /cmd в его журнале) — он иногда забывает флажок.
# Запуск: двойной клик по restart_brain.cmd
$fb   = 'C:\Users\user\flybot'
$flag = "$fb\brain\ready.flag"
$log  = "$fb\data\handover.log"   # night.log занят открытым мозгом
. "$PSScriptRoot\handover_lib.ps1"
function Log($t) { $s = "[$(Get-Date -Format 'HH:mm:ss')] handover: $t"; Write-Host $s; Add-Content $log $s }

# старые петли night.cmd и их мозги (opencode)
$loops = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | ? { $_.CommandLine -match 'night(-[\d-]+)?\.cmd' })
# мозги ищем по тексту задания: так находятся и те, чья петля уже закрыта
$brains = @(Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | ? { $_.CommandLine -match 'brain of the Minecraft bot (FlyTest|FlyBot_01)' })
Log "старых петель: $($loops.Count), мозгов: $($brains.Count)"

Remove-Item $flag -Force -ErrorAction SilentlyContinue
# передача опыта: хвост журнала старого мозга (он ещё играет) → data\handover.md, новый прочтёт при старте (как в петле night.cmd)
$oldLog = Get-ChildItem "$fb\data\night.log", "$fb\data\night-*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($oldLog) { & node "$fb\tools\handover_note.js" $oldLog.FullName "$fb\data\handover.md" 2>$null | Out-Null; Log "передача: data\handover.md из $($oldLog.Name)" }
# петлю закрываем без дочерних процессов: старый мозг доигрывает, но заново его никто не запустит
foreach ($l in $loops) { taskkill /PID $l.ProcessId /F | Out-Null }

# новая петля, отвязанная от этого окна. night.log занят старым мозгом (cmd не сможет в него писать
# и мозг не стартует), поэтому новая петля — копия night.cmd со своим журналом.
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$loop  = "$fb\data\night-$stamp.cmd"
$body  = [IO.File]::ReadAllText("$fb\night.cmd").Replace('%~dp0', "$fb\").Replace('data\night.log', "data\night-$stamp.log")
[IO.File]::WriteAllText($loop, $body, [Text.Encoding]::Default)
Get-ChildItem "$fb\data\night-*.cmd" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 5 | Remove-Item -Force
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = "cmd.exe /c start `"flybot-night-brain`" /min cmd /c `"$loop`""; CurrentDirectory = $fb } | Out-Null
Log "журнал нового мозга: data\night-$stamp.log"
Log 'новый мозг запущен, жду ready.flag или его первую команду телу (до 6 мин)'

$deadline = (Get-Date).AddMinutes(6)
$why = $null
while (-not ($why = Test-BrainReady $flag "$fb\data\night-$stamp.log") -and (Get-Date) -lt $deadline) { Start-Sleep 5 }
if ($why) { Log "новый мозг готов: $why" } else { Log 'флажка нет за 6 мин — всё равно отключаю старый, чтобы не было двух мозгов' }

foreach ($b in $brains) { taskkill /PID $b.ProcessId /T /F | Out-Null }
Log "старый мозг отключён ($($brains.Count))"
Start-Sleep 3
