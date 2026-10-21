# Сторож петли мозга. Запускается из night.cmd (start /b) и живёт, пока жива его петля (родительский cmd).
# 1) Зависание: если журнал мозга не растёт SilenceMin минут — убивает мозг (opencode), петля запустит новый.
#    Так 21.10 DeepSeek провисел 40 мин: процесс жив, модель не отвечает, петля не перезапускала.
# 2) Инженер: мозг кладёт заявку brain\skill_requests\<имя>.md — сторож запускает отдельную модель (EngModel),
#    она пишет brain\learned\<имя>.js, проверяет через :3200/check и отвечает в <имя>.done.md.
# 3) Учитель: lib\teacher_triggers.js находит случаи (смерть, почти-смерть, провал дважды, застряла, итог дня, хозяин) и
#    склеивает всплески; сторож запускает учителя (TeachModel) на один случай за раз, отчёт — data\teacher\<id>-<тип>.md.
param(
  [string]$Log,
  [int]$SilenceMin = 10,
  [string]$EngModel = 'opencode/deepseek-v4.1-flash-free',
  [int]$EngTimeoutMin = 15,
  [string]$TeachModel = 'opencode/deepseek-v4.1-flash-free',
  [int]$TeachTimeoutMin = 20
)
$fb   = 'C:\Users\user\flybot'
$req  = "$fb\brain\skill_requests"
$glog = "$fb\data\guard.log"
function GLog($t) { Add-Content $glog "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $t" -Encoding UTF8 }

$loopPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
GLog "сторож запущен: петля $loopPid, журнал $Log, тишина $SilenceMin мин, инженер $EngModel"
New-Item -ItemType Directory -Force $req | Out-Null

function LogSize {   # настоящий размер: у открытого на запись файла дата/размер в каталоге отстают
  try { $fs = [IO.File]::Open($Log, 'Open', 'Read', 'ReadWrite'); try { $fs.Length } finally { $fs.Close() } } catch { -1 }
}
function BrainProcs {  # opencode-мозги среди потомков нашей петли (инженера не трогаем: у него другой текст задания)
  $all = @(Get-CimInstance Win32_Process)
  $kids = @{}; foreach ($p in $all) { $kids[[int]$p.ParentProcessId] += @($p) }
  $out = @(); $queue = New-Object System.Collections.Queue; $queue.Enqueue([int]$loopPid)
  while ($queue.Count) { foreach ($c in @($kids[$queue.Dequeue()])) { if (-not $c) { continue }
    if ($c.Name -eq 'opencode.exe' -and $c.CommandLine -match 'brain of the Minecraft bot (FlyTest|FlyBot_01)') { $out += $c }
    $queue.Enqueue([int]$c.ProcessId) } }
  $out
}

$lastSize = LogSize; $lastGrow = Get-Date
$eng = $null   # текущий запуск инженера: @{ proc; name; started }
$tch = $null   # текущий запуск учителя: @{ proc; id; started }
function Teach([string[]]$a) {   # lib\teacher_triggers.js: ответ — одна строка JSON (ASCII)
  try { $out = & node "$fb\lib\teacher_triggers.js" @a 2>$null | Select-Object -Last 1; if ($out) { $out | ConvertFrom-Json } } catch { GLog "учитель: очередь не ответила: $($_.Exception.Message)"; $null }
}

