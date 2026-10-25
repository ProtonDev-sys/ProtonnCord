# SPDX-License-Identifier: GPL-3.0-or-later
# Native dispatcher and WSL wake-up, invoked by one non-overlapping Scheduled Task.
param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
if ($settings.ToolsPath) { $env:Path = $settings.ToolsPath + ';' + $env:Path }
foreach ($name in @('Inbox', 'WorkRoot', 'OutputRoot', 'WindowsScript', 'Distribution', 'LinuxUser', 'LinuxConfig', 'LinuxController', 'LinuxLock')) {
    if (-not $settings.$name) { throw "Missing host setting: $name" }
}
New-Item -ItemType Directory -Path $settings.Inbox, $settings.WorkRoot, $settings.OutputRoot -Force | Out-Null
$linuxArgs = @('--distribution', $settings.Distribution, '--user', $settings.LinuxUser, '--exec',
    '/usr/bin/env', "PROTONN_CI_CONFIG=$($settings.LinuxConfig)", '/usr/bin/flock', '-n', $settings.LinuxLock,
    '/usr/local/bin/node', $settings.LinuxController)
$linux = Start-Process -FilePath 'wsl.exe' -ArgumentList $linuxArgs -WindowStyle Hidden -PassThru
try {
    do {
        foreach ($directory in Get-ChildItem -LiteralPath $settings.Inbox -Directory) {
            if ($directory.Name -notmatch '^\d+$') { continue }
            $requestPath = Join-Path $directory.FullName 'request.json'
            $resultPath = Join-Path $directory.FullName 'result.json'
            if (-not (Test-Path -LiteralPath $requestPath) -or (Test-Path -LiteralPath $resultPath)) { continue }
            $request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
            if ($request.sha -notmatch '^[a-f0-9]{40}$' -or $request.runId -ne $directory.Name) { throw 'Invalid installer request' }
            $checkout = [IO.Path]::GetFullPath((Join-Path $settings.WorkRoot $directory.Name))
            if ([IO.Path]::GetDirectoryName($checkout) -ne [IO.Path]::GetFullPath($settings.WorkRoot).TrimEnd('\')) { throw 'Unsafe Windows checkout' }
            $receipt = @{ sha = $request.sha; success = $false }
            try {
                if (-not (Test-Path -LiteralPath (Join-Path $checkout '.git'))) {
                    & git -c credential.helper= clone --filter=blob:none --no-checkout https://github.com/ProtonDev-sys/ProtonnCord.git $checkout
                    if ($LASTEXITCODE) { throw 'Windows source clone failed' }
                }
                & git -C $checkout -c credential.helper= fetch --no-tags origin $request.sha
                if ($LASTEXITCODE) { throw 'Windows source fetch failed' }
                & git -C $checkout checkout --force --detach $request.sha
                if ($LASTEXITCODE) { throw 'Windows source checkout failed' }
                New-Item -ItemType Directory -Path (Join-Path $checkout 'dist') -Force | Out-Null
                Copy-Item -LiteralPath (Join-Path $directory.FullName 'desktop.asar') -Destination (Join-Path $checkout 'dist/desktop.asar')
                Copy-Item -LiteralPath (Join-Path $directory.FullName 'desktop.asar.sha256') -Destination (Join-Path $checkout 'dist/desktop.asar.sha256')
                $output = Join-Path $settings.OutputRoot $directory.Name
                & $settings.WindowsScript -Checkout $checkout -Sha $request.sha -OutputDirectory $output -InstallDependencies
                if (-not $?) { throw 'Windows installer build failed' }
                $receipt.success = $true
            } catch {
                $receipt.error = $_.Exception.Message
                Write-Error -ErrorAction Continue $_
            }
            [IO.File]::WriteAllText($resultPath + '.tmp', ($receipt | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath ($resultPath + '.tmp') -Destination $resultPath
        }
        if (-not $linux.HasExited) { Start-Sleep -Seconds 3; $linux.Refresh() }
    } while (-not $linux.HasExited)
    exit $linux.ExitCode
} finally { $linux.Dispose() }
