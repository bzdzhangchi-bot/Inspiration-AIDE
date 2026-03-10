@echo off
where mvn >nul 2>nul
if %errorlevel%==0 (
  mvn %*
  exit /b %errorlevel%
)
echo Maven is not installed on this machine.
echo Install Maven first, then rerun this command.
exit /b 1
