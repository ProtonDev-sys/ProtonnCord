# SPDX-License-Identifier: GPL-3.0-or-later
# Package an already validated WSL payload in a dedicated native Windows checkout.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Checkout,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string]$Sha,
    [string]$OutputDirectory,
    [ValidatePattern('^[a-f0-9]{64}$')][string]$PayloadSha256,
    [switch]$InstallDependencies
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$initialLocation = Get-Location
$staging = $null
$savedEnvironment = $null

function Assert-AbsolutePath([string]$Value, [string]$Name) {
    if ($Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)') {
        throw "$Name must be an absolute Windows path."
    }
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE." }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'Run this entrypoint on native Windows.' }
    # Refuse inherited release/signing credentials before launching any build process.
    $credentialNames = @(Get-ChildItem Env: | Where-Object {
        $_.Value -and $_.Name -match '(?i)(TOKEN|SECRET|PASSWORD|(?:^|_)PASS(?:WD)?(?:_|$)|API_?KEY|CREDENTIAL)'
    } | ForEach-Object { $_.Name })
    if ($credentialNames.Count) { throw ('Build environment contains credentials: ' + ($credentialNames -join ', ') + '. Remove them before starting this job.') }
    # Also exclude unrecognized account variables. This changes only this process
    # and is restored on return; the host's persistent environment is untouched.
    $savedEnvironment = [Environment]::GetEnvironmentVariables('Process')
    $allowedEnvironment = @('OS', 'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'ALLUSERSPROFILE', 'PSModulePath', 'PNPM_HOME', 'COREPACK_HOME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'LANG', 'LC_ALL')
    foreach ($name in $savedEnvironment.Keys) {
        if ($allowedEnvironment -notcontains $name) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    }
    $env:CI = 'true'
    $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
    Assert-AbsolutePath $Checkout 'Checkout'
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $git = (Get-Command git.exe -ErrorAction Stop).Source
    $Checkout = (Invoke-Checked $node @('-e', 'process.stdout.write(require(''node:fs'').realpathSync(process.argv[1]))', $Checkout)).Trim()
    Set-Location -LiteralPath $Checkout
    if ((Invoke-Checked $node @('-p', 'process.versions.node.split(''.'')[0]')).Trim() -ne '24') { throw 'Node 24 is required.' }
    $top = (Invoke-Checked $git @('rev-parse', '--show-toplevel')).Trim()
    $top = (Invoke-Checked $node @('-e', 'process.stdout.write(require(''node:fs'').realpathSync(process.argv[1]))', $top)).Trim()
    if ($top -ne $Checkout) { throw 'Checkout must be the repository root.' }
    if ((Invoke-Checked $git @('rev-parse', 'HEAD')).Trim() -cne $Sha) { throw 'Checkout HEAD does not equal Sha.' }
    if (Invoke-Checked $git @('status', '--porcelain', '--untracked-files=no')) { throw 'Tracked source must be clean.' }
    $payload = Join-Path $Checkout 'dist/desktop.asar'
    if (-not (Test-Path -LiteralPath $payload -PathType Leaf)) { throw 'Missing WSL-built dist/desktop.asar.' }
    if (-not $PayloadSha256) {
        $sidecar = [System.IO.File]::ReadAllText((Join-Path $Checkout 'dist/desktop.asar.sha256'))
        if ($sidecar -cnotmatch '^([a-f0-9]{64})  desktop\.asar\n$') { throw 'Invalid desktop.asar.sha256; supply the WSL-produced checksum.' }
        $PayloadSha256 = $Matches[1]
    }
    if ((Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant() -cne $PayloadSha256) { throw 'Transferred desktop.asar checksum mismatch.' }
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'Missing x64 .NET Framework C# compiler.' }
    $built = Join-Path $Checkout 'dist/windows'
    if (Test-Path -LiteralPath $built) { throw 'dist/windows already exists; use a fresh job checkout. Failed jobs never reuse installer outputs.' }
    if ($OutputDirectory) {
        Assert-AbsolutePath $OutputDirectory 'OutputDirectory'
        $OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory).TrimEnd([char[]]'\/')
        if ($OutputDirectory -eq $Checkout -or $OutputDirectory.StartsWith($Checkout + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'OutputDirectory must be outside the checkout; omit it to use dist/windows.'
        }
        if (Test-Path -LiteralPath $OutputDirectory) { throw 'OutputDirectory already exists; choose a fresh per-job directory.' }
    }
    if ($InstallDependencies) {
        $pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
        $expected = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).packageManager
        if ('pnpm@' + (Invoke-Checked $pnpm @('--version')).Trim() -cne $expected) { throw 'pnpm must match package.json.' }
        Invoke-Checked $pnpm @('install', '--frozen-lockfile', '--ignore-scripts')
    }
    Invoke-Checked $node @('--input-type=module', '-e', 'await import(''@electron/asar'');')
    Invoke-Checked $node @('scripts/buildWindowsInstaller.mjs')
    # Verify identities and every published file without executing the installer.
    $verify = @'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { extractFile } from "@electron/asar";
