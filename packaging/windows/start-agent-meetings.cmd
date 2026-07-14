@echo off
setlocal
title Agent Meetings
call "%~dp0agent-meetings.cmd" serve --open
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Agent Meetings exited with code %EXIT_CODE%.
  pause
)
endlocal & exit /b %EXIT_CODE%
