@echo off
"%~dp0ChameleonTabsHost.exe" --recover
if errorlevel 1 (
  echo Close Chrome and try again. If the error persists, send the text above to Chameleon Tabs support.
) else (
  echo Chameleon Windows recovery finished.
)
pause
