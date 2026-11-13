@echo off
setlocal
set "CHAMIE_SETUP_DIR=%~dp0"
powershell.exe -NoProfile -Command "try { & ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $env:CHAMIE_SETUP_DIR 'Install-Helper.ps1')))) -PackageDirectory $env:CHAMIE_SETUP_DIR } catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }"
set "CHAMIE_INSTALL_RESULT=%errorlevel%"
pause
exit /b %CHAMIE_INSTALL_RESULT%
