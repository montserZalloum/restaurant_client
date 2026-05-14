@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM   Queue Manager - Local Agent installer
REM   Per docs\PRD_07_installation.md (with PRD #8 sec. 9 amendments)
REM ============================================================

set "PKG_ROOT=%~dp0"
if "%PKG_ROOT:~-1%"=="\" set "PKG_ROOT=%PKG_ROOT:~0,-1%"

set "INSTALL_DIR=%PROGRAMDATA%\QueueManager"

echo.
echo ============================================================
echo   Queue Manager - Installation
echo ============================================================
echo.

REM -- 1. Administrator check -----------------------------------
net session >nul 2>&1
if errorlevel 1 (
    echo ERROR: This installer must be run as Administrator.
    echo Right-click install.bat ^> Run as administrator
    exit /b 1
)
echo [1/12] Administrator check ........................... OK

REM -- 2. Layout detection (packaged vs repo) -------------------
set "LAYOUT="
set "AGENT_SOURCE="
set "CONFIG_SOURCE="
set "BUNDLED_NODE="
set "BUNDLED_NSSM="

if exist "%PKG_ROOT%\agent\package.json" (
    set "LAYOUT=packaged"
    set "AGENT_SOURCE=%PKG_ROOT%\agent"
    set "CONFIG_SOURCE=%PKG_ROOT%\config.json"
    if exist "%PKG_ROOT%\node\node.exe" set "BUNDLED_NODE=%PKG_ROOT%\node\node.exe"
    if exist "%PKG_ROOT%\nssm.exe"      set "BUNDLED_NSSM=%PKG_ROOT%\nssm.exe"
) else if exist "%PKG_ROOT%\..\package.json" (
    set "LAYOUT=repo"
    set "AGENT_SOURCE=%PKG_ROOT%\.."
    set "CONFIG_SOURCE=%PKG_ROOT%\..\config\config.json"
    if exist "%PKG_ROOT%\..\node\node.exe" set "BUNDLED_NODE=%PKG_ROOT%\..\node\node.exe"
    if exist "%PKG_ROOT%\..\nssm.exe"      set "BUNDLED_NSSM=%PKG_ROOT%\..\nssm.exe"
) else (
    echo ERROR: Cannot find agent.
    echo Expected one of:
    echo   - packaged: %%~dp0agent\package.json
    echo   - repo:     %%~dp0..\package.json
    exit /b 1
)
echo [2/12] Layout detected ............................... %LAYOUT%

REM -- 3. Locate Node.js ----------------------------------------
set "NODE_EXE="
if defined BUNDLED_NODE (
    set "NODE_EXE=%BUNDLED_NODE%"
) else (
    for /f "delims=" %%n in ('where node 2^>nul') do (
        if not defined NODE_EXE set "NODE_EXE=%%n"
    )
)
if not defined NODE_EXE (
    echo ERROR: Node.js not found.
    echo - Bundle node-v20.x-win-x64\ next to this installer, OR
    echo - Install Node.js 20+ system-wide from https://nodejs.org/
    exit /b 1
)
if not defined BUNDLED_NODE echo WARNING: Using system Node.js - bundled portable Node is recommended.
echo [3/12] Node.js ....................................... %NODE_EXE%

REM -- 4. Verify Node version (>= 20) ---------------------------
"%NODE_EXE%" "%PKG_ROOT%\setup-helper.js" check-node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js version is too old. Need Node 20 or newer.
    "%NODE_EXE%" "%PKG_ROOT%\setup-helper.js" check-node
    exit /b 1
)
echo [4/12] Node version verified ......................... OK

REM -- 5. Locate NSSM -------------------------------------------
set "NSSM_EXE="
if defined BUNDLED_NSSM (
    set "NSSM_EXE=%BUNDLED_NSSM%"
) else (
    for /f "delims=" %%n in ('where nssm 2^>nul') do (
        if not defined NSSM_EXE set "NSSM_EXE=%%n"
    )
)
if not defined NSSM_EXE (
    echo ERROR: nssm.exe not found.
    echo Download from https://nssm.cc/download and place nssm.exe next to this installer.
    exit /b 1
)
echo [5/12] NSSM .......................................... %NSSM_EXE%

REM -- 6. Verify config.json ------------------------------------
if not exist "%CONFIG_SOURCE%" (
    echo ERROR: config.json not found at %CONFIG_SOURCE%
    if "%LAYOUT%"=="repo" echo Hint: copy config\config.example.json to config\config.json and edit it.
    exit /b 1
)
"%NODE_EXE%" "%PKG_ROOT%\setup-helper.js" verify-config "%CONFIG_SOURCE%" >nul
if errorlevel 1 (
    echo ERROR: config validation failed. Run the helper directly to see details:
    echo   "%NODE_EXE%" "%PKG_ROOT%\setup-helper.js" verify-config "%CONFIG_SOURCE%"
    exit /b 1
)
echo [6/12] Config validated .............................. %CONFIG_SOURCE%

