@echo off
rem ASCII launcher: live menu, one execution only, separate startup stderr capture.
rem install.ps1 owns normal logging (possibly TEMP fallback); missing local log is NOT permission to rerun.
rem See INSTALL.zh-CN.md. This launcher owns the final pause and preserves the original exit code.
setlocal
chcp 65001 >nul 2>&1
set "HERE=%~dp0"
set "LOG=%HERE%install.log"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"
set "DSH_TAVERN_LAUNCHER=1"

:error_file
set "ERR=%TEMP%\dsh-tavern-startup-%RANDOM%-%RANDOM%.log"
if exist "%ERR%" goto :error_file

echo [dsh-tavern-sqlite-v2] launcher start
echo [dsh-tavern-sqlite-v2] script : %HERE%install.ps1
echo [dsh-tavern-sqlite-v2] log    : %LOG%
echo.

rem Only stderr is captured. stdout/menu remain live, even if install.ps1 logs elsewhere.
"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%HERE%install.ps1" %* 2> "%ERR%"
set "RC=%ERRORLEVEL%"

if not exist "%ERR%" goto :log_ready
for %%A in ("%ERR%") do if %%~zA GTR 0 goto :startup_error
rem Exact file created by this launch; never delete install.ps1's own log.
del /q "%ERR%" >nul 2>&1
goto :log_ready

:startup_error
echo.
echo ---------------- PowerShell stderr ----------------
type "%ERR%"
echo ---------------------------------------------------
rem Append when writable; retain the unique TEMP error log even if local logging is denied.
>> "%LOG%" echo [dsh-tavern-sqlite-v2] PowerShell stderr from this launch, exit %RC%:
type "%ERR%" >> "%LOG%" 2>nul
echo startup error log : %ERR%

:log_ready
echo.
echo exit code: %RC%
echo normal log: use the path printed by install.ps1 above.
echo Send the log to the maintainer if you need help.
pause
exit /b %RC%
