@echo off
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"

set "NODE_ENV=production"
set "AGENT_MEETINGS_CONFIG=%ROOT%config\meetings.config.yml"
set "AGENT_MEETINGS_ENV_FILE=%ROOT%config\settings.env"
set "AGENT_MEETINGS_HOME=%ROOT%data"
set "PLAYWRIGHT_BROWSERS_PATH=%ROOT%runtime\ms-playwright"

"%ROOT%runtime\node.exe" "%ROOT%app\dist\cli\index.js" %*
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%
