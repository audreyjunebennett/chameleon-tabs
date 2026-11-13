@echo off
setlocal
set "CHAMELEON_SOURCE=%~dp0payload"
powershell.exe -NoProfile -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$source = $env:CHAMELEON_SOURCE; $dest = Join-Path $env:LOCALAPPDATA 'Programs\ChameleonTabs';" ^
  "$key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.local.desktop_app_tabs';" ^
  "$manifest = Join-Path $dest 'host.json';" ^
  "if (Test-Path $key) { $current = (Get-Item -LiteralPath $key).GetValue(''); if ($current -and $current -ne $manifest) { throw 'A different Desktop App Tabs helper is already registered for this Windows account.' } }" ^
  "if (Test-Path (Join-Path $dest 'restore-windows.json')) { throw 'Return attached apps to the desktop before updating Chameleon Tabs.' }" ^
  "if (!(Test-Path (Join-Path $source 'ChameleonTabsHost.exe')) -or !(Test-Path (Join-Path $source 'extension\manifest.json'))) { throw 'Extract the entire ZIP before running this installer.' }" ^
  "New-Item -ItemType Directory -Path $dest -Force | Out-Null;" ^
  "Copy-Item -LiteralPath (Join-Path $source 'ChameleonTabsHost.exe') -Destination $dest -Force;" ^
  "Copy-Item -LiteralPath (Join-Path $source 'Restore Chameleon Windows.cmd') -Destination $dest -Force;" ^
  "Copy-Item -LiteralPath (Join-Path $source 'extension') -Destination $dest -Recurse -Force;" ^
  "$hostConfig = @{ name = 'com.local.desktop_app_tabs'; description = 'Chameleon Tabs Windows helper'; path = (Join-Path $dest 'ChameleonTabsHost.exe'); type = 'stdio'; allowed_origins = @('chrome-extension://nonkpmheiinadgbgcflnmhlgmchblaco/') };" ^
  "[IO.File]::WriteAllText($manifest, ($hostConfig | ConvertTo-Json));" ^
  "New-Item -Path $key -Force | Out-Null; Set-Item -LiteralPath $key -Value $manifest;" ^
  "$menu = [Environment]::GetFolderPath('Programs'); $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $menu 'Restore Chameleon Windows.lnk')); $shortcut.TargetPath = Join-Path $dest 'Restore Chameleon Windows.cmd'; $shortcut.Save();" ^
  "Write-Host ''; Write-Host 'Installed. Open chrome://extensions in Chrome.'; Write-Host 'Enable Developer mode, click Load unpacked, and select this folder:'; Write-Host (Join-Path $dest 'extension');"
if errorlevel 1 (
  pause
  exit /b 1
)
pause
