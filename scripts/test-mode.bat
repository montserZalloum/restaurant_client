@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM   Queue Manager - Test Mode launcher
REM   Per docs\PRD_07_installation.md sec. 8 (with PRD #8 sec. 9.2)
REM
REM   Receives prints WITHOUT forwarding them to the printer, and
REM   shows a diagnostic page on http://localhost:9300.
REM ============================================================

set "PKG_ROOT=%~dp0"
if "%PKG_ROOT:~-1%"=="\" set "PKG_ROOT=%PKG_ROOT:~0,-1%"

set "INSTALL_DIR=%PROGRAMDATA%\QueueManager"

echo.
echo ============================================================
echo   Queue Manager - Test Mode
echo ============================================================

REM -- 1. Admin check (needed for firewall rule + service stop) -
net session >nul 2>&1
if errorlevel 1 (
    echo ERROR: Run as Administrator.
    echo Test Mode adds a temporary firewall rule and may stop the service.
    exit /b 1
)

REM -- 2. Locate node, helper, script ---------------------------
set "NODE_EXE="
set "HELPER="
set "SCRIPT="
set "CONFIG="
set "SERVICE_NAME=QueueManager"

REM Prefer installed layout
if exist "%INSTALL_DIR%\node\node.exe"           set "NODE_EXE=%INSTALL_DIR%\node\node.exe"
if exist "%INSTALL_DIR%\setup-helper.js"         set "HELPER=%INSTALL_DIR%\setup-helper.js"
if exist "%INSTALL_DIR%\agent\src\test-mode.js"  set "SCRIPT=%INSTALL_DIR%\agent\src\test-mode.js"
if exist "%INSTALL_DIR%\config\config.json"      set "CONFIG=%INSTALL_DIR%\config\config.json"

REM Fall back to repo layout
if not defined NODE_EXE for /f "delims=" %%n in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%n"
if not defined HELPER  if exist "%PKG_ROOT%\setup-helper.js"          set "HELPER=%PKG_ROOT%\setup-helper.js"
if not defined SCRIPT  if exist "%PKG_ROOT%\..\src\test-mode.js"      set "SCRIPT=%PKG_ROOT%\..\src\test-mode.js"
if not defined CONFIG  if exist "%PKG_ROOT%\..\config\config.json"    set "CONFIG=%PKG_ROOT%\..\config\config.json"

if not defined NODE_EXE ( echo ERROR: Node.js not found. & exit /b 1 )
if not defined HELPER   ( echo ERROR: setup-helper.js not found. & exit /b 1 )
if not defined SCRIPT   ( echo ERROR: src\test-mode.js not found. & exit /b 1 )
if not defined CONFIG   ( echo ERROR: config\config.json not found. & exit /b 1 )

echo Node    : %NODE_EXE%
echo Script  : %SCRIPT%
echo Config  : %CONFIG%
echo.

REM -- 3. Resolve service name from config ----------------------
for /f "usebackq tokens=1,* delims==" %%a in (`"%NODE_EXE%" "%HELPER%" extract-vars "%CONFIG%"`) do (
    if "%%a"=="SERVICE_NAME" set "SERVICE_NAME=%%b"
)

REM -- 4. Stop service if running -------------------------------
set "WAS_RUNNING=0"
sc query "%SERVICE_NAME%" 2>nul | findstr /C:"RUNNING" >nul
if not errorlevel 1 (
    set "WAS_RUNNING=1"
    echo Stopping %SERVICE_NAME% service to free print port ...
    "%NODE_EXE%" "%HELPER%" service-stop --service-name=%SERVICE_NAME% --timeout=30000
    if errorlevel 1 (
        echo WARNING: could not stop %SERVICE_NAME%. Test Mode may fail to bind the print port.
    )
)

REM -- 5. Add Test Mode firewall rule ---------------------------
echo Adding temporary firewall rule for port 9300 ...
"%NODE_EXE%" "%HELPER%" firewall-test-mode-add
set "FW_ADDED=%errorlevel%"

REM -- 6. Run Test Mode (foreground; Ctrl+C to stop) ------------
echo.
"%NODE_EXE%" "%SCRIPT%"
set "TEST_MODE_EXIT=%errorlevel%"

REM -- 7. Cleanup: remove firewall rule -------------------------
if "%FW_ADDED%"=="0" (
    echo Removing temporary firewall rule for port 9300 ...
    "%NODE_EXE%" "%HELPER%" firewall-test-mode-remove >nul
)

REM -- 8. Offer to restart service if we stopped it -------------
if "%WAS_RUNNING%"=="1" (
    echo.
    set "RESTART="
    set /p "RESTART=Restart %SERVICE_NAME% service now? (Y/n): "
    if /i not "!RESTART!"=="n" (
        echo Starting %SERVICE_NAME% ...
        net start "%SERVICE_NAME%"
    ) else (
        echo Service left stopped. Run "net start %SERVICE_NAME%" later.
    )
)

echo.
echo Test Mode exited (code %TEST_MODE_EXIT%).
endlocal
exit /b %TEST_MODE_EXIT%