REM Extract values for batch use
for /f "usebackq tokens=1,* delims==" %%a in (`""%NODE_EXE%" "%PKG_ROOT%\setup-helper.js" extract-vars "%CONFIG_SOURCE%""`) do (
    set "QM_%%a=%%b"
)
if not defined QM_SERVICE_NAME (
    echo ERROR: failed to extract config values.
    exit /b 1
)

REM -- Confirm with operator (uncounted) ------------------------
echo.
"%NODE_EXE%" "%PKG_ROOT%\setup-helper.js" print-summary "%CONFIG_SOURCE%"
echo Install target: %INSTALL_DIR%
echo Layout        : %LAYOUT%
echo.
set "CONFIRM="
set /p "CONFIRM=Continue with installation? (y/N): "
if /i not "%CONFIRM%"=="y" (
    echo Aborted by user.
    exit /b 0
)

REM -- 7. Stop existing service (timed) -------------------------
sc query "%QM_SERVICE_NAME%" >nul 2>&1
if not errorlevel 1 (
    echo [7/12] Existing service found, stopping ..............
    "%NODE_EXE%" "%PKG_ROOT%\setup-helper.js" service-stop --service-name=%QM_SERVICE_NAME% --timeout=30000
    if errorlevel 1 (
        echo ERROR: failed to stop existing %QM_SERVICE_NAME% within 30s.
        echo Try manually: sc stop %QM_SERVICE_NAME%
        exit /b 1
    )
    "%NODE_EXE%" "%PKG_ROOT%\setup-helper.js" service-uninstall --nssm="%NSSM_EXE%" --service-name=%QM_SERVICE_NAME%
    if errorlevel 1 (
        echo ERROR: failed to remove existing service.
        exit /b 1
    )
) else (
    echo [7/12] No existing service ........................... OK
)

REM -- 8. Create install dirs and copy files --------------------
echo [8/12] Creating directories and copying files ........
if not exist "%INSTALL_DIR%"          mkdir "%INSTALL_DIR%"
if not exist "%INSTALL_DIR%\agent"    mkdir "%INSTALL_DIR%\agent"
if not exist "%INSTALL_DIR%\config"   mkdir "%INSTALL_DIR%\config"
if not exist "%INSTALL_DIR%\logs"     mkdir "%INSTALL_DIR%\logs"
if not exist "%INSTALL_DIR%\data"     mkdir "%INSTALL_DIR%\data"

REM Copy agent: package.json, package-lock.json
if exist "%AGENT_SOURCE%\package.json"      copy /Y "%AGENT_SOURCE%\package.json"      "%INSTALL_DIR%\agent\package.json" >nul
if exist "%AGENT_SOURCE%\package-lock.json" copy /Y "%AGENT_SOURCE%\package-lock.json" "%INSTALL_DIR%\agent\package-lock.json" >nul

REM robocopy handles deep trees and long paths better than xcopy.
REM Exit codes 0-7 are success (something copied / nothing to copy / minor mismatch);
REM 8+ are real failures. Use `if errorlevel 8` and clear errorlevel after.
if exist "%AGENT_SOURCE%\src" (
    robocopy "%AGENT_SOURCE%\src" "%INSTALL_DIR%\agent\src" /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >nul
    if errorlevel 8 (
        echo ERROR: failed to copy src\ to install directory.
        exit /b 1
    )
    ver >nul
)
if exist "%AGENT_SOURCE%\node_modules" (
    robocopy "%AGENT_SOURCE%\node_modules" "%INSTALL_DIR%\agent\node_modules" /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >nul
    if errorlevel 8 (
        echo ERROR: failed to copy node_modules\ to install directory.
        exit /b 1
    )
    ver >nul
)
if not exist "%INSTALL_DIR%\agent\node_modules" (
    echo ERROR: node_modules missing in source. Run "npm install" before packaging.
    exit /b 1
)

