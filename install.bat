@echo off
setlocal EnableExtensions

REM Speaking AI Professor - Windows 1-Click Installer Launcher
REM Works via double-click in File Explorer, CMD, or PowerShell.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Installation finished with errors ^(exit code %EXIT_CODE%^).
)

exit /b %EXIT_CODE%
