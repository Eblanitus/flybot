# Определение готовности нового мозга при передаче управления (используется restart_brain.ps1).
# Возвращает строку-причину ('ready.flag' | 'первая команда телу: ...') или $null.
# Команда телу = строка вызова инструмента в журнале нового мозга («$ curl.exe ... 127.0.0.1:3199/do|cmd ...»);
# чтение (/snapshot, /events, /health) и просто текст промпта не считаются.
function Test-BrainReady([string]$flag, [string]$brainLog) {
  if (Test-Path $flag) { return 'ready.flag' }
  if ($brainLog -and (Test-Path $brainLog)) {
    $re = '\$\s.*(127\.0\.0\.1|localhost):3199/(do|cmd)\b'
    try {
      $fs = [IO.File]::Open($brainLog, 'Open', 'Read', 'ReadWrite')
      $sr = New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)
      try { while (($line = $sr.ReadLine()) -ne $null) { if ($line -match $re) { return 'первая команда телу: ' + $line.Trim().Substring(0, [Math]::Min(120, $line.Trim().Length)) } } }
      finally { $sr.Close() }
    } catch {}
  }
  return $null
}