REM Bundle Node, NSSM, helper into INSTALL_DIR
if defined BUNDLED_NODE (
    if not exist "%INSTALL_DIR%\node" mkdir "%INSTALL_DIR%\node"
    for %%I in ("%BUNDLED_NODE%") do set "NODE_DIR=%%~dpI"
    if "!NODE_DIR:~-1!"=="\" set "NODE_DIR=!NODE_DIR:~0,-1!"
    robocopy "!NODE_DIR!" "%INSTALL_DIR%\node" /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >nul
    if errorlevel 8 (
        echo ERROR: failed to copy bundled Node to install directory.
        exit /b 1
    )
    ver >nul
    set "INSTALLED_NODE=%INSTALL_DIR%\node\node.exe"
) else (
    set "INSTALLED_NODE=%NODE_EXE%"
)
copy /Y "%NSSM_EXE%"                 "%INSTALL_DIR%\nssm.exe"        >nul
copy /Y "%PKG_ROOT%\setup-helper.js" "%INSTALL_DIR%\setup-helper.js" >nul
if exist "%PKG_ROOT%\test-printer.js" copy /Y "%PKG_ROOT%\test-printer.js" "%INSTALL_DIR%\test-printer.js" >nul
copy /Y "%CONFIG_SOURCE%"            "%INSTALL_DIR%\config\config.json" >nul

REM -- 9. IP alias ---------------------------------------------
echo [9/12] Setting up IP alias ...........................
"%INSTALLED_NODE%" "%INSTALL_DIR%\setup-helper.js" alias-add "%INSTALL_DIR%\config\config.json"
if errorlevel 1 (
    echo ERROR: IP alias setup failed. See message above.
    exit /b 1
)

REM -- 10. Firewall --------------------------------------------
echo [10/12] Configuring firewall rules ...................
"%INSTALLED_NODE%" "%INSTALL_DIR%\setup-helper.js" firewall-add "%INSTALL_DIR%\config\config.json"
if errorlevel 1 (
    echo ERROR: firewall configuration failed.
    exit /b 1
)

REM -- 11. Install + start service ------------------------------
echo [11/12] Installing Windows Service ..................
"%INSTALLED_NODE%" "%INSTALL_DIR%\setup-helper.js" service-install "%INSTALL_DIR%\config\config.json" ^
    --nssm="%INSTALL_DIR%\nssm.exe" ^
    --node="%INSTALLED_NODE%" ^
    --script="%INSTALL_DIR%\agent\src\index.js" ^
    --app-dir="%INSTALL_DIR%\agent" ^
    --config-file="%INSTALL_DIR%\config\config.json" ^
    --data-dir="%INSTALL_DIR%\data" ^
    --log-dir="%INSTALL_DIR%\logs" ^
    --stdout="%INSTALL_DIR%\logs\stdout.log" ^
    --stderr="%INSTALL_DIR%\logs\stderr.log"
if errorlevel 1 (
    echo ERROR: service installation failed.
    exit /b 1
)

echo Starting service ...
net start "%QM_SERVICE_NAME%"
if errorlevel 1 (
    echo WARNING: net start failed - check %INSTALL_DIR%\logs\ for details.
    echo The service is installed; you can try "net start %QM_SERVICE_NAME%" later.
    exit /b 1
)

REM Give the agent a few seconds to bind sockets and dial cloud
timeout /t 3 /nobreak >nul

REM -- 12. Verify cloud connectivity ----------------------------
echo [12/12] Verifying cloud connectivity .................
"%INSTALLED_NODE%" "%INSTALL_DIR%\setup-helper.js" verify-cloud "%INSTALL_DIR%\config\config.json"
set "CLOUD_OK=%errorlevel%"
if not "%CLOUD_OK%"=="0" (
    echo.
    echo WARNING: cloud connectivity check failed.
    echo The service is installed and running, but the agent cannot reach the cloud.
    echo Check:
    echo   - api_key in config matches what the cloud expects
    echo   - cloud.base_url and cloud.ws_url are reachable from this machine
    echo   - this machine has Internet access
    echo Re-run the check anytime:
    echo   "%INSTALLED_NODE%" "%INSTALL_DIR%\setup-helper.js" verify-cloud "%INSTALL_DIR%\config\config.json"
)

echo.
echo ============================================================
echo   Installation complete.
echo ============================================================
echo.
echo Service     : %QM_SERVICE_NAME%
echo Install dir : %INSTALL_DIR%
echo Logs        : %INSTALL_DIR%\logs\
if not "%CLOUD_OK%"=="0" echo Cloud       : NOT REACHABLE (see warning above)
if "%CLOUD_OK%"=="0"     echo Cloud       : reachable
echo.
echo Next steps:
echo   1. Verify the printer answers at %QM_PRINTER_NEW_IP%:%QM_PRINTER_PORT%
echo   2. Send a test print from the cashier
echo   3. Open display page on the TV
echo   4. Open staff page on a phone:
echo        http://[your-lan-ip]:%QM_LOCAL_HTTP_PORT%/staff
echo.
echo To run Test Mode (capture without forwarding): scripts\test-mode.bat
echo To uninstall: scripts\uninstall.bat
echo.

endlocal
exit /b 0