import { EQUILOTL_RELEASE, getArtifact } from "./scripts/runInstaller.mjs";
const [sha, payloadHash] = process.argv.slice(2);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const read = name => {
    const path = `dist/windows/${name}`;
    assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), `Invalid output: ${name}`);
    return readFileSync(path);
};
const names = ["ProtonnCordSetup.exe", "ProtonnCordSetup.exe.sha256", "ProtonnCordSetup.json", "ProtonnCordSetup-LICENSE.txt", "bootstrap.cjs"];
const exe = read(names[0]);
assert(exe.length > 0 && exe.length <= 128 * 1024 * 1024 && exe.subarray(0, 2).toString() === "MZ", "Invalid executable");
assert.equal(read(names[1]).toString(), `${hash(exe)}  ${names[0]}\n`);
const metadata = JSON.parse(read(names[2]));
assert.equal(metadata.repository, "ProtonDev-sys/ProtonnCord");
assert.equal(metadata.commit, sha);
assert.equal(metadata.updateBranch, "nightly");
assert.equal(metadata.version, JSON.parse(readFileSync("package.json")).version);
assert.equal(metadata.archiveSha256, payloadHash);
assert.equal(hash(readFileSync("dist/desktop.asar")), payloadHash);
assert.deepEqual(read(names[4]), extractFile("dist/desktop.asar", "bootstrap.js"));
assert.equal(metadata.bootstrapSha256, hash(read(names[4])));
assert.equal(metadata.installerSha256, getArtifact("win32").sha256);
assert.equal(metadata.installerVersion, EQUILOTL_RELEASE.tag);
assert.equal(metadata.installerSource, `https://github.com/Equicord/Equilotl/tree/${EQUILOTL_RELEASE.commit}`);
assert.deepEqual(read(names[3]), readFileSync("LICENSE"));
writeFileSync("dist/windows/windows.sha256", names.map(name => `${hash(read(name))}  ${name}\n`).join(""));
writeFileSync("dist/windows/windows-build.json", JSON.stringify({ schemaVersion: 1, commit: sha, payloadSha256: payloadHash, installerSmoke: "not-run" }, null, 2) + "\n");
'@
    # Send JavaScript over stdin: Windows PowerShell 5.1 strips nested quotes
    # from native command-line arguments, including Node's -e argument.
    $verify | & $node --input-type=module - $Sha $PayloadSha256
    if ($LASTEXITCODE -ne 0) { throw "Installer verification failed with exit code $LASTEXITCODE." }
    if ((Invoke-Checked $git @('rev-parse', 'HEAD')).Trim() -cne $Sha -or (Invoke-Checked $git @('status', '--porcelain', '--untracked-files=no'))) {
        throw 'Source changed while packaging.'
    }
    if ($OutputDirectory) {
        $parent = Split-Path -Parent $OutputDirectory
        [System.IO.Directory]::CreateDirectory($parent) | Out-Null
        $staging = $OutputDirectory + '.partial-' + [Guid]::NewGuid().ToString('N')
        [System.IO.Directory]::CreateDirectory($staging) | Out-Null
        foreach ($name in @('ProtonnCordSetup.exe', 'ProtonnCordSetup.exe.sha256', 'ProtonnCordSetup.json', 'ProtonnCordSetup-LICENSE.txt', 'bootstrap.cjs', 'windows.sha256', 'windows-build.json')) {
            $source = Join-Path $built $name
            $destination = Join-Path $staging $name
            Copy-Item -LiteralPath $source -Destination $destination
            if ((Get-FileHash -LiteralPath $source).Hash -cne (Get-FileHash -LiteralPath $destination).Hash) { throw "Artifact copy failed: $name" }
        }
        # Only the complete verified directory becomes visible to the controller.
        [System.IO.Directory]::Move($staging, $OutputDirectory)
        $staging = $null
    } else { $OutputDirectory = $built }
    Write-Output "Windows installer verified for $Sha. Artifacts: $OutputDirectory"
    Write-Output 'Installer smoke was not run. Publication belongs to the controller after its exact-SHA validation gate.'
} catch {
    Write-Error -ErrorAction Continue ("Windows CI: " + $_.Exception.Message)
    exit 1
} finally {
    Set-Location -LiteralPath $initialLocation.Path
    if ($savedEnvironment) {
        foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
            if (-not $savedEnvironment.Contains($name)) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
        }
        foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    }
    # Partial directories are retained for diagnosis; the controller owns job cleanup.
    if ($staging) { Write-Warning "Incomplete artifacts retained at $staging" }
}
