# Installs "Slack Threads" for the normal Slack (your usual profile and sign-in):
#   - copies the watcher and the threads script to %USERPROFILE%\.slack-channel-threads\app
#     (not AppData: a shell inside a packaged app, e.g. Claude desktop or another MSIX app, has
#     its AppData writes redirected into a private folder that Windows' autostart never sees)
#   - sets the user environment variable SLACK_DEVELOPER_MENU=true so Slack always shows
#     menu > View > Developer (needed for "Enable Main Process Inspector")
#   - registers a Task Scheduler task "SlackThreads" that starts the watcher, without a window,
#     when you sign in to Windows
# After each Slack start: menu > View > Developer > Enable Main Process Inspector. That's it.
#
# Uninstall: powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = "Stop"

$data     = Join-Path $env:USERPROFILE ".slack-channel-threads"
$app      = Join-Path $data "app"
$taskName = "SlackThreads"

# Autostart methods from earlier versions. On a real reboot Windows ran neither of them.
function Remove-Legacy {
  $programs = [Environment]::GetFolderPath("Programs")
  foreach ($p in @((Join-Path ([Environment]::GetFolderPath("Startup")) "Slack Threads.lnk"),
                   (Join-Path $programs "Slack Threads.lnk"),
                   (Join-Path $programs "Slack Threads - sign in from copied link.lnk"))) {
    if (Test-Path $p) { Remove-Item $p; "removed $p" }
  }
  $run = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  if (Get-ItemProperty $run -Name $taskName -ErrorAction SilentlyContinue) {
    Remove-ItemProperty $run -Name $taskName; "removed Run entry $taskName"
  }
  # Old install location (%LOCALAPPDATA%\SlackThreads).
  $old = Join-Path $env:LOCALAPPDATA "SlackThreads"
  if (Test-Path $old) { Remove-Item -Recurse -Force $old; "removed old install folder $old" }
}

function Stop-Watcher {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'slack-threads-(watcher|launcher)\.mjs' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped watcher pid $($_.ProcessId)" }
}

if ($Uninstall) {
  Stop-Watcher
  Remove-Legacy
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; "removed scheduled task $taskName"
  }
  [Environment]::SetEnvironmentVariable("SLACK_DEVELOPER_MENU", $null, "User")
  "removed SLACK_DEVELOPER_MENU (Slack drops the Developer menu after its next restart)"
  "Files stay in $data; delete the folder if you want them gone."
  return
}

$node = (Get-Command node -ErrorAction Stop).Source
Stop-Watcher
Remove-Legacy

New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item (Join-Path $PSScriptRoot "slack-channel-threads.js") $app -Force
Copy-Item (Join-Path $PSScriptRoot "slack-threads-watcher.mjs") $app -Force
$watcher = Join-Path $app "slack-threads-watcher.mjs"

[Environment]::SetEnvironmentVariable("SLACK_DEVELOPER_MENU", "true", "User")
"set SLACK_DEVELOPER_MENU=true for your user"

# Hidden starter: runs node without a console window, waits up to a minute for node and the
# watcher to be reachable, and logs every start (or the error) to startup.log.
$vbs = Join-Path $app "start-hidden.vbs"
$startupLog = Join-Path $data "startup.log"
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

$user = "$env:USERDOMAIN\$env:USERNAME"
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
$action = New-ScheduledTaskAction -Execute $wscript -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = "PT15S"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description "Adds active threads under channels to Slack (github.com/davidmcarati/slack-channel-threads)" -Force | Out-Null
"registered scheduled task $taskName (at sign-in)"

# Start it now too, so there's no need to sign out and back in.
Start-ScheduledTask -TaskName $taskName
"watcher started"
"Installed to $app"
