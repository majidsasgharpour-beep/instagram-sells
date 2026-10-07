@echo off
rem Builds the Windows installer: release\Apex-Setup-<version>.exe
rem Double-click this file. Takes a few minutes the first time.
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
echo Installing packages...
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)
echo Building the installer - this takes a few minutes...
call npm run dist
if errorlevel 1 (
  echo Build failed - see the messages above.
  pause
  exit /b 1
)
echo.
echo Done. Opening the release folder - run Apex-Setup-*.exe to install.
start "" "%~dp0release"
pause
