// SPDX-License-Identifier: GPL-3.0-or-later
// Run the real Windows GUI and pinned CLI against a disposable Discord layout.
import { createPackage, extractFile } from "@electron/asar";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "win32") throw new Error("Run the installer smoke test on Windows.");
const executable = resolve("dist/windows/ProtonnCordSetup.exe");
const metadata = JSON.parse(readFileSync("dist/windows/ProtonnCordSetup.json", "utf8"));
const root = mkdtempSync(join(tmpdir(), "Protonn Cord installer-"));
const env = { ...process.env, APPDATA: join(root, "Roaming"), LOCALAPPDATA: join(root, "Local"), PROTONN_SETUP_EXE: executable,
    PROTONN_SETUP_SCREENSHOT: resolve("dist/windows-smoke.png") };
for (const key of ["PROTONN_CORD_USER_DATA_DIR", "EQUICORD_USER_DATA_DIR", "DISCORD_USER_DATA_DIR"]) delete env[key];
const data = join(env.APPDATA, "ProtonnCord");
const settings = join(data, "settings", "settings.json");
const archive = join(data, "desktop.asar");
const resources = join(env.LOCALAPPDATA, "Discord", "app-9.0.10", "resources");
const app = join(resources, "app.asar");
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const before = String.raw`{
  "__type": "preserve-root", "plugins": {"Example": {"enabled": true}}, "favorites": ["Example"],
  "future": {"__type": "preserve-nested", "text": "escaped \" [}, text", "number": 9007199254740993},
  "updateBranch" : "main"
}
`;
const after = before.replace('"main"', '"nightly"');
function run(args, options = {}) {
    const result = spawnSync(executable, args, { env, encoding: "utf8", timeout: 75000, windowsHide: true, ...options });
    assert.equal(result.error, undefined, result.error?.message);
    return result;
}

try {
    mkdirSync(resources, { recursive: true });
    mkdirSync(join(data, "settings"), { recursive: true });
    const seed = join(root, "app-source");
    mkdirSync(seed);
    writeFileSync(join(seed, "package.json"), '{"name":"discord","main":"index.js"}');
    writeFileSync(join(seed, "index.js"), "globalThis.installerFixture = true;\n");
    await createPackage(seed, app);
    const original = readFileSync(app);
    writeFileSync(settings, before);
    const nativeSettings = join(data, "settings", "native-settings.json");
    writeFileSync(nativeSettings, '{"privateFixture":"keep unchanged"}\n');

    const gui = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
$process = Start-Process -FilePath $env:PROTONN_SETUP_EXE -PassThru
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $process.Refresh()
        if ($process.HasExited) { throw 'Setup exited before showing its window.' }
        if ($process.MainWindowHandle -ne 0) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($process.MainWindowHandle -eq 0) { throw 'Setup window did not appear.' }
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Install / repair ProtonnCord')
    $button = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -eq $button) { throw 'Install button was not found.' }
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $deadline = [DateTime]::UtcNow.AddSeconds(70)
    $installed = $false
    do {
        foreach ($element in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
            if ($element.Current.Name.StartsWith('Installed.')) { $installed = $true }
            if ($element.Current.Name.StartsWith('Setup could not finish.')) { throw 'GUI reported installation failure.' }
        }
        if ($installed) { break }
        if ($process.HasExited) { throw 'Setup exited before installation completed.' }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $installed) { throw 'GUI installation did not complete.' }
    $bounds = $window.Current.BoundingRectangle
    $bitmap = New-Object System.Drawing.Bitmap([int]$bounds.Width, [int]$bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen([int]$bounds.X, [int]$bounds.Y, 0, 0, $bitmap.Size)
        $bitmap.Save($env:PROTONN_SETUP_SCREENSHOT, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    Write-Output 'Double-click GUI installation completed.'
} finally {
    if (-not $process.HasExited) {
        $process.CloseMainWindow() | Out-Null
        if (-not $process.WaitForExit(5000)) { $process.Kill() }
    }
}`], { env, encoding: "utf8", timeout: 100000 });
    assert.equal(gui.status, 0, gui.error?.message ?? gui.stderr);
    console.log(gui.stdout.trim());
    assert.deepEqual(readFileSync(join(resources, "_app.asar")), original);
    assert.equal(extractFile(app, "index.js").toString(), `require(${JSON.stringify(archive)})`);
    assert.equal(hash(archive), metadata.archiveSha256);
    assert.equal(readFileSync(settings, "utf8"), after, "Only the updateBranch value may change.");
    assert.equal(readFileSync(nativeSettings, "utf8"), '{"privateFixture":"keep unchanged"}\n');

    assert.equal(run(["--install", "stable"]).status, 0, "Repair must succeed.");
    assert.deepEqual(readFileSync(join(resources, "_app.asar")), original, "Repair retains the original Discord archive.");
    copyFileSync(join(resources, "_app.asar"), archive); // A different previous payload makes rollback observable.
    writeFileSync(settings, before);
    assert.notEqual(run(["--install", "ptb"]).status, 0, "An absent channel must fail.");
    assert.deepEqual(readFileSync(archive), original, "Failed installation restores the previous payload.");
    assert.equal(readFileSync(settings, "utf8"), before, "Failed installation restores exact settings bytes.");
    assert.equal(run(["--uninstall", "stable"]).status, 0);
    assert.deepEqual(readFileSync(app), original);
    assert.equal(readFileSync(settings, "utf8"), before, "Uninstall preserves settings.");

    const override = join(root, "Custom ProtonnCord Data");
    const overrideEnv = { ...env, PROTONN_CORD_USER_DATA_DIR: override };
    assert.equal(run(["--install", "stable"], { env: overrideEnv }).status, 0);
    assert.equal(hash(join(override, "desktop.asar")), metadata.archiveSha256);
    assert.deepEqual(JSON.parse(readFileSync(join(override, "settings", "settings.json"), "utf8")), { updateBranch: "nightly" });
    assert.equal(readFileSync(settings, "utf8"), before, "The override must not rewrite the default data directory.");
    assert.equal(run(["--uninstall", "stable"], { env: overrideEnv }).status, 0);
    assert.deepEqual(readFileSync(app), original);
    console.log("PASS: GUI, real CLI injection/repair/removal, exact settings preservation, rollback, and data-directory override.");
} finally {
    rmSync(root, { recursive: true, force: true });
}
