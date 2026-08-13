@echo off
rem Agent World server (Tessa) — keeps the server running on this PC.
rem Started automatically at logon via the Startup folder; close this window to stop.
title Agent World server (Tessa)
cd /d C:\Users\ClaimsEmail\agent-world
:loop
rem keep the log from growing forever
for %%A in (server.log) do if %%~zA gtr 5000000 move /y server.log server.log.old >nul 2>nul
echo [%date% %time%] starting server... >> server.log
call npm start >> server.log 2>&1
echo [%date% %time%] server exited - restarting in 10s (close this window to stop) >> server.log
timeout /t 10 /nobreak >nul
goto loop