while ($true) {
  Start-Sleep 30
  if (-not (Get-Process -Id $loopPid -ErrorAction SilentlyContinue)) { GLog 'петля закрыта — сторож выходит'; break }

  # --- 1. зависание мозга ---
  $size = LogSize
  if ($size -ne $lastSize) { $lastSize = $size; $lastGrow = Get-Date }
  $silent = ((Get-Date) - $lastGrow).TotalMinutes
  if ($silent -ge $SilenceMin) {
    $brains = @(BrainProcs)
    if ($brains.Count) {
      GLog ("журнал молчит {0:N0} мин — мозг завис, убиваю ({1})" -f $silent, ($brains.ProcessId -join ','))
      foreach ($b in $brains) { taskkill /PID $b.ProcessId /T /F | Out-Null }
      Add-Content $Log "`r`n[guard $(Get-Date -Format 'HH:mm:ss')] мозг молчал $([int]$silent) мин — перезапуск" -Encoding UTF8
    }
    $lastGrow = Get-Date
  }

  # --- 2. инженер ---
  if ($eng) {
    $done = "$req\$($eng.name).done.md"
    $over = ((Get-Date) - $eng.started).TotalMinutes -ge $EngTimeoutMin
    if ($eng.proc.HasExited -or $over) {
      if (-not $eng.proc.HasExited) { taskkill /PID $eng.proc.Id /T /F | Out-Null; GLog "инженер: $($eng.name) — тайм-аут $EngTimeoutMin мин" }
      if (-not (Test-Path $done) -or (Get-Item $done).LastWriteTime -lt $eng.started) {
        Set-Content $done "# $($eng.name): не готово`r`nИнженер не ответил (упал или тайм-аут $EngTimeoutMin мин). Журнал: data\engineer-$($eng.name).log. Можно уточнить заявку и сохранить её заново — инженер возьмётся снова." -Encoding UTF8
      }
      Remove-Item "$req\$($eng.name).working" -Force -ErrorAction SilentlyContinue
      GLog "инженер: $($eng.name) — закончил"
      $eng = $null
    }
  }
  if (-not $eng) {
    foreach ($f in Get-ChildItem "$req\*.md" -ErrorAction SilentlyContinue | ? { $_.Name -notmatch '\.done\.md$' } | Sort-Object LastWriteTime) {
      $name = $f.BaseName
      if ($name -notmatch '^[a-z0-9_]+$') { continue }
      $done = "$req\$name.done.md"; $lock = "$req\$name.working"
      if ((Test-Path $done) -and (Get-Item $done).LastWriteTime -ge $f.LastWriteTime) { continue }   # уже отвечено, заявку не меняли
      if ((Test-Path $lock) -and ((Get-Date) - (Get-Item $lock).LastWriteTime).TotalMinutes -lt ($EngTimeoutMin + 5)) { continue }  # берёт другой сторож
      Set-Content $lock (Get-Date -Format s)
      $prompt = "You are the engineer of the Minecraft bot FlyBot_01. Read brain/ENGINEER_PROMPT.md and follow it exactly. Request file: brain/skill_requests/$name.md"
      $elog = "$fb\data\engineer-$name.log"
      # у инженера свой конфиг opencode (ему можно писать в behavior/, мозгу — нет); проектный opencode.json не подмешивать
      $p = Start-Process cmd.exe -ArgumentList '/c', "set `"OPENCODE_CONFIG=$fb\brain\opencode.engineer.json`"&& set `"OPENCODE_DISABLE_PROJECT_CONFIG=1`"&& opencode run --auto -m $EngModel `"$prompt`" >> `"$elog`" 2>&1" `
             -WorkingDirectory $fb -WindowStyle Hidden -PassThru
      $eng = @{ proc = $p; name = $name; started = Get-Date }
      GLog "инженер: взял заявку $name (pid $($p.Id))"
      break
    }
  }

  # --- 3. учитель ---
  $null = Teach @('scan')
  if ($tch) {
    $over = ((Get-Date) - $tch.started).TotalMinutes -ge $TeachTimeoutMin
    if ($tch.proc.HasExited -or $over) {
      $how = 'ok'
      if (-not $tch.proc.HasExited) { taskkill /PID $tch.proc.Id /T /F | Out-Null; $how = 'timeout'; GLog "учитель: $($tch.id) — тайм-аут $TeachTimeoutMin мин" }
      $r = Teach @('finish', $tch.id, $how)
      GLog "учитель: $($tch.id) — закончил ($($r.status))"
      $tch = $null
    }
  }
  if (-not $tch) {
    $c = Teach @('take')
    if ($c -and $c.id) {
      $prompt = "You are the teacher of the Minecraft bot FlyBot_01. Read brain/TEACHER_PROMPT.md and follow it exactly. Case file: $($c.caseFile)"
      $tlog = "$fb\data\teacher-$($c.id).log"
      # у учителя свой конфиг opencode (пишет только учебник, журнал уроков, заявки и отчёты; без /do); проектный не подмешивать
      $p = Start-Process cmd.exe -ArgumentList '/c', "set `"OPENCODE_CONFIG=$fb\brain\opencode.teacher.json`"&& set `"OPENCODE_DISABLE_PROJECT_CONFIG=1`"&& opencode run --auto -m $TeachModel `"$prompt`" >> `"$tlog`" 2>&1" `
             -WorkingDirectory $fb -WindowStyle Hidden -PassThru
      $tch = @{ proc = $p; id = $c.id; started = Get-Date }
      GLog "учитель: взял случай $($c.id) ($($c.type), pid $($p.Id))"
    }
  }
}
