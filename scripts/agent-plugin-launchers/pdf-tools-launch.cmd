@echo off
setlocal EnableExtensions DisableDelayedExpansion
goto :main

:try_node
if not exist "%~1" exit /b 0
set "PDF_TOOLS_SAW_NODE=1"
"%~1" "%PDF_TOOLS_ROOT%\bin\check-node-version.cjs" >nul 2>nul
if not errorlevel 1 set "PDF_TOOLS_NODE=%~1"
exit /b 0

:scan_nvm_home
if "%~1"=="" exit /b 0
call :try_node "%~1\node.exe"
if defined PDF_TOOLS_NODE exit /b 0
for /d %%D in ("%~1\v*") do (
  call :try_node "%%~fD\node.exe"
)
exit /b 0

:main
for %%I in ("%~dp0..") do set "PDF_TOOLS_ROOT=%%~fI"
set "PDF_TOOLS_NODE="
set "PDF_TOOLS_SAW_NODE="

for /f "usebackq delims=" %%N in (`where node.exe 2^>nul`) do (
  call :try_node "%%~fN"
)

if not defined PDF_TOOLS_NODE if defined NVM_SYMLINK call :try_node "%NVM_SYMLINK%\node.exe"
if not defined PDF_TOOLS_NODE if defined NVM_HOME call :scan_nvm_home "%NVM_HOME%"
if not defined PDF_TOOLS_NODE if defined APPDATA call :scan_nvm_home "%APPDATA%\nvm"
if not defined PDF_TOOLS_NODE if defined LOCALAPPDATA call :scan_nvm_home "%LOCALAPPDATA%\nvm"

if not defined PDF_TOOLS_NODE (
  if defined PDF_TOOLS_SAW_NODE (
    1>&2 echo PDF Tools found Node.js, but not a supported version.
  ) else (
    1>&2 echo PDF Tools could not find Node.js in PATH or your NVM installation.
  )
  1>&2 echo Install or select Node.js 20.19+ or 22.12+, then restart Codex.
  1>&2 echo If you use NVM for Windows, select a version with: nvm use ^<version^>
  endlocal & exit /b 127
)

"%PDF_TOOLS_NODE%" "%PDF_TOOLS_ROOT%\server\index.js" %*
set "PDF_TOOLS_EXIT=%errorlevel%"
endlocal & exit /b %PDF_TOOLS_EXIT%
