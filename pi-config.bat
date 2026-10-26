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
REM    pi-config vscode       build and install the VS Code terminal bridge
REM    pi-config node         install the latest Node LTS (winget)
REM    pi-config pi           install Pi, or update it when already installed
REM    pi-config setup [--yes]  install Node and Pi if needed, import, install, VS Code bridge
REM ===========================================================================

setlocal EnableExtensions
cd /d "%~dp0"

set "NPMDIR=%USERPROFILE%\.pi\agent\npm"
set "INTERACTIVE="

if "%~1"=="" goto menu

set "CMD=%~1"
set "ARGS="
:collect
shift
if "%~1"=="" goto dispatch
set ARGS=%ARGS% "%~1"
goto collect

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
echo     7.  Setup     - import + install + VS Code bridge (new machine)
echo     8.  VS Code   - install the VS Code terminal bridge
echo     9.  Node      - install the latest Node LTS
echo    10.  Pi        - install Pi, or update it
echo    11.  Quit
echo.
set "choice="
set /p "choice=  Choose [1-11]: "

if "%choice%"=="1" set "CMD=status"  & goto dispatch
if "%choice%"=="2" set "CMD=preview" & goto dispatch
if "%choice%"=="3" set "CMD=import"  & goto dispatch
if "%choice%"=="4" set "CMD=export"  & goto dispatch
if "%choice%"=="5" set "CMD=sync"    & goto dispatch
if "%choice%"=="6" set "CMD=install" & goto dispatch
if "%choice%"=="7" set "CMD=setup"   & goto dispatch
if "%choice%"=="8" set "CMD=vscode"  & goto dispatch
if "%choice%"=="9"  set "CMD=node"   & goto dispatch
if "%choice%"=="10" set "CMD=pi"     & goto dispatch
if "%choice%"=="11" exit /b 0
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
if /i "%CMD%"=="vscode"  goto do_vscode
if /i "%CMD%"=="node"    goto do_node
if /i "%CMD%"=="pi"      goto do_pi
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
call :need_node
if errorlevel 1 goto failed
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
call :need_node
if errorlevel 1 goto failed
echo.
echo   Previewing (nothing will be written)...
echo.
node bin\import.js --dry-run
if errorlevel 1 goto failed
goto done

:do_sync
call :need_node
if errorlevel 1 goto failed
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
call :need_node
if errorlevel 1 goto failed
echo.
echo   Applying repo config to this machine...
echo   Existing files are backed up as .bak-^<timestamp^>
echo.
node bin\import.js %ARGS%
if errorlevel 1 goto failed
goto done

:do_export
call :need_node
if errorlevel 1 goto failed
echo.
echo   Capturing this machine's config into the repo...
echo.
node bin\export.js
if errorlevel 1 goto failed
goto done

:do_vscode
call :need_node
if errorlevel 1 goto failed
echo.
echo   Building and installing the VS Code terminal bridge...
echo.
node bin\vscode-bridge.js
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

:do_node
echo.
call :install_node
if errorlevel 1 goto failed
goto done

:do_pi
echo.
call :install_pi
if errorlevel 1 goto failed
goto done

:do_setup
set "YES="
if not "%ARGS:--yes=%"=="%ARGS%" set "YES=1"
echo.
echo   === Step 1 of 5: Node ===
call :node_ok
if errorlevel 1 (
    if not defined YES (
        choice /c YN /m "  Node 22.19 or newer not found. Install the latest LTS via winget"
        if errorlevel 2 (
            echo   ERROR: Node ^>= 22.19 is required.
            goto failed
        )
    )
    call :install_node
    if errorlevel 1 goto failed
)
echo.
echo   === Step 2 of 5: Pi ===
where pi >nul 2>nul
if errorlevel 1 (
    set "DOPI=1"
    if not defined YES (
        choice /c YN /m "  Pi not found. Install it"
        if errorlevel 2 set "DOPI="
    )
    if defined DOPI (
        call :install_pi
        if errorlevel 1 goto failed
    ) else (
        echo   WARNING: Pi was not installed. Run "pi-config pi" later.
    )
)
echo.
echo   === Step 3 of 5: import config ===
echo.
node bin\import.js
if errorlevel 1 goto failed
echo.
echo   === Step 4 of 5: install extensions ===
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
echo   === Step 5 of 5: VS Code terminal bridge ===
node bin\vscode-bridge.js --if-available
if errorlevel 1 echo   WARNING: the VS Code bridge was not installed. Run "pi-config vscode" to retry.
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
echo     vscode     build and install the VS Code terminal bridge
echo     node       install the latest Node LTS ^(winget^)
echo     pi         install Pi, or update it when already installed
echo     setup      install Node and Pi if needed, import, install, VS Code bridge
echo                ^(add --yes to skip the questions^)
echo.
echo   Run with no arguments for an interactive menu.
exit /b 0

REM ---------------------------------------------------------------------------
:need_node
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   ERROR: Node.js was not found on PATH.
    echo   Run "pi-config node" to install it, then try again.
    exit /b 1
)
exit /b 0

:node_ok
where node >nul 2>nul
if errorlevel 1 exit /b 1
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)"
exit /b %ERRORLEVEL%

:install_node
where winget >nul 2>nul
if errorlevel 1 (
    echo   ERROR: winget not found. Install Node LTS from https://nodejs.org/
    exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
    winget install --exact --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if errorlevel 1 exit /b 1
) else (
    winget upgrade --exact --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if errorlevel 1 echo   Note: winget reported no upgrade ^(Node may already be current^).
)
set "PATH=%ProgramFiles%\nodejs;%PATH%"
node -v
exit /b 0

:install_pi
where pi >nul 2>nul
if errorlevel 1 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://pi.dev/install.ps1 | iex"
    exit /b %ERRORLEVEL%
)
call pi update
exit /b %ERRORLEVEL%

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
