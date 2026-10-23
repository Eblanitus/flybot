# Перезапуск тела мухи (bot.js) — чтобы включились правки ядра (lib/, bot.js). Мозг, сторож и night.cmd не трогает.
# Командная строка тела — та же, что в night.cmd. Тело запускается в своём окне и живёт после закрытия этого.
$fb = $PSScriptRoot
$cmdline = "cd /d $fb && node bot.js localhost 25565 FlyBot_01 3199 >> data\flybot.out.log 2>&1"

# опасный момент — предупредить (день: HP >= 10, на земле, без врагов; ночь: в укрытии, HP >= 10, на земле)
try {
  $s = Invoke-RestMethod http://127.0.0.1:3199/snapshot -TimeoutSec 5
  $enemies = @($s.eyes.enemies).Count
  $safe = $s.health -ge 10 -and $s.onGround -and (($s.timeOfDay -eq 'day' -and $enemies -eq 0) -or $s.sheltered)
  Write-Host "Сейчас: $($s.timeOfDay), HP $([int]$s.health), врагов рядом $enemies, укрытие $($s.sheltered), дело: $($s.autopilot.doing)"
  if (-not $safe) {
    $a = Read-Host "Момент небезопасный (может погибнуть при выходе). Перезапустить всё равно? (y/n)"
    if ($a -notmatch '^[yYдД]') { Write-Host "Отменено."; Start-Sleep 2; exit 0 }
  }
} catch { Write-Host "Тело не отвечает — просто запускаю." }

$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'bot\.js localhost' }
foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }
if ($p) { Write-Host "Тело остановлено (pid $($p.ProcessId -join ', '))."; Start-Sleep 3 }

Start-Process cmd.exe -ArgumentList '/c', $cmdline -WorkingDirectory $fb -WindowStyle Minimized
Write-Host "Запускаю тело..."
$ok = $false
for ($i = 0; $i -lt 24; $i++) {
  Start-Sleep 5
  try { $h = Invoke-RestMethod http://127.0.0.1:3199/snapshot -TimeoutSec 5; if ($h.ready) { $ok = $true; break } } catch {}
}
if ($ok) { Write-Host "Муха в мире: HP $([int]$h.health), позиция $([int]$h.position.x) $([int]$h.position.y) $([int]$h.position.z)." }
else { Write-Host "За 2 мин муха не вошла в мир. Смотри data\flybot.out.log:"; Get-Content "$fb\data\flybot.out.log" -Tail 8 -Encoding UTF8 }
Start-Sleep 8
