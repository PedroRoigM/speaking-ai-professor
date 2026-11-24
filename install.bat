@echo off
setlocal
REM Speaking AI Professor — Windows 1-Click Installer Launcher
REM Works via double-click in File Explorer, CMD, or PowerShell (avoids Notepad & ExecutionPolicy blocks).

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%" NEQ "0" (
  echo.
  echo Installation finished with errors (exit code %EXIT_CODE%).
)

REM Keep window open only when launched via double-click from File Explorer
echo %cmdcmdline% | find /i "%~0" >nul
if not errorlevel 1 (
  echo.
  pause
)

exit /b %EXIT_CODE%
