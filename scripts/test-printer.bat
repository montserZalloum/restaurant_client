@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM   Queue Manager - Printer connectivity test
REM
REM   Sends a small ESC/POS test page to the configured printer
REM   (network.printer_new_ip from config). Use this AFTER
REM   re-IPing the printer and BEFORE running install.bat to
REM   verify the printer is reachable on the new address.
REM ============================================================

set "PKG_ROOT=%~dp0"
if "%PKG_ROOT:~-1%"=="\" set "PKG_ROOT=%PKG_ROOT:~0,-1%"

set "INSTALL_DIR=%PROGRAMDATA%\QueueManager"

set "NODE_EXE="
set "SCRIPT="

if exist "%INSTALL_DIR%\node\node.exe"            set "NODE_EXE=%INSTALL_DIR%\node\node.exe"
if exist "%INSTALL_DIR%\setup-helper.js"          (
    REM in installed layout, the test-printer script lives next to setup-helper
    if exist "%INSTALL_DIR%\test-printer.js"      set "SCRIPT=%INSTALL_DIR%\test-printer.js"
)

if not defined NODE_EXE for /f "delims=" %%n in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%n"
if not defined SCRIPT   if exist "%PKG_ROOT%\test-printer.js"           set "SCRIPT=%PKG_ROOT%\test-printer.js"
if not defined SCRIPT   if exist "%PKG_ROOT%\..\scripts\test-printer.js" set "SCRIPT=%PKG_ROOT%\..\scripts\test-printer.js"

if not defined NODE_EXE ( echo ERROR: Node.js not found. & exit /b 1 )
if not defined SCRIPT   ( echo ERROR: test-printer.js not found. & exit /b 1 )

"%NODE_EXE%" "%SCRIPT%"
exit /b %errorlevel%
