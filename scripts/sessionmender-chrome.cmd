@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0.."
if errorlevel 1 exit /b 1

set "backend=%CD%\target\debug\agentmender.exe"
if not exist "%backend%" (
    echo SessionMender has not been built. Run cargo build from the project directory.
    goto failed
)

set "chrome_executable=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%chrome_executable%" set "chrome_executable=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%chrome_executable%" set "chrome_executable=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not exist "%chrome_executable%" (
    echo Google Chrome was not found.
    goto failed
)

if not defined SESSIONMENDER_CODEX_GLB set "SESSIONMENDER_CODEX_GLB=%CD%\ui\.local\codex.glb"
if not defined SESSIONMENDER_CLAWD_GLB set "SESSIONMENDER_CLAWD_GLB=%CD%\ui\.local\Clawd-Animator.glb"
"%backend%" ui --browser-executable "%chrome_executable%"
if errorlevel 1 goto failed

popd
exit /b 0

:failed
popd
pause
exit /b 1
