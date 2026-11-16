@echo off
cd /d "%~dp0"
git config submodule.recurse false

REM Regenerate 404.html from index.html BEFORE staging, so the SPA fallback
REM that was just built is what actually ships. Without this the committed
REM 404.html drifts from index.html and deep links serve the wrong page.
node scripts\build-404.mjs
if errorlevel 1 (
  echo.
  echo BUILD FAILED - 404.html was not regenerated. Nothing was pushed.
  pause
  exit /b 1
)

REM The game catalog points to files under games/, so publish that tree along
REM with the app shell; otherwise the dashboard deploys but game iframes 404.
REM The build script and its package.json are staged so 404.html can be rebuilt
REM on a fresh clone instead of silently drifting from index.html.
git add index.html 404.html liveActivity.js *.js *.css *.json package.json scripts games
git commit -m "Update refresh handlers and real-time features"
git push origin main
echo.
echo ========================================
echo Done! Press any key to exit.
echo ========================================
pause