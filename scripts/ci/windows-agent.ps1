# SPDX-License-Identifier: GPL-3.0-or-later
# Trusted controller: wake WSL and dispatch native work under a different identity.
param([Parameter(Mandatory = $true)][string]$Config)
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
foreach ($name in @('Inbox', 'WorkRoot', 'OutputRoot', 'WindowsScript', 'ToolsPath', 'BuildTask', 'BuildSid', 'Distribution', 'LinuxUser', 'LinuxConfig', 'LinuxController', 'LinuxLock')) {
    if (-not $settings.$name) { throw "Missing host setting: $name" }
}
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -eq $settings.BuildSid) { throw 'The dispatcher must not run as the build account.' }
$nativeTimeoutSeconds = 25 * 60
if ($null -ne $settings.NativeTimeoutSeconds) { $nativeTimeoutSeconds = [int]$settings.NativeTimeoutSeconds }
if ($nativeTimeoutSeconds -lt 1 -or $nativeTimeoutSeconds -gt (25 * 60)) { throw 'NativeTimeoutSeconds must be between 1 and 1500, below the controller receipt timeout.' }

function Assert-PlainPath([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse points are not allowed: $Path" }
}
function Quote-Argument([string]$Value) {
    if ($Value.Contains('"') -or $Value.EndsWith('\')) { throw 'Invalid host argument.' }
    if ($Value -match '\s') { return '"' + $Value + '"' }
    return $Value
}
foreach ($path in @($settings.Inbox, $settings.WorkRoot, $settings.OutputRoot)) { Assert-PlainPath $path }
$transcriptStarted = $false
if ($settings.LogRoot) {
    Start-Transcript -LiteralPath (Join-Path $settings.LogRoot 'dispatcher.log') -Append | Out-Null
    $transcriptStarted = $true
}
$linuxArgs = @('--distribution', $settings.Distribution, '--user', $settings.LinuxUser, '--exec',
    '/usr/bin/env', "PROTONN_CI_CONFIG=$($settings.LinuxConfig)", '/usr/bin/flock', '-n', '-E', '75', $settings.LinuxLock,
    '/usr/local/bin/node', $settings.LinuxController) | ForEach-Object { Quote-Argument $_ }
$linuxStart = @{ FilePath = "$env:WINDIR\System32\wsl.exe"; ArgumentList = $linuxArgs; WindowStyle = 'Hidden'; PassThru = $true }
if ($settings.LogRoot) {
    $linuxStart.RedirectStandardOutput = Join-Path $settings.LogRoot 'wsl.stdout.log'
    $linuxStart.RedirectStandardError = Join-Path $settings.LogRoot 'wsl.stderr.log'
}
$linux = Start-Process @linuxStart
$null = $linux.Handle # Retain the process handle so PowerShell 5.1 preserves its exit status.
$nativeFailed = $false
try {
    do {
        foreach ($directory in Get-ChildItem -LiteralPath $settings.Inbox -Directory) {
            if ($directory.Name -notmatch '^\d+$') { continue }
            Assert-PlainPath $directory.FullName
            $requestPath = Join-Path $directory.FullName 'request.json'
            $resultPath = Join-Path $directory.FullName 'result.json'
            if (-not (Test-Path -LiteralPath $requestPath) -or (Test-Path -LiteralPath $resultPath)) { continue }
            $receipt = @{ success = $false }
            try {
                Assert-PlainPath $requestPath
                $request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
                if ($request.sha -notmatch '^[a-f0-9]{40}$' -or $request.runId -cne $directory.Name) { throw 'Invalid installer request' }
                $receipt.sha = $request.sha
                $checkout = Join-Path $settings.WorkRoot $directory.Name
                $output = Join-Path $settings.OutputRoot $directory.Name
                # Failed attempts are diagnostic evidence; retries use a fresh run ID.
                if ((Test-Path -LiteralPath $checkout) -or (Test-Path -LiteralPath $output)) { throw 'Native attempt paths already exist; retry with a fresh run ID.' }
                $task = Get-ScheduledTask -TaskName $settings.BuildTask
                if ($task.State -in @('Running', 'Queued')) { throw 'The native build task is already active.' }
                $taskIdentity = ([Security.Principal.NTAccount]::new($task.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
                if ($taskIdentity -cne $settings.BuildSid -or $task.Principal.RunLevel -ne 'Limited') { throw 'Native build task identity or privilege mismatch.' }
                $dispatch = @{ ExpectedSid = $settings.BuildSid; RequestDirectory = $directory.FullName; Checkout = $checkout;
                    OutputDirectory = $output; WindowsScript = $settings.WindowsScript; ToolsPath = $settings.ToolsPath }
                $dispatchPath = Join-Path $settings.Inbox 'native-job.json'
                [IO.File]::WriteAllText($dispatchPath, ($dispatch | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
                $previousRun = (Get-ScheduledTaskInfo -TaskName $settings.BuildTask).LastRunTime
                # Task Scheduler creates a separate batch logon, with no inherited controller token or environment.
                Start-ScheduledTask -TaskName $settings.BuildTask
                $startDeadline = [DateTime]::UtcNow.AddSeconds(30)
                $executionDeadline = [DateTime]::UtcNow.AddSeconds($nativeTimeoutSeconds)
                do {
                    Start-Sleep -Seconds 2
                    $task = Get-ScheduledTask -TaskName $settings.BuildTask
                    $info = Get-ScheduledTaskInfo -TaskName $settings.BuildTask
                    if ($task.State -in @('Running', 'Queued') -and [DateTime]::UtcNow -gt $executionDeadline) {
                        Stop-ScheduledTask -TaskName $settings.BuildTask
                        throw "Native build exceeded its $nativeTimeoutSeconds second deadline and was stopped."
                    }
                    if ($info.LastRunTime -eq $previousRun -and [DateTime]::UtcNow -gt $startDeadline) {
                        if ($task.State -in @('Running', 'Queued')) { Stop-ScheduledTask -TaskName $settings.BuildTask }
                        throw 'Native build task did not start.'
                    }
                } while ($task.State -in @('Running', 'Queued') -or $info.LastRunTime -eq $previousRun)
                if ($info.LastTaskResult -ne 0) { throw "Native build failed with exit code $($info.LastTaskResult); see its per-attempt log." }
                $receipt.success = $true
            } catch {
                $nativeFailed = $true
                $receipt.error = $_.Exception.Message
                Write-Error -ErrorAction Continue $_
            }
            [IO.File]::WriteAllText($resultPath + '.tmp', ($receipt | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath ($resultPath + '.tmp') -Destination $resultPath
        }
        if (-not $linux.HasExited) { Start-Sleep -Seconds 3; $linux.Refresh() }
    } while (-not $linux.HasExited)
    $linux.WaitForExit()
    $linuxExitCode = $linux.ExitCode
    Write-Output "WSL controller exit code: $linuxExitCode"
    # Only the dedicated flock contention code is a healthy no-op. Preserve controller failures.
    if ($linuxExitCode -notin @(0, 75)) { exit $linuxExitCode }
    if ($nativeFailed) { exit 1 }
} finally { $linux.Dispose(); if ($transcriptStarted) { Stop-Transcript | Out-Null } }
