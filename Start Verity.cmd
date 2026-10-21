@echo off
rem Dobbeltklikk for aa starte Verity (og talemotoren hvis den ikke kjorer).
rem Lukk dette vinduet for aa stoppe Verity.
title Verity
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_verity.ps1"
pause
