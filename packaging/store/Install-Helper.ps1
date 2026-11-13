param(
    [Parameter(Mandatory)]
    [string]$PackageDirectory
)

$ErrorActionPreference = 'Stop'
$storeId = (Get-Content -Raw -LiteralPath (Join-Path $PackageDirectory 'store-item-id.txt')).Trim()
if ($storeId -cnotmatch '^[a-p]{32}$') {
    throw 'This installer is missing a valid Chrome Web Store Item ID.'
}

$source = Join-Path $PackageDirectory 'payload'
$dest = Join-Path $env:LOCALAPPDATA 'Programs\ChameleonTabs'
$manifest = Join-Path $dest 'host.json'
$key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.local.desktop_app_tabs'
$files = @('ChameleonTabsHost.exe', 'Restore Chameleon Windows.cmd')
foreach ($file in $files) {
    if (!(Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) {
        throw 'Extract the whole ZIP before running the installer.'
    }
}
if (Test-Path -LiteralPath $key) {
    $current = (Get-Item -LiteralPath $key).GetValue('')
    if ($current -and $current -ne $manifest) {
        throw 'This Windows account already has a different Chamie helper installed. Contact the person who set it up before replacing it.'
    }
}
if (Test-Path -LiteralPath (Join-Path $dest 'restore-windows.json')) {
    throw 'Return attached apps to the desktop and close Chrome before updating the helper.'
}

New-Item -ItemType Directory -Path $dest -Force | Out-Null
foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $source $file) -Destination $dest -Force
}
$origins = @("chrome-extension://$storeId/")
if (Test-Path -LiteralPath (Join-Path $dest 'extension\manifest.json')) {
    $origins += 'chrome-extension://nonkpmheiinadgbgcflnmhlgmchblaco/'
}
$config = @{
    name = 'com.local.desktop_app_tabs'
    description = 'Chameleon Tabs Windows helper'
    path = Join-Path $dest 'ChameleonTabsHost.exe'
    type = 'stdio'
    allowed_origins = @($origins | Select-Object -Unique)
}
$pending = "$manifest.pending"
[IO.File]::WriteAllText($pending, ($config | ConvertTo-Json))
Move-Item -LiteralPath $pending -Destination $manifest -Force
New-Item -Path $key -Force | Out-Null
Set-Item -LiteralPath $key -Value $manifest

$menu = [Environment]::GetFolderPath('Programs')
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $menu 'Restore Chameleon Windows.lnk'))
$shortcut.TargetPath = Join-Path $dest 'Restore Chameleon Windows.cmd'
$shortcut.Save()

Write-Host 'Chamie is ready. Open a desktop app, then click the chameleon in Chrome.'
