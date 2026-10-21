<#
.SYNOPSIS
  Starter talemotoren (hvis den ikke kjører) og Verity, og åpner Verity i nettleseren.
.DESCRIPTION
  Talemotoren hentes fra NorwegianSpeechBase ved siden av Verity
  (F:\prosjekter_MAIN\NorwegianSpeechBase), eller fra NSB_ROOT.
  Den startes i et eget vindu; lukk det vinduet for å stoppe motoren.
#>
$ErrorActionPreference = 'Continue'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Nsb = if ($env:NSB_ROOT) { $env:NSB_ROOT } else { Join-Path (Split-Path $Root -Parent) 'NorwegianSpeechBase' }

function Test-Engine {
    try { Invoke-RestMethod -Uri 'http://127.0.0.1:8765/v1/health' -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

if (Test-Engine) {
    Write-Host 'Talemotoren kjører allerede.'
} elseif (Test-Path (Join-Path $Nsb 'scripts/RUN_ENGINE.cmd')) {
    Write-Host 'Starter talemotoren i eget vindu (lukk det vinduet for å stoppe den) ...'
    Start-Process -FilePath (Join-Path $Nsb 'scripts/RUN_ENGINE.cmd') -ArgumentList '-NoBrowser' -WorkingDirectory $Nsb -WindowStyle Minimized
    $ok = $false
    for ($i = 0; $i -lt 90; $i++) {
        Start-Sleep -Seconds 2
        if (Test-Engine) { $ok = $true; break }
    }
    if ($ok) { Write-Host 'Talemotoren er klar.' }
    else { Write-Host 'Talemotoren svarte ikke etter 3 minutter. Verity starter likevel; se vinduet «RUN_ENGINE» for feilmelding.' -ForegroundColor Yellow }
} else {
    Write-Host "Fant ikke NorwegianSpeechBase i $Nsb. Verity starter uten talemotor (søk virker, nye opptak transkriberes ikke)." -ForegroundColor Yellow
}

& (Join-Path $PSScriptRoot 'run_verity.ps1')
