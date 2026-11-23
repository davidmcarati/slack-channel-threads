# Installs "Slack Threads" for the normal Slack (your usual profile and sign-in):
#   - copies the watcher and the threads script to %LOCALAPPDATA%\SlackThreads\app
#   - sets the user environment variable SLACK_DEVELOPER_MENU=true so Slack always shows
#     menu > View > Developer (needed for "Enable Main Process Inspector")
#   - adds a "SlackThreads" entry under HKCU\...\CurrentVersion\Run that starts the watcher
#     hidden at Windows sign-in (the same place most apps register their autostart)
# After each Slack start: menu > View > Developer > Enable Main Process Inspector. That's it.
#
# Uninstall: powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = "Stop"

$data    = Join-Path $env:LOCALAPPDATA "SlackThreads"
$app     = Join-Path $data "app"
$runKey  = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runName = "SlackThreads"
$programs = [Environment]::GetFolderPath("Programs")
# Shortcuts from earlier versions: the Startup-folder one was not run reliably at sign-in.
$legacy  = @((Join-Path ([Environment]::GetFolderPath("Startup")) "Slack Threads.lnk"),
             (Join-Path $programs "Slack Threads.lnk"), (Join-Path $programs "Slack Threads - sign in from copied link.lnk"))

function Stop-Watcher {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'slack-threads-(watcher|launcher)\.mjs' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped watcher pid $($_.ProcessId)" }
}

if ($Uninstall) {
  Stop-Watcher
  foreach ($p in $legacy) { if (Test-Path $p) { Remove-Item $p; "removed $p" } }
  if (Get-ItemProperty $runKey -Name $runName -ErrorAction SilentlyContinue) {
    Remove-ItemProperty $runKey -Name $runName; "removed autostart entry $runName"
  }
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
$startupLog = Join-Path $data "startup.log"
# Hidden starter. At sign-in, drives and folders can show up late, so wait for node and the
# watcher (up to a minute), and write problems to startup.log instead of popping a dialog.
@"
On Error Resume Next
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
node = "$node"
watcher = "$watcher"
logPath = "$startupLog"
For i = 1 To 30
  If fso.FileExists(node) And fso.FileExists(watcher) Then Exit For
  WScript.Sleep 2000
Next
Err.Clear
sh.Run Chr(34) & node & Chr(34) & " " & Chr(34) & watcher & Chr(34), 0, False
msg = Now & " start: node=" & fso.FileExists(node) & " watcher=" & fso.FileExists(watcher)
If Err.Number <> 0 Then msg = msg & " FAILED " & Err.Number & " " & Err.Description Else msg = msg & " ok"
Set f = fso.OpenTextFile(logPath, 8, True)
f.WriteLine msg
f.Close
"@ | Set-Content -Encoding ASCII $vbs

[Environment]::SetEnvironmentVariable("SLACK_DEVELOPER_MENU", "true", "User")
"set SLACK_DEVELOPER_MENU=true for your user"

$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
Set-ItemProperty $runKey -Name $runName -Value "`"$wscript`" `"$vbs`""
"autostart entry: $runKey\$runName"
Remove-Item -Force (Join-Path $app "slack.ico") -ErrorAction SilentlyContinue

# Start it now too, so there's no need to sign out and back in.
Start-Process -FilePath $wscript -ArgumentList "`"$vbs`""
"watcher started"
"Installed to $app"
