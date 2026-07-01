@echo off
rem ===========================================================================
rem  Bixi (BixiSVN) - app-mode launcher (Windows).
rem
rem  Serves the app with PHP's built-in web server IN YOUR desktop session, so
rem  external tools (TortoiseSVN diff, "Open", "Reveal") launch visibly with no
rem  Scheduled Task. No Apache needed. Just double-click this file.
rem
rem  Close this window (or press Ctrl+C) to stop the server.
rem ===========================================================================

setlocal
if "%PORT%"=="" set "PORT=8787"

where php >nul 2>&1
if errorlevel 1 (
    echo PHP was not found on your PATH.
    echo Install PHP 8.2+ (e.g. from the XAMPP php folder) and add it to PATH.
    pause
    exit /b 1
)

echo Starting Bixi at http://127.0.0.1:%PORT%/
echo (Leave this window open. Close it to stop the server.)
start "" "http://127.0.0.1:%PORT%/"
php -S 127.0.0.1:%PORT% -t "%~dp0"
