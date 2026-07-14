@echo off
setlocal
title Agent Meetings - Browser Login
call "%~dp0agent-meetings.cmd" browser-setup
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Browser login exited with code %EXIT_CODE%.
pause
endlocal & exit /b %EXIT_CODE%
