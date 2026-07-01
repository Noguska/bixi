@echo off
rem ===========================================================================
rem  Bixi — register the interactive "Diff..." helper task.
rem
rem  *** OPTIONAL / LEGACY ***  You only need this if you serve the app through
rem  Apache running as a Windows service (Session 0). The simpler, recommended way
rem  is to launch with run.cmd, which serves the app in your own session and makes
rem  this scheduled task unnecessary. See INSTALL.md.
rem
rem  Apache runs as a Windows service (session 0) and cannot pop a GUI onto your
rem  desktop. This registers a Task Scheduler job that runs AS YOU, "only when
rem  logged on", so the diff window appears in your session. The web app triggers
rem  it on demand with schtasks /run.
rem
rem  Run this ONCE, as the Windows user who is logged in at the desktop.
rem  (Just double-click it, or run it from a normal command prompt.)
rem ===========================================================================

setlocal

set "TASK=SvnReviewDiff"
set "LAUNCHER=%~dp0bin\extdiff-launch.vbs"

if not exist "%LAUNCHER%" (
    echo ERROR: launcher not found: "%LAUNCHER%"
    echo Run this script from inside the svnreview folder.
    pause
    exit /b 1
)

rem No /ru or /rp: the task is created to run as the current user, "run only when
rem the user is logged on" -- interactive, no stored password, no elevation needed.
schtasks /create /f /tn "%TASK%" /sc once /st 00:00 ^
    /tr "wscript.exe \"%LAUNCHER%\""

if errorlevel 1 (
    echo.
    echo Failed to register the task. See the message above.
    pause
    exit /b 1
)

echo.
echo Registered scheduled task "%TASK%".
echo The "Diff..." action and double-click in Bixi will now open
echo TortoiseSVN's diff (and your configured viewer, e.g. VS Code).
echo.
pause
