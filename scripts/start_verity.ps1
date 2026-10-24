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
# Modell og dekoding for Verity. dialekt_v1 har omtrent halvparten så mange feil på samtale og dialekt
# som utgangsmodellen (NorwegianSpeechBase docs/experiments/DIALEKT_V1.md). Kan overstyres med miljøvariabler.
$EngineModel = if ($env:VERITY_ENGINE_MODEL) { $env:VERITY_ENGINE_MODEL } else { 'dialekt_v1' }
$EngineDecoding = if ($env:VERITY_ENGINE_DECODING) { $env:VERITY_ENGINE_DECODING } else { 'standard' }
if ($EngineModel -eq 'dialekt_v1' -and -not (Test-Path (Join-Path $Nsb 'models/finetuned/dialekt_v1/ct2/model.bin'))) {
    Write-Host 'Fant ikke dialekt_v1; bruker utgangsmodellen.' -ForegroundColor Yellow
    $EngineModel = 'nb-whisper-large-distil-turbo-beta'
}

function Test-Engine {
    try { Invoke-RestMethod -Uri 'http://127.0.0.1:8765/v1/health' -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

if (Test-Engine) {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/v1/health' -TimeoutSec 2
    Write-Host "Talemotoren kjører allerede med $($h.model). Lukk vinduet RUN_ENGINE og start på nytt for å bruke $EngineModel."
} elseif (Test-Path (Join-Path $Nsb 'scripts/RUN_ENGINE.cmd')) {
    Write-Host "Starter talemotoren med $EngineModel ($EngineDecoding) i eget vindu (lukk det vinduet for å stoppe den) ..."
    Start-Process -FilePath (Join-Path $Nsb 'scripts/RUN_ENGINE.cmd') -ArgumentList @('-NoBrowser', '-Model', $EngineModel, '-Decoding', $EngineDecoding) `
        -WorkingDirectory $Nsb -WindowStyle Minimized
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
