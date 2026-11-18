@echo off
setlocal
set "TASK_EXIT_CODE=1"

pushd "%~dp0.."
if errorlevel 1 goto done

where node >nul 2>nul
if errorlevel 1 goto node_missing
where npm >nul 2>nul
if errorlevel 1 goto node_missing

echo Checking Node.js and npm:
call node --version
call npm --version

echo.
echo Installing project dependencies (without a package-lock file)...
call npm install --no-save --no-package-lock --ignore-scripts
if errorlevel 1 goto install_failed

echo.
echo Installing Playwright Chromium (download may take several minutes)...
call npx --no-install playwright install chromium
if errorlevel 1 goto install_failed

echo.
echo Testing access to the Sumida reservation site, without LINE messages...
call node windows\probe-sumida.mjs
set "TASK_EXIT_CODE=%ERRORLEVEL%"
goto done_in_repo

:node_missing
echo ERROR: Node.js/npm not found. Install the Windows LTS installer from:
echo https://nodejs.org/en/download/
goto done_in_repo

:install_failed
echo ERROR: Required packages or Chromium could not be installed.
goto done_in_repo

:done_in_repo
popd

:done
echo.
echo Send the result line SUMIDA_PROBE_OK or SUMIDA_PROBE_FAILED to ChatGPT.
echo Do not share access tokens or other credentials.
pause
exit /b %TASK_EXIT_CODE%
