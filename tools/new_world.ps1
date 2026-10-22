# Новый мир (тот же сид): память о старом мире -> data\archive\world-<дата>\, навыки остаются.
# Запуск: new_world.cmd (сброс) или new_world.cmd check (только показать, что уйдёт в архив).
# Уходит: карта и метки, свои блоки, дни/смерти/учёт, журналы, разборы учителя, блокнот мозга.
# Остаётся: brain\learned, skills_stats.json, runner.log, variants.json, experience.json, behavior_versions, модели, промпты, уроки.
param([string]$Mode = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$check = $Mode -eq 'check'

# муха и исполнитель должны быть выключены: иначе они перезапишут файлы из памяти
foreach ($port in 3199, 3200) {
  $c = New-Object Net.Sockets.TcpClient
  try { if ($c.ConnectAsync('127.0.0.1', $port).Wait(500)) { if (-not $check) { throw "порт $port занят - сначала останови муху и мозг (закрой окна night.cmd и бота)" } else { "ВНИМАНИЕ: порт $port занят, перед сбросом всё выключить" } } } catch [AggregateException] {} finally { $c.Dispose() }
}

$dataFiles = 'world.json','waypoints.json','own_blocks.json','daylog.json','days.log','deaths.log','stats.json','killers.json','ledger.json',
  'critic.json','critic_report.md','handover.md','handover.log','ask_brain.md','todo_next.md','teacher_queue.json','notes.md.bak',
  'events.log','guard.log','night.log','flybot.out.log','runner.out.log'
$dataGlobs = 'night-*.log','night-*.cmd','teacher-*.log','engineer-*.log','flytest*.log'
$dataDirs = 'blackbox','teacher_cases','teacher'

$items = @()
foreach ($f in $dataFiles) { if (Test-Path "$root\data\$f") { $items += "data\$f" } }
foreach ($g in $dataGlobs) { Get-ChildItem "$root\data" -Filter $g -File | ForEach-Object { $items += "data\$($_.Name)" } }
foreach ($d in $dataDirs) { if (Test-Path "$root\data\$d") { $items += "data\$d" } }
if (Test-Path "$root\brain\notes.md") { $items += 'brain\notes.md' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$arch = "data\archive\world-$stamp"
if ($check) { "В архив $arch уйдёт:"; $items | ForEach-Object { "  $_" }; return }

foreach ($i in $items) {
  $dst = Join-Path "$root\$arch" $i
  New-Item -ItemType Directory -Force (Split-Path $dst -Parent) | Out-Null
  Move-Item "$root\$i" $dst
}
foreach ($d in $dataDirs) { New-Item -ItemType Directory -Force "$root\data\$d" | Out-Null }

# учитель: пустая очередь без разовой задачи migrate; старую историю исполнителя не разбирать
$runnerSize = 0; if (Test-Path "$root\brain\runner.log") { $runnerSize = (Get-Item "$root\brain\runner.log").Length }
$q = [ordered]@{ version = 1; created = (Get-Date).ToUniversalTime().ToString('o'); seq = 0; offsets = @{ events = 0; runner = $runnerSize };
  blackboxSeen = @(); fails = @{}; recent = @(); cooldown = @{}; suppressed = 0; dropped = 0; cases = @() }
[IO.File]::WriteAllText("$root\data\teacher_queue.json", ($q | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))

$date = Get-Date -Format 'dd.MM.yyyy HH:mm'
$notes = @"
# Блокнот мозга
Читай целиком в начале сессии. Обновляй по ходу — коротко.

## НОВЫЙ МИР ($date)
Мир создан заново с тем же сидом: рельеф, руды, деревни — на прежних местах.
Всё построенное исчезло, инвентарь пустой, меток и базы нет. Старый блокнот — $arch\brain\notes.md.

## Текущая цель
"@
[IO.File]::WriteAllText("$root\brain\notes.md", $notes, (New-Object Text.UTF8Encoding $false))

"Готово: старый мир в $arch ($($items.Count) шт.), блокнот и очередь учителя чистые. Навыки не тронуты."
