# Installs "Slack Threads" for the normal Slack (your usual profile and sign-in):
#   - copies the watcher and the threads script to %LOCALAPPDATA%\SlackThreads\app
#   - sets the user environment variable SLACK_DEVELOPER_MENU=true so Slack always shows
#     menu > View > Developer (needed for "Enable Main Process Inspector")
#   - adds a Startup shortcut that runs the watcher hidden at Windows sign-in
# After each Slack start: menu > View > Developer > Enable Main Process Inspector. That's it.
#
# Uninstall: powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = "Stop"

$data    = Join-Path $env:LOCALAPPDATA "SlackThreads"
$app     = Join-Path $data "app"
$startup = Join-Path ([Environment]::GetFolderPath("Startup")) "Slack Threads.lnk"
$programs = [Environment]::GetFolderPath("Programs")
# Shortcuts from the earlier separate-profile version.
$legacy  = @((Join-Path $programs "Slack Threads.lnk"), (Join-Path $programs "Slack Threads - sign in from copied link.lnk"))

function Stop-Watcher {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'slack-threads-(watcher|launcher)\.mjs' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped watcher pid $($_.ProcessId)" }
}

if ($Uninstall) {
  Stop-Watcher
  foreach ($p in @($startup) + $legacy) { if (Test-Path $p) { Remove-Item $p; "removed $p" } }
  [Environment]::SetEnvironmentVariable("SLACK_DEVELOPER_MENU", $null, "User")
  "removed SLACK_DEVELOPER_MENU (Slack drops the Developer menu after its next restart)"
  "Files stay in $data; delete the folder if you want them gone."
  return
}

$node = (Get-Command node -ErrorAction Stop).Source
Stop-Watcher
foreach ($p in $legacy) { if (Test-Path $p) { Remove-Item $p; "removed old $p" } }
Remove-Item -Force (Join-Path $app "slack-threads-launcher.mjs"), (Join-Path $app "sign-in-from-clipboard.cmd") -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item (Join-Path $PSScriptRoot "slack-channel-threads.js") $app -Force
Copy-Item (Join-Path $PSScriptRoot "slack-threads-watcher.mjs") $app -Force

$watcher = Join-Path $app "slack-threads-watcher.mjs"
$vbs = Join-Path $app "start-hidden.vbs"
@"
Set sh = CreateObject("WScript.Shell")
sh.Run """$node"" ""$watcher""", 0, False
"@ | Set-Content -Encoding ASCII $vbs

[Environment]::SetEnvironmentVariable("SLACK_DEVELOPER_MENU", "true", "User")
"set SLACK_DEVELOPER_MENU=true for your user"

$ico = Join-Path $app "slack.ico"
if (-not (Test-Path $ico)) {
  try {
    Add-Type -AssemblyName System.Drawing
    $pkg = (Get-AppxPackage com.tinyspeck.slackdesktop).InstallLocation
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Join-Path $pkg "app\Slack.exe"))
    $fs = [System.IO.File]::Create($ico); $icon.Save($fs); $fs.Close()
  } catch { $ico = $null }
}

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($startup)
$lnk.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
$lnk.Arguments = "`"$vbs`""
$lnk.WorkingDirectory = $app
$lnk.Description = "Adds active threads under channels to Slack"
if ($ico) { $lnk.IconLocation = "$ico,0" }
$lnk.Save()
"created $startup"

# Start it now too, so there's no need to sign out and back in.
Start-Process -FilePath (Join-Path $env:WINDIR "System32\wscript.exe") -ArgumentList "`"$vbs`""
"watcher started"
"Installed to $app"
