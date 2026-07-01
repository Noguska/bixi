@echo off
REM ============================================================================
REM  deploy.bat  --  Build a redistributable ZIP of SVN Review.
REM
REM  Produces a clean, self-contained archive that another user can unzip onto
REM  any PHP 8.2 + SVN 1.14 host and run.  Per-install state and dev-only files
REM  are stripped:
REM    - .claude\                  (Claude Code workspace)
REM    - data\ runtime state       (auth.json, projects.json, config.json,
REM                                 reviews\, commits\, sessions\, logs\,
REM                                 extdiff-queue\)  -- ship an EMPTY data\
REM    - dev docs (CLAUDE.md, CLAUDE-todo.md, NAMES.md), .gitignore, *.log
REM
REM  Only data\.htaccess and data\config.json.example are shipped under data\
REM  so the web-block and the config template survive; everything else in data\
REM  is recreated by the app on first run.
REM
REM  Usage:  deploy.bat  [output-folder]
REM          (default output folder is .\dist)
REM ============================================================================

setlocal enabledelayedexpansion

REM --- Resolve paths --------------------------------------------------------
set "SRC=%~dp0"
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"

set "OUTDIR=%~1"
if "%OUTDIR%"=="" set "OUTDIR=%SRC%\dist"

REM --- Date/time stamp (locale-independent, via PowerShell) ------------------
for /f "usebackq delims=" %%T in (`powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"`) do set "STAMP=%%T"

set "NAME=svnreview-%STAMP%"
set "STAGE=%TEMP%\%NAME%"
set "ZIP=%OUTDIR%\%NAME%.zip"

echo.
echo   Source : %SRC%
echo   Staging: %STAGE%
echo   Output : %ZIP%
echo.

REM --- Clean any prior staging ----------------------------------------------
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%"
if not exist "%OUTDIR%" mkdir "%OUTDIR%"

REM --- Copy the app tree, excluding state + dev-only files -------------------
REM  /E      include subdirs (incl. empty)
REM  /XD     exclude directories (full state dirs + dev workspace)
REM  /XF     exclude files (dev docs + repo meta + logs)
REM  /NFL /NDL /NJH /NJS /NP  quiet output
echo   Copying app files...
robocopy "%SRC%" "%STAGE%" /E ^
  /XD "%SRC%\.claude" "%SRC%\.git" "%SRC%\dist" ^
      "%SRC%\data\reviews" "%SRC%\data\commits" "%SRC%\data\sessions" ^
      "%SRC%\data\logs" "%SRC%\data\extdiff-queue" ^
  /XF "%SRC%\CLAUDE.md" "%SRC%\CLAUDE-todo.md" "%SRC%\NAMES.md" ^
      "%SRC%\.gitignore" "%SRC%\deploy.bat" ^
      "%SRC%\data\auth.json" "%SRC%\data\projects.json" "%SRC%\data\config.json" ^
      "*.log" ".DS_Store" "Thumbs.db" ^
  /NFL /NDL /NJH /NJS /NP >nul

REM robocopy returns 0-7 on success; 8+ is a real error.
if %ERRORLEVEL% GEQ 8 (
  echo   ERROR: robocopy failed with code %ERRORLEVEL%.
  goto :fail
)

REM --- Guarantee an empty-but-present data\ with only the shipped files ------
if not exist "%STAGE%\data" mkdir "%STAGE%\data"

REM --- Build the ZIP --------------------------------------------------------
echo   Compressing...
if exist "%ZIP%" del /q "%ZIP%"
powershell -NoProfile -Command ^
  "Compress-Archive -Path '%STAGE%\*' -DestinationPath '%ZIP%' -Force"
if errorlevel 1 (
  echo   ERROR: Compress-Archive failed.
  goto :fail
)

REM --- Clean staging --------------------------------------------------------
rmdir /s /q "%STAGE%"

echo.
echo   Done.  Built: %ZIP%
echo.
endlocal
exit /b 0

:fail
if exist "%STAGE%" rmdir /s /q "%STAGE%"
echo.
echo   Build FAILED.
echo.
endlocal
exit /b 1
