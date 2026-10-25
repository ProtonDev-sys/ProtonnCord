# SPDX-License-Identifier: GPL-3.0-or-later
# Trusted wrapper. Everything below source checkout runs as the native build user.
param(
    [Parameter(Mandatory = $true)][string]$DispatchFile
)
$ErrorActionPreference = 'Stop'
try {
    $dispatch = Get-Content -LiteralPath $DispatchFile -Raw | ConvertFrom-Json
    foreach ($name in @('ExpectedSid', 'RequestDirectory', 'Checkout', 'OutputDirectory', 'WindowsScript', 'ToolsPath')) {
        if (-not $dispatch.$name) { throw "Missing native job setting: $name" }
        Set-Variable -Name $name -Value $dispatch.$name
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.User.Value -cne $ExpectedSid) { throw 'Native build identity mismatch.' }
    if (@($identity.Groups | ForEach-Object { $_.Value }) -contains 'S-1-5-32-544') { throw 'Native builds must not belong to Administrators.' }
    if ((Test-Path -LiteralPath $Checkout) -or (Test-Path -LiteralPath $OutputDirectory)) { throw 'Native attempt paths must be new.' }
    Start-Transcript -LiteralPath ($Checkout + '.log') | Out-Null
    $buildProfile = (Get-ItemProperty -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $ExpectedSid)).ProfileImagePath
    $systemRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
    $machineProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
    # Construct a build-only environment even if the machine defines extra variables.
    foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    $environment = @{
        OS = 'Windows_NT'; SystemRoot = $systemRoot; WINDIR = $systemRoot
        PATH = "$ToolsPath;$machineProgramFiles\Git\cmd;$systemRoot\System32;$systemRoot;$systemRoot\System32\WindowsPowerShell\v1.0"
        PATHEXT = '.COM;.EXE;.BAT;.CMD'; COMSPEC = "$systemRoot\System32\cmd.exe"
        USERPROFILE = $buildProfile; HOME = $buildProfile; HOMEDRIVE = [IO.Path]::GetPathRoot($buildProfile).TrimEnd('\'); HOMEPATH = $buildProfile.Substring(2)
        APPDATA = "$buildProfile\AppData\Roaming"; LOCALAPPDATA = "$buildProfile\AppData\Local"
        TEMP = "$buildProfile\AppData\Local\Temp"; TMP = "$buildProfile\AppData\Local\Temp"
        ProgramFiles = $machineProgramFiles; ProgramW6432 = $machineProgramFiles
        'ProgramFiles(x86)' = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
        ProgramData = ([IO.Path]::GetPathRoot($systemRoot) + 'ProgramData'); ALLUSERSPROFILE = ([IO.Path]::GetPathRoot($systemRoot) + 'ProgramData')
        COREPACK_HOME = "$buildProfile\AppData\Local\node\corepack"; COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
        GIT_CONFIG_NOSYSTEM = '1'; GIT_CONFIG_GLOBAL = 'NUL'; GIT_TERMINAL_PROMPT = '0'; CI = 'true'
    }
    foreach ($name in $environment.Keys) { [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process') }
    New-Item -ItemType Directory -Path $env:TEMP, $env:APPDATA, $env:COREPACK_HOME -Force | Out-Null
    $request = Get-Content -LiteralPath (Join-Path $RequestDirectory 'request.json') -Raw | ConvertFrom-Json
    if ($request.sha -notmatch '^[a-f0-9]{40}$' -or $request.runId -cne (Split-Path -Leaf $RequestDirectory)) { throw 'Invalid native request.' }
    Write-Output "Native job identity: $($identity.Name) ($ExpectedSid); source: $($request.sha)"
    & git.exe -c credential.helper= clone --filter=blob:none --no-checkout https://github.com/ProtonDev-sys/ProtonnCord.git $Checkout
    if ($LASTEXITCODE) { throw 'Windows source clone failed.' }
    & git.exe -C $Checkout -c credential.helper= fetch --no-tags origin $request.sha
    if ($LASTEXITCODE) { throw 'Windows source fetch failed.' }
    & git.exe -C $Checkout checkout --force --detach $request.sha
    if ($LASTEXITCODE) { throw 'Windows source checkout failed.' }
    New-Item -ItemType Directory -Path (Join-Path $Checkout 'dist') | Out-Null
    foreach ($name in @('desktop.asar', 'desktop.asar.sha256')) {
        $source = Join-Path $RequestDirectory $name
        if ((Get-Item -LiteralPath $source).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Native payload cannot be a reparse point.' }
        Copy-Item -LiteralPath $source -Destination (Join-Path $Checkout ('dist/' + $name))
    }
    & $WindowsScript -Checkout $Checkout -Sha $request.sha -OutputDirectory $OutputDirectory -InstallDependencies
    if (-not $?) { throw 'Windows installer build failed.' }
} catch {
    Write-Error -ErrorAction Continue $_
    exit 1
}
