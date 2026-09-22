@echo off
REM ===========================================================================
REM  pi-config.bat - convenience wrapper around bin\export.js / bin\import.js
REM
REM    pi-config              no args: interactive menu (double-click friendly)
REM    pi-config status       what differs between this machine and the repo
REM    pi-config preview      dry-run import, writes nothing
REM    pi-config import       apply repo config to this machine
REM    pi-config export       capture this machine's config into the repo
REM    pi-config sync         export + commit + push
REM    pi-config install      npm install the extensions
REM    pi-config setup        import + install, for a fresh machine
REM ===========================================================================

setlocal EnableExtensions
cd /d "%~dp0"

set "NPMDIR=%USERPROFILE%\.pi\agent\npm"
set "INTERACTIVE="

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   ERROR: Node.js was not found on PATH.
    echo   Install Node, then run this again.
    echo.
    pause
    exit /b 1
)

if "%~1"=="" goto menu

set "CMD=%~1"
shift
goto dispatch

REM ---------------------------------------------------------------------------
:menu
set "INTERACTIVE=1"
echo.
echo   ================================================
echo     pi-config
echo   ================================================
echo.
echo     1.  Status    - what differs from the repo
echo     2.  Preview   - show what import would change
echo     3.  Import    - apply repo config to this PC
echo     4.  Export    - save this PC's config to repo
echo     5.  Sync      - export + commit + push
echo     6.  Install   - npm install the extensions
echo     7.  Setup     - import + install (new machine)
echo     8.  Quit
echo.
set "choice="
set /p "choice=  Choose [1-8]: "

if "%choice%"=="1" set "CMD=status"  & goto dispatch
if "%choice%"=="2" set "CMD=preview" & goto dispatch
if "%choice%"=="3" set "CMD=import"  & goto dispatch
if "%choice%"=="4" set "CMD=export"  & goto dispatch
if "%choice%"=="5" set "CMD=sync"    & goto dispatch
if "%choice%"=="6" set "CMD=install" & goto dispatch
if "%choice%"=="7" set "CMD=setup"   & goto dispatch
if "%choice%"=="8" exit /b 0
echo.
echo   Not a valid choice.
goto menu

REM ---------------------------------------------------------------------------
:dispatch
if /i "%CMD%"=="status"  goto do_status
if /i "%CMD%"=="preview" goto do_preview
if /i "%CMD%"=="dry-run" goto do_preview
if /i "%CMD%"=="import"  goto do_import
if /i "%CMD%"=="export"  goto do_export
if /i "%CMD%"=="sync"    goto do_sync
if /i "%CMD%"=="install" goto do_install
if /i "%CMD%"=="setup"   goto do_setup
if /i "%CMD%"=="help"    goto do_help
if /i "%CMD%"=="-h"      goto do_help
if /i "%CMD%"=="--help"  goto do_help

echo.
echo   Unknown command: %CMD%
call :print_help
echo.
if defined INTERACTIVE pause
endlocal
exit /b 1

REM ---------------------------------------------------------------------------
:do_status
echo.
echo   This machine vs the repo:
echo.
echo   [ repo -^> machine ]
node bin\import.js --dry-run
if errorlevel 1 goto failed
echo.
echo   [ machine -^> repo ]
node bin\export.js --dry-run
if errorlevel 1 goto failed
echo.
echo   [ uncommitted ]
git status --short
goto done

:do_preview
echo.
echo   Previewing (nothing will be written)...
echo.
node bin\import.js --dry-run
if errorlevel 1 goto failed
goto done

:do_sync
echo.
echo   Capturing this machine's config...
echo.
node bin\export.js
if errorlevel 1 goto failed
git add -- pi
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "chore(config): sync from %COMPUTERNAME%"
    if errorlevel 1 goto failed
    echo.
    echo   Pushing...
    git push
    if errorlevel 1 goto failed
) else (
    echo   Nothing to commit - the repo is already current.
)
goto done

:do_import
echo.
echo   Applying repo config to this machine...
echo   Existing files are backed up as .bak-^<timestamp^>
echo.
node bin\import.js %1 %2 %3
if errorlevel 1 goto failed
goto done

:do_export
echo.
echo   Capturing this machine's config into the repo...
echo.
node bin\export.js
if errorlevel 1 goto failed
goto done

:do_install
if not exist "%NPMDIR%" (
    echo.
    echo   ERROR: %NPMDIR% does not exist.
    echo   Run "pi-config import" first, then try again.
    goto failed
)
echo.
echo   Installing extensions in %NPMDIR% ...
echo.
pushd "%NPMDIR%"
call npm install
set "NPMRC=%ERRORLEVEL%"
popd
if not "%NPMRC%"=="0" goto failed
goto done

:do_setup
echo.
echo   === Step 1 of 2: import config ===
echo.
node bin\import.js
if errorlevel 1 goto failed
echo.
echo   === Step 2 of 2: install extensions ===
if not exist "%NPMDIR%" (
    echo   ERROR: %NPMDIR% does not exist.
    goto failed
)
pushd "%NPMDIR%"
call npm install
set "NPMRC=%ERRORLEVEL%"
popd
if not "%NPMRC%"=="0" goto failed
echo.
echo   Setup complete. Now restart Pi and log in.
echo   ^(auth is deliberately not synced^)
goto done

:do_help
call :print_help
goto done

:print_help
echo.
echo   Usage: pi-config [command]
echo.
echo     status     what differs between this machine and the repo
echo     preview    show what import would change, write nothing
echo     import     apply repo config to this machine
echo     export     capture this machine's config into the repo
echo     sync       export + commit + push
echo     install    npm install the extensions
echo     setup      import + install, for a fresh machine
echo.
echo   Run with no arguments for an interactive menu.
exit /b 0

REM ---------------------------------------------------------------------------
:failed
echo.
echo   FAILED. See the output above.
if defined INTERACTIVE pause
endlocal
exit /b 1

:done
echo.
if defined INTERACTIVE pause
endlocal
exit /b 0
