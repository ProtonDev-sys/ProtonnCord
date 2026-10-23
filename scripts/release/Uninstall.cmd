@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" -Action Uninstall %*
set "installer_result=%errorlevel%"
pause
exit /b %installer_result%
