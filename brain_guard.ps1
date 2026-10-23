# Сторож петли мозга. Запускается из night.cmd (start /b) и живёт, пока жива его петля (родительский cmd).
# 1) Зависание: если журнал мозга не растёт SilenceMin минут — убивает мозг (opencode), петля запустит новый.
#    Так 21.10 DeepSeek провисел 40 мин: процесс жив, модель не отвечает, петля не перезапускала.
# 2) Инженер: мозг кладёт заявку brain\skill_requests\<имя>.md — сторож запускает отдельную модель (EngModel),
#    она пишет brain\learned\<имя>.js, проверяет через :3200/check и отвечает в <имя>.done.md.
# 3) Учитель: lib\teacher_triggers.js находит случаи (простой стройки — главный, смерть, почти-смерть, провал дважды, застряла, хозяин) и
#    склеивает всплески; сторож запускает учителя на один случай за раз, отчёт — data\teacher\<id>-<тип>.md.
# 4) Правка ядра: запрос из brain\core_requests.md, который хозяин разрешил в аудите, берёт инженер (lib\core_requests.js:
#    снимок файлов и тесты «до» → инженер правит со своим конфигом brain\opencode.core.json → тесты «после»; стало хуже — откат
#    его правки и запись почему в data\core_tasks\<id>.result.md). Разрешённые запросы идут раньше заявок на навыки, инженер один.
# 5) Помощник: когда у учителя нет случаев, модель учителя берёт заявку на навык параллельно инженеру (конфиг brain\opencode.helper.json:
#    только brain\learned и ответ в skill_requests). Не берёт ядро, behavior_* и «переделать»; появился случай — доделывает и уступает учителю.
# 6) Тело: раз в минуту отдельным процессом tools\body_autorestart.js — перезапускает тело в безопасный момент, чтобы включились
#    сделанные правки ядра (bot.js, lib\, behavior\); не встало — откатывает правку. Пока лежит data\body_restart.lock, правку ядра не берём.
# Модели учителя и инженера берутся из data\models.json (вкладка «Модели» в аудите) ПРИ КАЖДОМ запуске — через models_config.js.
# Параметров вроде -EngModel/-TeachModel больше нет: источник один.
param(
  [string]$Log,
  [int]$SilenceMin = 10,
  [int]$EngTimeoutMin = 10,     # снимать инженера, только если его журнал молчит столько минут (жёсткого предела нет)
  [int]$TeachTimeoutMin = 10,   # то же для учителя
  [int]$LoopPid = 0   # перезапуск сторожа вручную: pid окна night.cmd (иначе петля — родительский процесс)
)
$fb   = 'C:\Users\user\flybot'
$req  = "$fb\brain\skill_requests"
$glog = "$fb\data\guard.log"
$oclog = "$env:USERPROFILE\.local\share\opencode\log\opencode.log"
$Backoff = 2, 5, 10, 30   # пауза после лимита запросов (429), мин: каждый следующий подряд — дольше
function GLog($t) { Add-Content $glog "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $t" -Encoding UTF8 }

# Модель роли ('teacher' | 'engineer') из data\models.json — читается заново при каждом запуске роли.
# Если node не ответил или вернул не id модели — последнее известное значение, а при самом первом сбое — запасное.
$ModelFallback = @{ teacher = 'opencode/mimo-v2.6-flash-free'; engineer = 'opencode/deepseek-v4.1-flash-free' }
$ModelLast = @{}
function RoleModel([string]$role) {
  $m = $null
  try { $m = (& node "$fb\models_config.js" get $role 2>$null | Select-Object -First 1) } catch {}
  if ($m -and ([string]$m).Trim() -match '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._:@+-]*)+$') { $ModelLast[$role] = ([string]$m).Trim() }
  elseif (-not $ModelLast[$role]) { GLog "модель $role`: models_config.js не ответил, беру запасную"; $ModelLast[$role] = $ModelFallback[$role] }
  else { GLog "модель $role`: models_config.js не ответил, оставляю прежнюю ($($ModelLast[$role]))" }
  $ModelLast[$role]
}

