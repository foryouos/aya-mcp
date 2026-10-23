@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  AYA release build  (current platform)
echo  version: %npm_package_version%
echo ============================================
echo.

REM Prepare assets like adb / scrcpy if needed.
REM Uncomment the two lines below for the first-time packaging.
REM call npm run adb
REM call npm run scrcpy

call npm run release
if not "%ERRORLEVEL%"=="0" (
  echo.
  echo [release] build failed with exit code %ERRORLEVEL%
  pause
  exit /b %ERRORLEVEL%
)

echo.
echo [release] done. Artifacts are in release\%npm_package_version%\
pause
