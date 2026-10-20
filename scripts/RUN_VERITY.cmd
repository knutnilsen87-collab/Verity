@echo off
rem Starter Verity og apner det i nettleseren. Stopp med Ctrl+C.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_verity.ps1" %*
pause