$loopPid = if ($LoopPid) { $LoopPid } else { (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId }
GLog "сторож запущен: петля $loopPid, журнал $Log, тишина $SilenceMin мин, инженер $(RoleModel 'engineer'), учитель $(RoleModel 'teacher') (модели берутся из data\models.json при каждом запуске роли)"
New-Item -ItemType Directory -Force $req | Out-Null

# Учитель и инженер прошлого сторожа (если его перезапустили) остались без хозяина — убрать, их случаи вернутся в очередь.
foreach ($o in @(Get-CimInstance Win32_Process | ? { $_.Name -in 'cmd.exe', 'opencode.exe' -and $_.CommandLine -match 'You are the (teacher|engineer) of the Minecraft bot' })) {
  taskkill /PID $o.ProcessId /T /F 2>$null | Out-Null
  GLog "сирота от прошлого сторожа убран (pid $($o.ProcessId))"
}

# opencode на 429 «Rate limit exceeded» не повторяет запрос и молча висит до тайм-аута.
# Признак: последняя запись этой модели в журнале opencode — такой отказ после старта, и новых запросов нет 45 с.
function LimitStuck([string]$model, [datetime]$since) {
  $m = [regex]::Escape(($model -split '/')[-1])
  try { $fs = [IO.File]::Open($oclog, 'Open', 'Read', 'ReadWrite') } catch { return $false }
  try { $n = [int][Math]::Min($fs.Length, 400KB); [void]$fs.Seek(-$n, 'End'); $buf = New-Object byte[] $n; [void]$fs.Read($buf, 0, $n) } finally { $fs.Close() }
  $last = [Text.Encoding]::UTF8.GetString($buf) -split "`n" | ? { $_ -match "modelID=$m " } | Select-Object -Last 1
  if (-not $last -or $last -notmatch 'Rate limit exceeded|Free usage limit reached' -or $last -notmatch 'timestamp=(\S+)') { return $false }
  $t = [DateTime]::Parse($Matches[1]).ToUniversalTime()
  ($t -ge $since.ToUniversalTime()) -and (([DateTime]::UtcNow - $t).TotalSeconds -ge 45)
}
function LimitPause([int]$hits) { $Backoff[[Math]::Min($hits, $Backoff.Count - 1)] }

$seen = @{}
function TechErr([string]$path, [long]$from) {   # технический сбой в журнале роли (с позиции from): модель недоступна или упала
  try { $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite') } catch { return $null }
  try { $at = [Math]::Max($from, $fs.Length - 2MB); $n = [int]($fs.Length - $at); if ($n -le 0) { return $null }; [void]$fs.Seek($at, 'Begin'); $buf = New-Object byte[] $n; [void]$fs.Read($buf, 0, $n) } finally { $fs.Close() }
  $m = [regex]::Match([Text.Encoding]::UTF8.GetString($buf), 'UnknownError|Unexpected server error|ProviderModelNotFound|Model not found')
  if ($m.Success) { $m.Value } else { $null }
}
function IdleMin([string]$path, [datetime]$since) {   # сколько минут журнал роли не растёт (размер — настоящий, как в LogSize)
  $len = try { $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite'); try { $fs.Length } finally { $fs.Close() } } catch { -1 }
  $s = $seen[$path]
  if (-not $s -or $s.since -ne $since) { $s = @{ len = $len; at = $since; since = $since }; $seen[$path] = $s }
  if ($len -ne $s.len) { $s.len = $len; $s.at = Get-Date }
  ((Get-Date) - $s.at).TotalMinutes
}

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
$hlp = $null   # текущий запуск помощника (модель учителя на заявке навыка): как $eng
$engWait = $tchWait = $hlpWait = Get-Date; $engHits = $tchHits = $hlpHits = 0   # пауза после лимита и сколько лимитов подряд

# Заявка на навык, которую можно взять (ставит замок <имя>.working). Помощнику — без behavior_* и без «переделать».
function PickReq([bool]$helper) {
  foreach ($f in Get-ChildItem "$req\*.md" -ErrorAction SilentlyContinue | ? { $_.Name -notmatch '\.done\.md$' } | Sort-Object LastWriteTime) {
    $name = $f.BaseName
    if ($name -notmatch '^[a-z0-9_]+$') { continue }
    $done = "$req\$name.done.md"; $lock = "$req\$name.working"
    if ((Test-Path $done) -and (Get-Item $done).LastWriteTime -ge $f.LastWriteTime) { continue }   # уже отвечено, заявку не меняли
    if ((Test-Path $lock) -and ((Get-Date) - (Get-Item $lock).LastWriteTime).TotalMinutes -lt ($EngTimeoutMin + 5)) { continue }  # берёт другой
    if ($helper) {
      if ($name -match '^behavior_') { continue }   # поведение одно на всю муху — только инженер
      $txt = try { Get-Content $f.FullName -Raw -Encoding UTF8 } catch { '' }
      if ($txt -match 'переделать|переделка') { continue }   # переделка после провала — инженеру
    }
    Set-Content $lock (Get-Date -Format s)
    return $name
  }
  $null
}
# Запуск исполнителя на заявку навыка: инженер (opencode.engineer.json) или помощник (opencode.helper.json)
function StartSkill([string]$name, [string]$model, [string]$cfg) {
  $prompt = "You are the engineer of the Minecraft bot FlyBot_01. Read brain/ENGINEER_PROMPT.md and follow it exactly. Request file: brain/skill_requests/$name.md"
  $elog = "$fb\data\engineer-$name.log"
  $elAt = try { (Get-Item $elog -ErrorAction Stop).Length } catch { 0 }   # журнал дописывается: техсбой ищем только в этом запуске
  # свой конфиг opencode; проектный opencode.json не подмешивать
  $p = Start-Process cmd.exe -ArgumentList '/c', "set `"OPENCODE_CONFIG=$cfg`"&& set `"OPENCODE_DISABLE_PROJECT_CONFIG=1`"&& opencode run --auto -m $model `"$prompt`" 2>&1 | node `"$fb\tools\tstamp.js`" >> `"$elog`"" `
         -WorkingDirectory $fb -WindowStyle Hidden -PassThru
  @{ proc = $p; name = $name; started = Get-Date; model = $model; log = $elog; logAt = $elAt }
}
# Итог заявки навыка: $true — запуск закончен (ответ есть, техсбой — заявка снова в очереди, или завис)
function SkillEnd($e, [string]$who) {
  $done = "$req\$($e.name).done.md"
  $over = (IdleMin $e.log $e.started) -ge $EngTimeoutMin
  if (-not ($e.proc.HasExited -or $over)) { return $false }
  if (-not $e.proc.HasExited) { taskkill /PID $e.proc.Id /T /F | Out-Null; GLog "$who`: $($e.name) — завис: журнал молчит $EngTimeoutMin мин" }
  # технический сбой (модель упала или недоступна, завис) — это не ответ: заявка снова в очередь, до 3 раз подряд
  $tf = "$req\$($e.name).tech"; $retry = $false
  $answered = (Test-Path $done) -and (Get-Item $done).LastWriteTime -ge $e.started
  if (-not $answered) {
    $tech = if ($over) { 'завис' } else { TechErr $e.log $e.logAt }
    $tries = 0; if (Test-Path $tf) { $tries = [int](Get-Content $tf -TotalCount 1) }
    if ($tech -and $tries -lt 3) { Set-Content $tf ($tries + 1); $retry = $true; GLog "$who`: $($e.name) — техсбой ($tech), заявка в очереди, повтор $($tries + 1) из 3" }
    else { Set-Content $done "# $($e.name): не готово`r`nИнженер не ответил (упал или завис: журнал молчал $EngTimeoutMin мин). Журнал: data\engineer-$($e.name).log. Можно уточнить заявку и сохранить её заново — инженер возьмётся снова." -Encoding UTF8 }
  }
  if ($answered -and $e.helper) { Add-Content $done "`r`nсделал: помощник (модель учителя $($e.model))" -Encoding UTF8 }
  if (-not $retry) { Remove-Item $tf -Force -ErrorAction SilentlyContinue }
  Remove-Item "$req\$($e.name).working" -Force -ErrorAction SilentlyContinue
  if (-not $retry) { GLog "$who`: $($e.name) — закончил" }
  $true
}
function PendingCases {   # ждущие случаи учителя (ошибка чтения — считаем, что есть: учитель важнее)
  try { $q = Get-Content "$fb\data\teacher_queue.json" -Raw -Encoding UTF8 | ConvertFrom-Json; @($q.cases | ? { $_.status -eq 'pending' }).Count } catch { 1 }
}
function Teach([string[]]$a) {   # lib\teacher_triggers.js: ответ — одна строка JSON (ASCII)
  try { $out = & node "$fb\lib\teacher_triggers.js" @a 2>$null | Select-Object -Last 1; if ($out) { $out | ConvertFrom-Json } } catch { GLog "учитель: очередь не ответила: $($_.Exception.Message)"; $null }
}
$r = Teach @('release'); if ($r -and @($r.released).Count) { GLog "учитель: вернул в очередь $(@($r.released) -join ', ') (от прошлого сторожа)" }
function Core([string[]]$a) {   # lib\core_requests.js: ответ — одна строка JSON (ASCII)
  try { $out = & node "$fb\lib\core_requests.js" @a 2>$null | Select-Object -Last 1; if ($out) { $out | ConvertFrom-Json } } catch { GLog "ядро: lib\core_requests.js не ответил: $($_.Exception.Message)"; $null }
}
$r = Core @('release'); if ($r -and @($r.released).Count) { GLog "ядро: правка от прошлого сторожа $(@($r.released) -join ', ') — $(@($r.results) -join ', ')" }

$bodyRs = $null; $bodyRsAt = Get-Date
while ($true) {
  Start-Sleep 30
  if (-not (Get-Process -Id $loopPid -ErrorAction SilentlyContinue)) { GLog 'петля закрыта — сторож выходит'; break }

  # --- 6. перезапуск тела ради правок ядра (свой процесс: сбой там сторожа не роняет) ---
  if ((-not $bodyRs -or $bodyRs.HasExited) -and (Get-Date) -ge $bodyRsAt) {
    try { $bodyRs = Start-Process node -ArgumentList "`"$fb\tools\body_autorestart.js`"", '--log', "`"$Log`"" -WorkingDirectory $fb -WindowStyle Hidden -PassThru }
    catch { GLog "тело: tools\body_autorestart.js не запустился: $($_.Exception.Message)" }
    $bodyRsAt = (Get-Date).AddMinutes(1)
  }

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
  if ($eng -and -not $eng.proc.HasExited -and (LimitStuck $eng.model $eng.started)) {
    taskkill /PID $eng.proc.Id /T /F | Out-Null
    if ($eng.core) { $r = Core @('finish', $eng.name, 'limit'); GLog "ядро: $($eng.name) — $($r.status)" }
    Remove-Item "$req\$($eng.name).working" -Force -ErrorAction SilentlyContinue   # заявка без ответа — возьмётся снова
    $min = LimitPause $engHits; $engHits++; $engWait = (Get-Date).AddMinutes($min)
    GLog "инженер: $($eng.name) — лимит запросов модели, повтор через $min мин"
    $eng = $null
  }
  if ($eng -and $eng.core) {   # правка ядра: итог решают тесты (lib\core_requests.js finish)
    $over = (IdleMin $eng.log $eng.started) -ge $EngTimeoutMin
    if ($eng.proc.HasExited -or $over) {
      $how = 'ok'
      if (-not $eng.proc.HasExited) { taskkill /PID $eng.proc.Id /T /F | Out-Null; $how = 'timeout'; GLog "ядро: $($eng.name) — завис: журнал молчит $EngTimeoutMin мин" }
      $r = Core @('finish', $eng.name, $how)
      GLog "ядро: $($eng.name) — $($r.status) (изменено файлов: $($r.changed); новые падения тестов: $(@($r.worse) -join ', '))"
      $eng = $null; $engHits = 0
    }
  }
  elseif ($eng) {
    if (SkillEnd $eng 'инженер') { $eng = $null; $engHits = 0 }
  }
  $bodyLock = Get-Item "$fb\data\body_restart.lock" -ErrorAction SilentlyContinue
  $bodyBusy = $bodyLock -and ((Get-Date) - $bodyLock.LastWriteTime).TotalMinutes -lt 15
  if (-not $eng -and -not $bodyBusy -and (Get-Date) -ge $engWait) {
    $c = Core @('take')   # сначала разрешённые хозяином правки ядра (снимок и тесты «до» — около минуты)
    if ($c -and $c.id) {
      $engModel = RoleModel 'engineer'
      $prompt = "You are the engineer of the Minecraft bot FlyBot_01. Read brain/ENGINEER_PROMPT.md and follow it exactly (section about core edits). Core task file: $($c.taskFile)"
      $elog = "$fb\data\engineer-core-$($c.id).log"
      # свой конфиг: правка ядра разрешена (кроме судьи lib\referee.js), node и npm test для проверки; проектный не подмешивать
      $p = Start-Process cmd.exe -ArgumentList '/c', "set `"OPENCODE_CONFIG=$fb\brain\opencode.core.json`"&& set `"OPENCODE_DISABLE_PROJECT_CONFIG=1`"&& opencode run --auto -m $engModel `"$prompt`" 2>&1 | node `"$fb\tools\tstamp.js`" >> `"$elog`"" `
             -WorkingDirectory $fb -WindowStyle Hidden -PassThru
      $eng = @{ proc = $p; name = $c.id; core = $true; started = Get-Date; model = $engModel; log = $elog }
      GLog "ядро: инженер взял разрешённый запрос $($c.id) (pid $($p.Id), модель $engModel)"
    }
  }
  if (-not $eng -and (Get-Date) -ge $engWait) {
    $name = PickReq $false
    if ($name) {
      $engModel = RoleModel 'engineer'   # заново для каждой заявки: смена в аудите подхватывается со следующей
      # у инженера свой конфиг opencode (ему можно писать в behavior/, мозгу — нет)
      $eng = StartSkill $name $engModel "$fb\brain\opencode.engineer.json"
      GLog "инженер: взял заявку $name (pid $($eng.proc.Id), модель $engModel)"
    }
  }

  # --- 3. учитель ---
  $null = Teach @('scan')
  if ($tch -and -not $tch.proc.HasExited -and (LimitStuck $tch.model $tch.started)) {
    taskkill /PID $tch.proc.Id /T /F | Out-Null
    $null = Teach @('finish', $tch.id, 'limit')   # случай обратно в очередь, без штрафа
    $min = LimitPause $tchHits; $tchHits++; $tchWait = (Get-Date).AddMinutes($min)
    GLog "учитель: $($tch.id) — лимит запросов модели, случай в очереди, повтор через $min мин"
    $tch = $null
  }
  if ($tch) {
    $over = (IdleMin $tch.log $tch.started) -ge $TeachTimeoutMin
    if ($tch.proc.HasExited -or $over) {
      $how = 'ok'
      if (-not $tch.proc.HasExited) { taskkill /PID $tch.proc.Id /T /F | Out-Null; $how = 'timeout'; GLog "учитель: $($tch.id) — завис: журнал молчит $TeachTimeoutMin мин" }
      $r = Teach @('finish', $tch.id, $how)
      GLog "учитель: $($tch.id) — закончил ($($r.status))"
      $tch = $null; $tchHits = 0
    }
  }
  # --- 4. помощник: модель учителя на заявке навыка, пока у учителя нет случаев ---
  if ($hlp -and -not $hlp.proc.HasExited -and (LimitStuck $hlp.model $hlp.started)) {
    taskkill /PID $hlp.proc.Id /T /F | Out-Null
    Remove-Item "$req\$($hlp.name).working" -Force -ErrorAction SilentlyContinue   # заявка без ответа — возьмётся снова
    $min = LimitPause $hlpHits; $hlpHits++; $hlpWait = (Get-Date).AddMinutes($min)
    GLog "помощник: $($hlp.name) — лимит запросов модели, повтор через $min мин"
    $hlp = $null
  }
  if ($hlp -and (SkillEnd $hlp 'помощник')) { $hlp = $null; $hlpHits = 0 }
  if (-not $hlp -and -not $tch -and (Get-Date) -ge $hlpWait -and (Get-Date) -ge $tchWait -and (PendingCases) -eq 0) {
    $name = PickReq $true
    if ($name) {
      $hlpModel = RoleModel 'teacher'
      $hlp = StartSkill $name $hlpModel "$fb\brain\opencode.helper.json"; $hlp.helper = $true
      GLog "помощник (модель учителя): взял заявку $name (pid $($hlp.proc.Id), модель $hlpModel)"
    }
  }

  if (-not $tch -and -not $hlp -and (Get-Date) -ge $tchWait) {   # помощник занят — учитель ждёт, пока тот доделает заявку
    $c = Teach @('take')
    if ($c -and $c.id) {
      $teachModel = RoleModel 'teacher'   # заново для каждого случая: смена в аудите подхватывается со следующего
      $prompt = "You are the teacher of the Minecraft bot FlyBot_01. Read brain/TEACHER_PROMPT.md and follow it exactly. Case file: $($c.caseFile)"
      $tlog = "$fb\data\teacher-$($c.id).log"
      # у учителя свой конфиг opencode (пишет только заявки и отчёты; без /do); проектный не подмешивать
      $p = Start-Process cmd.exe -ArgumentList '/c', "set `"OPENCODE_CONFIG=$fb\brain\opencode.teacher.json`"&& set `"OPENCODE_DISABLE_PROJECT_CONFIG=1`"&& opencode run --auto -m $teachModel `"$prompt`" 2>&1 | node `"$fb\tools\tstamp.js`" >> `"$tlog`"" `
             -WorkingDirectory $fb -WindowStyle Hidden -PassThru
      $tch = @{ proc = $p; id = $c.id; started = Get-Date; model = $teachModel; log = $tlog }
      GLog "учитель: взял случай $($c.id) ($($c.type), pid $($p.Id), модель $teachModel)"
    }
  }
}
