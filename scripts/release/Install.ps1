param(
    [ValidateSet('Install', 'Uninstall')][string]$Action = 'Install',
    [ValidateSet('stable', 'ptb', 'canary')][string]$DiscordBranch = 'stable',
    [string]$DiscordPath,
    [string]$DataDirectory = (Join-Path $env:APPDATA 'ProtonnCord')
)
$ErrorActionPreference = 'Stop'
function Get-PayloadHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
try {
    if (Get-Process -Name Discord,DiscordPTB,DiscordCanary,DiscordDevelopment -ErrorAction SilentlyContinue) {
        throw 'Discord is running. Quit Discord completely and try again.'
    }
    $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
    foreach ($name in @('EquilotlCli.exe', 'desktop.asar')) {
        $file = Join-Path $PSScriptRoot $name
        if ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing linked payload: $name" }
        $expected = $manifest.files.PSObject.Properties[$name].Value
        if (!$expected -or (Get-PayloadHash $file) -ne $expected) {
            throw "Checksum failed for $name. Download and extract a fresh release."
        }
    }
    $DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
    New-Item -ItemType Directory -Force -Path $DataDirectory | Out-Null
    if ((Get-Item -LiteralPath $DataDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked installation directory.' }
    $target = Join-Path $DataDirectory 'desktop.asar'
    $backup = $null
    if (Test-Path -LiteralPath $target) {
        if ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked installation file.' }
    }
    if ($Action -eq 'Install') {
        if (Test-Path -LiteralPath $target) {
            $backup = "$target.$([Guid]::NewGuid().ToString('N')).backup"
            Copy-Item -LiteralPath $target -Destination $backup
        }
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'desktop.asar') -Destination $target -Force
        $payloadCopied = $true
    }
    $env:EQUICORD_USER_DATA_DIR = $DataDirectory
    $env:EQUICORD_DIRECTORY = $target
    # Use our bundled production build; prevent the upstream installer downloading Equicord.
    $env:EQUICORD_DEV_INSTALL = '1'
    $installerArguments = @("--$($Action.ToLowerInvariant())")
    if ($DiscordPath) { $installerArguments += @('--location', $DiscordPath) }
    else { $installerArguments += @('--branch', $DiscordBranch) }
    Write-Host "$Action Protonn Cord $($manifest.version). Fully quit Discord before continuing."
    & (Join-Path $PSScriptRoot 'EquilotlCli.exe') @installerArguments
    if ($LASTEXITCODE -ne 0) { throw "Installer exited with code $LASTEXITCODE." }
    if ($backup) { Remove-Item -LiteralPath $backup }
    Write-Host "$Action complete. You can now start Discord."
    exit 0
} catch {
    if ($Action -eq 'Install' -and $target) {
        if ($backup -and (Test-Path -LiteralPath $backup)) { Move-Item -LiteralPath $backup -Destination $target -Force }
        elseif ($payloadCopied) { Remove-Item -LiteralPath $target }
    }
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
