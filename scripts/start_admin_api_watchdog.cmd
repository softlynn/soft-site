@echo off
setlocal
cd /d "C:\Users\Alex2\Documents\soft-site"
:loop
node "C:\Users\Alex2\Documents\soft-site\scripts\run_local_admin_api.mjs" >> "C:\Users\Alex2\Documents\soft-site\scripts\.state\admin-api.log" 2>&1
timeout /t 5 /nobreak >nul
goto loop
