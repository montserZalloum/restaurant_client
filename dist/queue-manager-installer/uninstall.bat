@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM   Queue Manager - Local Agent uninstaller
REM   Per docs\PRD_07_installation.md (sec. 10)
REM ============================================================

set "PKG_ROOT=%~dp0"
if "%PKG_ROOT:~-1%"=="\" set "PKG_ROOT=%PKG_ROOT:~0,-1%"

set "INSTALL_DIR=%PROGRAMDATA%\QueueManager"

echo.
echo ============================================================
echo   Queue Manager - Uninstall
echo ============================================================
echo.

REM -- 1. Administrator check -----------------------------------
net session >nul 2>&1
if errorlevel 1 (
    echo ERROR: Run as Administrator.
    exit /b 1
)

REM -- 2. Locate helper, node, nssm, config ---------------------
set "NODE_EXE="
set "NSSM_EXE="
set "HELPER="
set "CONFIG="

if exist "%INSTALL_DIR%\setup-helper.js"     set "HELPER=%INSTALL_DIR%\setup-helper.js"
if exist "%INSTALL_DIR%\node\node.exe"       set "NODE_EXE=%INSTALL_DIR%\node\node.exe"
if exist "%INSTALL_DIR%\nssm.exe"            set "NSSM_EXE=%INSTALL_DIR%\nssm.exe"
if exist "%INSTALL_DIR%\config\config.json"  set "CONFIG=%INSTALL_DIR%\config\config.json"

REM Fallback to source layout if install dir is incomplete
if not defined HELPER if exist "%PKG_ROOT%\setup-helper.js"          set "HELPER=%PKG_ROOT%\setup-helper.js"
if not defined NODE_EXE for /f "delims=" %%n in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%n"
if not defined NSSM_EXE if exist "%PKG_ROOT%\nssm.exe"               set "NSSM_EXE=%PKG_ROOT%\nssm.exe"
if not defined NSSM_EXE if exist "%PKG_ROOT%\..\nssm.exe"            set "NSSM_EXE=%PKG_ROOT%\..\nssm.exe"
if not defined NSSM_EXE for /f "delims=" %%n in ('where nssm 2^>nul') do if not defined NSSM_EXE set "NSSM_EXE=%%n"
if not defined CONFIG if exist "%PKG_ROOT%\config.json"              set "CONFIG=%PKG_ROOT%\config.json"
if not defined CONFIG if exist "%PKG_ROOT%\..\config\config.json"    set "CONFIG=%PKG_ROOT%\..\config\config.json"

REM -- 3. Determine service name from config (best effort) ------
set "SERVICE_NAME=QueueManager"
if defined CONFIG if defined HELPER if defined NODE_EXE (
    for /f "usebackq tokens=1,* delims==" %%a in (`"%NODE_EXE%" "%HELPER%" extract-vars "%CONFIG%"`) do (
        if "%%a"=="SERVICE_NAME" set "SERVICE_NAME=%%b"
    )
)

REM -- 4. Confirm ----------------------------------------------
echo This will:
echo   - Stop and remove Windows service: %SERVICE_NAME%
echo   - Remove firewall rules: print receiver, local server, cloud connection, test mode
if defined CONFIG echo   - Remove IP alias declared in: %CONFIG%
if not defined CONFIG echo   - Skip IP alias removal (no config found - remove manually if needed)
echo   - Delete %INSTALL_DIR% (data, logs, config - irreversible)
echo.
set "CONFIRM="
set /p "CONFIRM=Proceed? (y/N): "
if /i not "%CONFIRM%"=="y" (
    echo Aborted by user.
    exit /b 0
)

REM -- 5. Stop and remove service -------------------------------
echo.
echo Stopping service ...
if defined HELPER if defined NODE_EXE (
    "%NODE_EXE%" "%HELPER%" service-stop --service-name=%SERVICE_NAME% --timeout=30000
) else (
    net stop "%SERVICE_NAME%" >nul 2>&1
)
if defined HELPER if defined NODE_EXE if defined NSSM_EXE (
    "%NODE_EXE%" "%HELPER%" service-uninstall --nssm="%NSSM_EXE%" --service-name=%SERVICE_NAME%
) else (
    sc delete "%SERVICE_NAME%" >nul 2>&1
    echo (used sc delete fallback - helper or nssm unavailable)
)

REM -- 6. Remove firewall rules ---------------------------------
echo.
echo Removing firewall rules ...
if defined HELPER if defined NODE_EXE (
    "%NODE_EXE%" "%HELPER%" firewall-remove
) else (
    netsh advfirewall firewall delete rule name="Queue Manager - Print Receiver"   >nul 2>&1
    netsh advfirewall firewall delete rule name="Queue Manager - Local Server"     >nul 2>&1
    netsh advfirewall firewall delete rule name="Queue Manager - Cloud Connection" >nul 2>&1
    netsh advfirewall firewall delete rule name="Queue Manager - Test Mode (Temporary)" >nul 2>&1
    echo (used netsh fallback - helper unavailable)
)

REM -- 7. Remove IP alias ---------------------------------------
if defined CONFIG if defined HELPER if defined NODE_EXE (
    echo.
    echo Removing IP alias ...
    "%NODE_EXE%" "%HELPER%" alias-remove "%CONFIG%"
) else (
    echo.
    echo Skipped IP alias removal - config or helper unavailable.
    echo Remove manually with: netsh interface ip delete address "Ethernet" ^<ip^>
)

REM -- 8. Delete files ------------------------------------------
if exist "%INSTALL_DIR%" (
    echo.
    echo Deleting %INSTALL_DIR% ...
    rmdir /S /Q "%INSTALL_DIR%"
    if exist "%INSTALL_DIR%" (
        echo WARNING: some files could not be deleted. Stop processes using them and retry.
    )
)

echo.
echo ============================================================
echo   Uninstall complete.
echo ============================================================
echo.
echo NOTE: If you changed the printer's IP during install, revert it
echo manually before resuming normal printing without Queue Manager.
echo.

endlocal
exit /b 0
