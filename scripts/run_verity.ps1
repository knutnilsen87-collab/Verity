<#
.SYNOPSIS
  Starter Verity på http://127.0.0.1:8780/.
.DESCRIPTION
  Første gang: lager .venv (Python 3.11), installerer tjenesten og bygger nettsiden (krever Node.js).
  Talemotoren (nsb-engine i NorwegianSpeechBase) må kjøre for at nye opptak skal transkriberes:
  scripts\RUN_ENGINE.cmd i NorwegianSpeechBase. Søk i ferdige opptak virker uten motoren.
#>
param([int]$Port = 8780, [switch]$NoBrowser)
# Continue: Windows PowerShell 5.1 gjør advarsler fra pip og npm (stderr) til feil med 'Stop'.
$ErrorActionPreference = 'Continue'
function Stop-WithError([string]$m) { Write-Host "FEIL: $m" -ForegroundColor Red; exit 1 }
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root
$env:PYTHONUTF8 = '1'

$Py = Join-Path $Root '.venv/Scripts/python.exe'
if (-not (Test-Path $Py)) {
    Write-Host 'Lager .venv med Python 3.11'
    & py -3.11 -m venv .venv
    if (-not (Test-Path $Py)) { Stop-WithError "Kunne ikke lage .venv med 'py -3.11'. Installer Python 3.11." }
}
$ok = "$(& $Py -c "import verity, fastapi, uvicorn, av; print('ok')" 2>$null)".Trim()
if ($ok -ne 'ok') {
    Write-Host 'Installerer Verity-tjenesten'
    & $Py -m pip install --quiet --upgrade pip
    & $Py -m pip install --quiet -e ./server
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'pip install feilet' }
}

$Dist = Join-Path $Root 'web/dist/index.html'
$newest = Get-ChildItem (Join-Path $Root 'web/src') -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not (Test-Path $Dist) -or (Get-Item $Dist).LastWriteTime -lt $newest.LastWriteTime) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Stop-WithError 'Fant ikke npm. Installer Node.js (LTS) for å bygge nettsiden.' }
    Write-Host 'Bygger nettsiden'
    Push-Location web
    try {
        if (-not (Test-Path node_modules)) { npm ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { Stop-WithError 'npm ci feilet' } }
        npm run build; if ($LASTEXITCODE -ne 0) { Stop-WithError 'npm run build feilet' }
    } finally { Pop-Location }
}

try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/v1/health' -TimeoutSec 2
    Write-Host "Talemotoren kjører: $($h.model) på $($h.device)"
} catch {
    Write-Host 'Talemotoren kjører ikke. Start scripts\RUN_ENGINE.cmd i NorwegianSpeechBase for å transkribere nye opptak.' -ForegroundColor Yellow
}
if (-not $NoBrowser) { Start-Job -ScriptBlock { param($p) Start-Sleep 2; Start-Process "http://127.0.0.1:$p/" } -ArgumentList $Port | Out-Null }
& $Py -m verity --port $Port
