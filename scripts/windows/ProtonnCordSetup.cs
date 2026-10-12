// ProtonnCord Windows setup. SPDX-License-Identifier: GPL-3.0-or-later
// Discord discovery, injection and unpatching use the pinned Equilotl CLI.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class ProtonnCordSetup
{
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
    private static Dictionary<string, object> Metadata;

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            Metadata = Json.Deserialize<Dictionary<string, object>>(Utf8.GetString(Resource("installer.json")));
            if (args.Length != 0)
            {
                if (args.Length != 2 || (args[0] != "--install" && args[0] != "--uninstall"))
                    throw new ArgumentException("Usage: ProtonnCordSetup.exe [--install|--uninstall stable|ptb|canary]");
                Install(args[1], args[0] == "--uninstall");
                return 0;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            ShowSetup();
            return 0;
        }
        catch (Exception error)
        {
            if (args.Length == 0) MessageBox.Show(error.Message, "ProtonnCord setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            else Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static void ShowSetup()
    {
        using (var form = new Form { Text = "ProtonnCord Nightly Setup", ClientSize = new Size(550, 300),
            StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false })
        {
            var intro = new Label { Left = 20, Top = 20, Width = 510, Height = 72,
                Text = "Install or repair ProtonnCord in your existing Discord.\nQuit all Discord installations from their tray icons first.\nProtonnCord updates will follow nightly." };
            var label = new Label { Left = 20, Top = 102, Width = 150, Text = "Discord installation:" };
            var choice = new ComboBox { Left = 180, Top = 98, Width = 230, DropDownStyle = ComboBoxStyle.DropDownList };
            choice.Items.AddRange(new object[] { "Discord Stable", "Discord PTB", "Discord Canary" });
            choice.SelectedIndex = 0;
            var install = new Button { Left = 20, Top = 145, Width = 245, Height = 36, Text = "Install / repair ProtonnCord" };
            var remove = new Button { Left = 285, Top = 145, Width = 245, Height = 36, Text = "Remove from selected Discord" };
            var status = new Label { Left = 20, Top = 195, Width = 510, Height = 75,
                Text = "Version " + Metadata["version"] + " • " + ((string)Metadata["commit"]).Substring(0, 12) };
            bool busy = false;
            Func<bool, Task> run = async uninstall =>
            {
                string branch = new[] { "stable", "ptb", "canary" }[choice.SelectedIndex];
                busy = true;
                install.Enabled = remove.Enabled = choice.Enabled = false;
                status.Text = uninstall ? "Removing ProtonnCord…" : "Installing ProtonnCord nightly…";
                try
                {
                    await Task.Run(() => Install(branch, uninstall));
                    status.Text = uninstall ? "Removed. Your settings are preserved. Open Discord normally."
                        : "Installed. Open Discord normally.\nUpdates: ProtonnCord settings → Updater → nightly.";
                }
                catch (Exception error)
                {
                    status.Text = "Setup could not finish. See the error details before trying again.";
                    MessageBox.Show(form, error.Message, "ProtonnCord setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                finally { busy = false; install.Enabled = remove.Enabled = choice.Enabled = true; }
            };
            install.Click += async (sender, e) => await run(false);
            remove.Click += async (sender, e) => await run(true);
            form.FormClosing += (sender, e) => { if (busy) e.Cancel = true; };
            form.Controls.AddRange(new Control[] { intro, label, choice, install, remove, status });
            Application.Run(form);
        }
    }

    private static byte[] Resource(string name)
    {
        using (var input = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        using (var output = new MemoryStream())
        {
            if (input == null) throw new InvalidDataException("Missing installer resource: " + name);
            input.CopyTo(output);
            return output.ToArray();
        }
    }

    private static void Extract(string resource, string destination, string expectedHash)
    {
        byte[] bytes = Resource(resource);
        using (var sha = SHA256.Create())
        {
            string actual = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
            if (actual != expectedHash) throw new InvalidDataException("Installer resource failed verification: " + resource);
        }
        WriteStaged(destination, bytes);
    }

    private static void WriteStaged(string destination, byte[] bytes)
    {
        using (var file = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        { file.Write(bytes, 0, bytes.Length); file.Flush(true); }
    }

    // The backup stays beside the destination so activation and recovery use one volume.
    private static string Activate(string temporary, string destination)
    {
        if (!File.Exists(destination)) { File.Move(temporary, destination); return null; }
        string backup = destination + "." + Guid.NewGuid().ToString("N") + ".bak";
        File.Replace(temporary, destination, backup);
        return backup;
    }

    private static void Restore(string destination, string backup, bool removeNew)
    {
        if (backup != null)
        {
            if (File.Exists(destination)) File.Replace(backup, destination, null);
            else File.Move(backup, destination);
        }
        else if (removeNew) File.Delete(destination);
    }

    private static int StringEnd(string text, int start)
    {
        if (text[start] != '"') throw new InvalidDataException("Settings property names must be JSON strings.");
        for (int i = start + 1; i < text.Length; i++)
        {
            if (text[i] == '\\') i++;
            else if (text[i] == '"') return i + 1;
        }
        throw new InvalidDataException("Settings contain an unterminated JSON string.");
    }

    private static string NightlySettings(string text)
    {
        if (!(Json.DeserializeObject(text) is Dictionary<string, object>))
            throw new InvalidDataException("Existing settings must be a JSON object; they have not been changed.");
        // Validate with the framework parser, but retain the original text: its
        // object conversion can discard unknown __type fields or coerce numbers.
        var result = new StringBuilder();
        int cursor = text.IndexOf('{') + 1, copied = 0, properties = 0;
        while (true)
        {
            while (Char.IsWhiteSpace(text[cursor])) cursor++;
            if (text[cursor] == '}') break;
            int keyEnd = StringEnd(text, cursor);
            string key = Json.Deserialize<string>(text.Substring(cursor, keyEnd - cursor));
            cursor = keyEnd;
            while (Char.IsWhiteSpace(text[cursor])) cursor++;
            if (text[cursor++] != ':') throw new InvalidDataException("Invalid settings property.");
            while (Char.IsWhiteSpace(text[cursor])) cursor++;
            int start = cursor, depth = 0;
            for (; cursor < text.Length; cursor++)
            {
                char token = text[cursor];
                if (token == '"') cursor = StringEnd(text, cursor) - 1;
                else if (token == '{' || token == '[') depth++;
                else if (token == '}' || token == ']') { if (depth == 0) break; depth--; }
                else if (token == ',' && depth == 0) break;
            }
            if (key == "updateBranch")
            {
                int end = cursor;
                while (Char.IsWhiteSpace(text[end - 1])) end--;
                result.Append(text, copied, start - copied).Append("\"nightly\"");
                copied = end;
            }
            properties++;
            if (text[cursor] != ',') break;
            cursor++;
        }
        if (copied == 0) return text.Insert(cursor, (properties == 0 ? "" : ",") + "\"updateBranch\":\"nightly\"");
        return result.Append(text, copied, text.Length - copied).ToString();
    }

    private static void Install(string branch, bool uninstall)
    {
        if (branch != "stable" && branch != "ptb" && branch != "canary") throw new ArgumentException("Choose Discord Stable, PTB or Canary.");
        RequireDiscordClosed();
        string appData = Environment.GetEnvironmentVariable("APPDATA");
        if (String.IsNullOrWhiteSpace(appData) || !Path.IsPathRooted(appData)) throw new IOException("APPDATA is not an absolute path.");
        string discordData = Environment.GetEnvironmentVariable("DISCORD_USER_DATA_DIR");
        string directory = Environment.GetEnvironmentVariable("PROTONN_CORD_USER_DATA_DIR")
            ?? Environment.GetEnvironmentVariable("EQUICORD_USER_DATA_DIR")
            ?? (!String.IsNullOrEmpty(discordData) ? Path.GetFullPath(Path.Combine(discordData, "..", "ProtonnCordData")) : Path.Combine(appData, "ProtonnCord"));
        if (String.IsNullOrWhiteSpace(directory) || !Path.IsPathRooted(directory)) throw new IOException("The ProtonnCord settings override is not an absolute path.");
        string archive = Path.Combine(directory, "desktop.asar");
        string settings = Path.Combine(directory, "settings", "settings.json");
        Directory.CreateDirectory(directory);
        string settingsText = "{}\n";
        if (!uninstall)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(settings));
            if (File.Exists(settings))
            {
                if (new FileInfo(settings).Length > 16 * 1024 * 1024) throw new InvalidDataException("Settings exceed the 16 MiB limit; they have not been changed.");
                settingsText = Utf8.GetString(File.ReadAllBytes(settings));
            }
            settingsText = NightlySettings(settingsText);
        }

        string temporary = Path.Combine(directory, ".setup-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temporary);
        string archiveBackup = null, settingsBackup = null;
        bool archiveActivated = false, settingsActivated = false, processRunning = false, completed = false;
        try
        {
            string cli = Path.Combine(temporary, "EquilotlCli.exe");
            Extract("EquilotlCli.exe", cli, (string)Metadata["installerSha256"]);
            if (!uninstall)
            {
                string stagedArchive = Path.Combine(temporary, "desktop.asar");
                string stagedSettings = Path.Combine(temporary, "settings.json");
                Extract("desktop.asar", stagedArchive, (string)Metadata["archiveSha256"]);
                WriteStaged(stagedSettings, Utf8.GetBytes(settingsText));
                RequireDiscordClosed();
                archiveBackup = Activate(stagedArchive, archive);
                archiveActivated = true;
                settingsBackup = Activate(stagedSettings, settings);
                settingsActivated = true;
            }

            var start = new ProcessStartInfo(cli, (uninstall ? "--uninstall" : "--install") + " --branch " + branch) {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            start.EnvironmentVariables["EQUICORD_DIRECTORY"] = archive;
            start.EnvironmentVariables["EQUICORD_USER_DATA_DIR"] = directory;
            // This skips only the CLI's upstream downloader. desktop.asar remains a
            // standalone release with its own enabled ProtonnCord HTTP updater.
            start.EnvironmentVariables["EQUICORD_DEV_INSTALL"] = "1";
            using (var process = new Process { StartInfo = start })
            {
                var output = new StringBuilder();
                DataReceivedEventHandler capture = (sender, e) => {
                    if (e.Data != null) lock (output) { if (output.Length < 65536) output.AppendLine(e.Data); }
                };
                process.OutputDataReceived += capture;
                process.ErrorDataReceived += capture;
                process.Start();
                processRunning = true;
                process.BeginOutputReadLine(); process.BeginErrorReadLine();
                if (!process.WaitForExit(60000))
                {
                    if (!process.HasExited) process.Kill();
                    if (!process.WaitForExit(5000)) throw new TimeoutException("Installer did not stop; its files and backups were retained.");
                    processRunning = false;
                    throw new TimeoutException("Discord installer timed out.");
                }
                process.WaitForExit();
                processRunning = false;
                if (process.ExitCode != 0) throw new IOException("Discord could not be patched:\n" + output);
            }
            completed = true;
        }
        catch (Exception failure)
        {
            if (processRunning) throw new IOException("Installer could not be stopped; files and backups were retained in " + directory, failure);
            var errors = new List<Exception> { failure };
            if (settingsActivated)
                try { Restore(settings, settingsBackup, true); } catch (Exception error) { errors.Add(error); }
            // Keep a newly extracted archive if upstream recovery itself failed;
            // a remaining loader must still have its payload available for repair.
            if (archiveActivated)
                try { Restore(archive, archiveBackup, false); } catch (Exception error) { errors.Add(error); }
            if (errors.Count != 1) throw new AggregateException("Setup failed and recovery was incomplete. Backups were retained in " + directory, errors);
            throw;
        }
        finally
        {
            if (completed)
            {
                if (archiveBackup != null) Cleanup(() => File.Delete(archiveBackup));
                if (settingsBackup != null) Cleanup(() => File.Delete(settingsBackup));
            }
            if (!processRunning) Cleanup(() => Directory.Delete(temporary, true));
        }
    }

    private static void Cleanup(Action remove)
    {
        try { remove(); }
        catch (Exception error) { Console.Error.WriteLine("Setup cleanup: " + error.Message); }
    }

    private static void RequireDiscordClosed()
    {
        // All channels share this settings directory, including channels not selected here.
        foreach (string name in new[] { "Discord", "DiscordPTB", "DiscordCanary", "DiscordDevelopment" })
        {
            var processes = Process.GetProcessesByName(name);
            foreach (var process in processes) process.Dispose();
            if (processes.Length != 0) throw new InvalidOperationException("Quit " + name + " from its tray icon, then try again.");
        }
    }
}
