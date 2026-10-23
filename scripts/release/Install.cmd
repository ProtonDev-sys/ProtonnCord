@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" -Action Install %*
set "installer_result=%errorlevel%"
pause
exit /b %installer_result%
