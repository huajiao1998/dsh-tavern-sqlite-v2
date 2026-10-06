@echo off
rem dsh-tavern-sqlite-v2 Windows launcher (ASCII only: safe in any console codepage).
rem Double-clicking this file can never "flash and vanish":
rem   - bypasses ExecutionPolicy so a policy block cannot close the window,
rem   - captures EVERY line (including PowerShell parse errors) into install.log,
rem   - always pauses before exit.
rem The log always sits next to this file. See README / deploy/INSTALL.md.
setlocal
chcp 65001 >nul 2>&1
set "HERE=%~dp0"
set "LOG=%HERE%install.log"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

echo [dsh-tavern-sqlite-v2] launcher start > "%LOG%"
echo [dsh-tavern-sqlite-v2] log: %LOG%
echo [dsh-tavern-sqlite-v2] script: %HERE%install.ps1
echo. 
"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%HERE%install.ps1" %* >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"

echo.
echo ---------------- install.log ----------------
type "%LOG%"
echo -------------------------------------------
echo.
echo exit code: %RC%
echo full log : %LOG%
echo.
echo Send the file above to the maintainer if you need help.
pause
exit /b %RC%
