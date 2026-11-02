// ForexBot.cs — one-click Windows launcher for the forex-bot platform.
//
// What double-clicking ForexBot.exe does (nothing else to remember):
//   1. guarantees a single instance (named mutex — two launches in the same
//      second would each kill the other's stack and every service would flap),
//   2. frees the platform ports (4000 backend / 5173 frontend / 8500 AI engine)
//      so a half-closed previous run cannot wedge the start,
//   3. spawns `npm run dev:all` in a visible console window — the project's own
//      orchestrator, which starts EVERYTHING: shared watcher, backend,
//      frontend, AI engine, MT5 terminal (auto-discovered + launched), the MT5
//      tick bridge and the MT5 order worker, each supervised by watchdogs.
//      The orchestrator path is used on purpose: node's process spawn runs the
//      Python workers reliably, while a raw C# spawn of python.exe died with
//      "Failed to import encodings module" on this host (observed live), so the
//      launcher deliberately has ONE process to start and nothing re-implemented.
//   4. opens the dashboard in the default browser once the frontend answers
//      (probing IPv4 and IPv6 loopback — Vite picks either),
//   5. sits in the tray watching backend health, and on Exit tree-kills the
//      orchestrator, which stops the whole stack.
//
// `ForexBot.exe --check` runs the preflight (node/npm/MT5/.env/ports) and
// prints PASS/FAIL per item — for verifying a machine without starting anything.
//
// Build (no SDK needed — the .NET Framework 4.8 compiler ships with Windows):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe
//     /out:scripts\launcher\ForexBot.exe /r:System.dll /r:System.Core.dll
//     /r:System.Drawing.dll /r:System.Windows.Forms.dll scripts\launcher\ForexBot.cs
//
// Deliberately C# 5: the in-box compiler has no string interpolation or ?.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Threading;
using System.Windows.Forms;
using System.Management;

namespace ForexBotLauncher
{
    internal static class Program
    {
        private const string PidFileRel = ".data\\forexbot-launcher.pid";
        private const string LogFileRel = ".data\\forexbot-launcher.log";
        private static readonly int[] Ports = { 4000, 5173, 8500 };

        private static string root;
        private static string logFile;
        private static Process orchestrator;
        private static Mutex singleInstance;
        private static EventWaitHandle stopSignal;

        private static NotifyIcon tray;
        private static HiddenForm window;
        private static volatile bool shuttingDown;
        private static bool hasConsoleWindow;

        [STAThread]
        private static void Main(string[] args)
        {
            AppDomain.CurrentDomain.ProcessExit += OnProcessExit;

            // exe lives at scripts\launcher\ForexBot.exe → repo root is two up.
            root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
            logFile = Path.Combine(root, LogFileRel);
            Directory.CreateDirectory(Path.Combine(root, ".data"));

            bool check = args.Any(a => string.Equals(a, "--check", StringComparison.OrdinalIgnoreCase));
            bool stopRequested = args.Any(a => string.Equals(a, "--stop", StringComparison.OrdinalIgnoreCase));
            bool wantConsole = check || stopRequested || args.Any(a => string.Equals(a, "--console", StringComparison.OrdinalIgnoreCase));
            if (wantConsole) AttachConsole();

            Log("=== ForexBot launcher starting (root: " + root + ") ===");

            if (!Directory.Exists(Path.Combine(root, "backend", "src")))
            {
                Fatal("Repo not found at " + root + " — ForexBot.exe must stay inside the project (scripts\\launcher\\).");
                return;
            }

            if (check)
            {
                RunPreflight();
                return;
            }

            // Single instance. A named Mutex, not a pid file: two launches in
            // the same second both read a stale pid file and proceed — then
            // each startup sweep kills the other's stack and every service
            // flaps between the two (observed live as 200/000 health flapping).
            // The mutex is atomic at the kernel level.
            bool firstInstance;
            singleInstance = new Mutex(true, "Global\\ForexBotLauncher", out firstInstance);
            if (!firstInstance)
            {
                if (stopRequested)
                {
                    // Another instance owns the mutex: signal it to shut down
                    // gracefully (same path as the tray Exit menu item).
                    stopSignal = EventWaitHandle.OpenExisting("Global\\ForexBotStop");
                    stopSignal.Set();
                    Log("stop signal sent to the running instance");
                    return;
                }
                MessageBox.Show("ForexBot is already running — look for the tray icon near the clock.",
                    "ForexBot", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (stopRequested)
            {
                Log("--stop requested but no other instance is running — nothing to do");
                return;
            }
            stopSignal = new EventWaitHandle(false, EventResetMode.ManualReset, "Global\\ForexBotStop");
            var stopWaiter = new Thread(delegate()
            {
                try { stopSignal.WaitOne(); } catch { return; }
                Log("stop signal received — exiting gracefully");
                // Close must happen on the UI thread; a direct call from here
                // would be a cross-thread operation. If the window is gone
                // already, exiting directly is equivalent.
                try
                {
                    if (window.IsHandleCreated)
                        window.BeginInvoke((MethodInvoker)delegate { window.Close(); });
                    else
                        GracefulExit();
                }
                catch { GracefulExit(); }
            }) { IsBackground = true };
            stopWaiter.Start();
            WriteOwnPidFile();

            // Free the platform ports so a half-closed previous run cannot
            // wedge the start (the orchestrator re-checks, but a clean start
            // here keeps its own log readable).
            FreePorts("startup");
            // Then sweep every leftover project process. Ports alone are not
            // enough: watchdogs and tsx/tsc watchers hold no port, and after a
            // hard kill (task manager, crash) they pile up — two stacks
            // interleaved made every service flap and duplicated the workers.
            KillProjectProcesses("startup sweep");

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            tray = new NotifyIcon();
            tray.Icon = System.Drawing.SystemIcons.Application;
            tray.Text = "ForexBot — starting…";
            tray.Visible = true;
            var menu = new ContextMenuStrip();
            menu.Items.Add("Open Dashboard", null, delegate { OpenDashboard(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Exit — stop everything", null, delegate { GracefulExit(); });
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { OpenDashboard(); };

            window = new HiddenForm();
            window.Closed += delegate { GracefulExit(); };

            if (!StartOrchestrator())
            {
                Fatal("Could not start the platform orchestrator (npm run dev:all).");
                return;
            }

            // Dashboard as soon as the frontend answers (v4 or v6 loopback).
            var opener = new Thread(OpenWhenReady) { IsBackground = true };
            opener.Start();

            // Tray health monitor.
            var monitor = new Thread(HealthMonitor) { IsBackground = true };
            monitor.Start();

            Application.Run(window); // blocks until the window is closed
            GracefulExit();
        }

        // ── The one process: npm run dev:all ────────────────────────────────

        private static bool StartOrchestrator()
        {
            string npm = FindNpm();
            if (npm == null)
            {
                Tip("npm not found", "Install Node.js (npm must be available), then start ForexBot again.", true);
                return false;
            }
            try
            {
                var psi = new ProcessStartInfo();
                psi.FileName = npm;
                psi.Arguments = "run dev:all";
                psi.WorkingDirectory = root;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = false; // the console window IS the platform log
                orchestrator = Process.Start(psi);
                orchestrator.EnableRaisingEvents = true;
                orchestrator.Exited += delegate
                {
                    if (shuttingDown) return; // we stopped it on purpose
                    string code;
                    try { code = orchestrator.ExitCode.ToString(); } catch { code = "?"; }
                    Log("ORCHESTRATOR EXITED (code " + code + ") — the platform is down");
                    Tip("Platform stopped", "The platform process exited (code " + code + "). Reopen ForexBot to start again.", true);
                };
                Log("orchestrator started (pid " + orchestrator.Id + "): npm run dev:all");
                return true;
            }
            catch (Exception ex)
            {
                Log("FAILED to start orchestrator: " + ex.Message);
                Tip("Start failed", ex.Message, true);
                return false;
            }
        }

        // ── Ports ───────────────────────────────────────────────────────────

        private static void FreePorts(string phase)
        {
            foreach (var port in Ports) FreePort(port, phase);
        }

        private static void FreePort(int port, string phase)
        {
            try
            {
                string outText = RunCapture("netstat", "-ano -p tcp");
                if (outText == null) return;
                var pids = new HashSet<string>();
                foreach (var line in outText.Split('\n'))
                {
                    if (line.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    var parts = line.Trim().Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length < 5) continue;
                    if (!parts[1].EndsWith(":" + port, StringComparison.OrdinalIgnoreCase)) continue;
                    pids.Add(parts[parts.Length - 1]);
                }
                int me = Process.GetCurrentProcess().Id;
                foreach (var s in pids)
                {
                    int pid;
                    if (!int.TryParse(s, out pid)) continue;
                    if (pid == me || pid <= 4) continue;
                    Log(phase + ": port " + port + " held by pid " + pid + " — stopping it");
                    TreeKill(pid);
                }
            }
            catch (Exception ex) { Log("FreePort(" + port + ") failed: " + ex.Message); }
        }

        private static string RunCapture(string fileName, string args)
        {
            try
            {
                var psi = new ProcessStartInfo();
                psi.FileName = fileName;
                psi.Arguments = args;
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.CreateNoWindow = true;
                using (var p = Process.Start(psi))
                {
                    string s = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(5000);
                    return s;
                }
            }
            catch { return null; }
        }

        private static void TreeKill(int pid)
        {
            try
            {
                var psi = new ProcessStartInfo();
                psi.FileName = "taskkill";
                psi.Arguments = "/F /T /PID " + pid;
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                Process.Start(psi).WaitForExit(5000);
                Thread.Sleep(300);
                bool stillAlive = false;
                try { stillAlive = Process.GetProcessById(pid) != null; } catch { } // gone = good
                if (stillAlive) Log("WARNING: taskkill /T did not stop pid " + pid);
                else Log("tree-killed pid " + pid);
            }
            catch (Exception ex) { Log("tree-kill " + pid + " failed: " + ex.Message); }
        }

        /// <summary>
        /// Kill every leftover process of a previous platform run, identified
        /// by WMI command line (they must die BEFORE the orchestrator starts,
        /// or two stacks interleave: duplicated tsx/tsc/vite/watchdog processes
        /// flap the services and double-spawn the MT5 workers). Killing only —
        /// no interpreter is spawned here. The uvicorn reloader's
        /// multiprocessing spawn helpers are included: they carry no repo path
        /// in their command line yet inherit the listener socket handle, and
        /// are spawned by nothing else on the host.
        /// </summary>
        private static void KillProjectProcesses(string phase)
        {
            int me = Process.GetCurrentProcess().Id;
            var doomed = new List<int>();
            try
            {
                using (var searcher = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process"))
                {
                    foreach (var o in searcher.Get())
                    {
                        var cl = (o["CommandLine"] as string) ?? "";
                        if (cl.Length == 0) continue;
                        if (cl.IndexOf("ForexBot", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                        var lower = cl.ToLowerInvariant();
                        bool inRepo = cl.IndexOf(root, StringComparison.OrdinalIgnoreCase) >= 0;
                        bool mpSpawn = lower.Contains("python") && lower.Contains("multiprocessing") && lower.Contains("spawn_main");
                        if (!inRepo && !mpSpawn) continue;
                        bool ours = inRepo && (lower.Contains("npm") || lower.Contains("node_modules")
                            || lower.Contains("vite") || lower.Contains("tsx") || lower.Contains("tsc")
                            || lower.Contains("watchdog") || lower.Contains("mt5-bridge") || lower.Contains("mt5-trader")
                            || lower.Contains("uvicorn") || lower.Contains("workers\\"));
                        if (!ours && !mpSpawn) continue;
                        int pid;
                        try { pid = Convert.ToInt32(o["ProcessId"]); } catch { continue; }
                        if (pid == me || pid <= 4) continue;
                        if (!doomed.Contains(pid)) doomed.Add(pid);
                    }
                }
            }
            catch (Exception ex)
            {
                Log(phase + ": WMI sweep unavailable (" + ex.Message + ") — relying on port owners only");
                return;
            }
            foreach (var pid in doomed)
            {
                Log(phase + ": leftover project process pid " + pid + " — stopping it");
                TreeKill(pid);
            }
            if (doomed.Count > 0) Thread.Sleep(1500); // sockets need a beat to actually close
        }

        private static void WriteOwnPidFile()
        {
            try { File.WriteAllText(Path.Combine(root, PidFileRel), Process.GetCurrentProcess().Id.ToString()); }
            catch (Exception ex) { Log("pid file write failed: " + ex.Message); }
        }

        // ── Shutdown ────────────────────────────────────────────────────────

        private static void GracefulExit()
        {
            if (shuttingDown) return;
            shuttingDown = true;
            Log("shutting down: stopping the platform");
            int pid = 0;
            try { if (orchestrator != null && !orchestrator.HasExited) pid = orchestrator.Id; } catch { }
            if (pid > 0) TreeKill(pid); // /T takes the whole npm → node → workers tree
            // start-all.mjs spawns the MT5 worker windows DETACHED
            // (Start-Process), so killing the npm tree orphans them. Sweep the
            // survivors by command line — they are unambiguous (watchdogs and
            // worker launchers all carry the worker path).
            KillWorkerProcesses();
            FreePorts("shutdown");      // belt-and-braces: sockets need a moment to close
            try { File.Delete(Path.Combine(root, PidFileRel)); } catch { }
            if (tray != null) tray.Visible = false;
            Log("=== stopped ===");
            Environment.Exit(0);
        }

        private static void OnProcessExit(object sender, EventArgs e)
        {
            if (shuttingDown) return;
            // Hard kill (task-manager style shutdown): still stop the platform.
            try
            {
                if (orchestrator != null && !orchestrator.HasExited)
                {
                    var psi = new ProcessStartInfo();
                    psi.FileName = "taskkill";
                    psi.Arguments = "/F /T /PID " + orchestrator.Id;
                    psi.CreateNoWindow = true;
                    psi.UseShellExecute = false;
                    Process.Start(psi).WaitForExit(5000);
                }
                KillWorkerProcesses();
            }
            catch { }
        }

        /// <summary>
        /// Stop the MT5 worker watchdogs and their detached PowerShell/Python
        /// windows (identified by the worker path in the command line — they
        /// hold no ports, so a netstat sweep cannot find them).
        /// </summary>
        private static void KillWorkerProcesses()
        {
            var doomed = new List<int>();
            try
            {
                using (var searcher = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process"))
                {
                    foreach (var o in searcher.Get())
                    {
                        var cl = (o["CommandLine"] as string) ?? "";
                        if (cl.Length == 0) continue;
                        var lower = cl.ToLowerInvariant();
                        if (lower.IndexOf("forexbot", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                        if (lower.Contains("mt5-bridge") || lower.Contains("mt5-trader")
                            || (lower.Contains("watchdog") && lower.Contains("workers")))
                        {
                            int pid;
                            try { pid = Convert.ToInt32(o["ProcessId"]); } catch { continue; }
                            if (pid <= 4) continue;
                            if (!doomed.Contains(pid)) doomed.Add(pid);
                        }
                    }
                }
            }
            catch { return; } // WMI unavailable: the port sweep still covers the servers
            foreach (var pid in doomed)
            {
                Log("shutdown sweep: worker-related pid " + pid + " — stopping it");
                TreeKill(pid);
            }
        }

        // ── Health / helpers ────────────────────────────────────────────────

        private static void HealthMonitor()
        {
            int failures = 0;
            bool announcedDown = false;
            while (!shuttingDown)
            {
                Thread.Sleep(3000);
                bool alive = orchestrator != null && !orchestrator.HasExited;
                if (HttpOk("http://127.0.0.1:4000/health"))
                {
                    failures = 0;
                    if (announcedDown) { announcedDown = false; Tip("Backend is back", "The API answered again on port 4000.", false); }
                    tray.Text = "ForexBot — running (backend OK)";
                }
                else
                {
                    failures++;
                    tray.Text = alive ? "ForexBot — backend down (" + failures + ")" : "ForexBot — platform stopped";
                    if (failures >= 10 && !announcedDown)
                    {
                        announcedDown = true;
                        Tip("Backend is DOWN",
                            alive
                                ? "The API on port 4000 stopped answering. Check the platform console window."
                                : "The platform process has exited. Reopen ForexBot to start again.",
                            true);
                    }
                }
            }
        }

        private static void OpenWhenReady()
        {
            // Vite may bind IPv4 or IPv6 loopback depending on host config —
            // probe both before giving up (5173 on [::1] once cost the
            // dashboard auto-open a full timeout).
            if (WaitAnyHttp(new[] { "http://127.0.0.1:5173/", "http://[::1]:5173/" }, 180)) OpenDashboard();
            else Tip("Dashboard did not open", "The frontend did not answer on port 5173 within 180 s. Check the platform console window.", true);
        }

        private static bool WaitAnyHttp(string[] urls, int seconds)
        {
            var deadline = Environment.TickCount + seconds * 1000;
            while (Environment.TickCount < deadline && !shuttingDown)
            {
                foreach (var u in urls) if (HttpOk(u)) return true;
                Thread.Sleep(1500);
            }
            foreach (var u in urls) if (HttpOk(u)) return true;
            return false;
        }

        private static bool HttpOk(string url)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "GET";
                req.Timeout = 2500;
                req.ReadWriteTimeout = 2500;
                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    int code = (int)resp.StatusCode;
                    return code >= 200 && code < 500; // any HTTP answer means the server is up
                }
            }
            catch (WebException wex)
            {
                return wex.Response != null; // an HTTP error status still proves the server answered
            }
            catch { return false; }
        }

        private static void OpenDashboard()
        {
            try
            {
                var psi = new ProcessStartInfo();
                psi.FileName = "http://localhost:5173";
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch (Exception ex) { Log("open dashboard failed: " + ex.Message); }
        }

        private static string FindNpm()
        {
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string cand = Path.Combine(pf, "nodejs", "npm.cmd");
            if (File.Exists(cand)) return cand;
            if (ExistsOnPath("npm.cmd")) return "npm.cmd";
            return null;
        }

        private static bool ExistsOnPath(string fileName)
        {
            var path = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';');
            foreach (var dir in path)
            {
                try { if (dir.Length > 0 && File.Exists(Path.Combine(dir.Trim(), fileName))) return true; }
                catch { }
            }
            return false;
        }

        // ── Preflight (--check) ─────────────────────────────────────────────

        private static void RunPreflight()
        {
            int fails = 0;
            bool repo = Directory.Exists(Path.Combine(root, "backend", "src"));
            fails += Check("repo layout (backend/src exists)", repo, repo ? "" : "missing");
            string npm = FindNpm();
            fails += Check("npm", npm != null, npm ?? "not found — install Node.js");
            string venv = Path.Combine(root, "ai-engine", "venv", "Scripts", "python.exe");
            fails += Check("AI engine venv python", File.Exists(venv), File.Exists(venv) ? "" : "venv missing (orchestrator falls back to py)");
            bool feDeps = Directory.Exists(Path.Combine(root, "frontend", "node_modules"));
            fails += Check("frontend deps", feDeps, feDeps ? "" : "run: npm install");
            bool beDeps = Directory.Exists(Path.Combine(root, "node_modules"));
            fails += Check("backend deps", beDeps, beDeps ? "" : "run: npm install");
            bool token = HasInternalToken(Path.Combine(root, "backend", ".env"));
            fails += Check("backend\\.env INTERNAL_API_TOKEN", token, token ? "" : "backend\\.env missing INTERNAL_API_TOKEN (MT5 workers will be skipped)");
            string mt5 = FindMt5Exe();
            fails += Check("MT5 terminal", mt5 != null, mt5 ?? "not found (the orchestrator will report the fix)");
            foreach (var p in Ports)
            {
                bool busy = PortBusy(p);
                fails += Check("port " + p, true, busy ? "currently held — will be freed on start" : "");
            }
            Log("preflight: " + (fails == 0 ? "ALL CHECKS PASSED" : fails + " check(s) need attention"));
        }

        private static int Check(string label, bool ok, string detail)
        {
            Log((ok ? "[PASS] " : "[FAIL] ") + label + (detail.Length > 0 ? " — " + detail : ""));
            return ok ? 0 : 1;
        }

        private static bool PortBusy(int port)
        {
            // Bind-probe: if WE can listen on the port, it is free.
            var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, port);
            try { probe.Start(); return false; }
            catch { return true; }
            finally { try { probe.Stop(); } catch { } }
        }

        // ── MT5 terminal discovery (preflight only) ─────────────────────────

        private static string FindMt5Exe()
        {
            // 1) The terminal records where IT was installed from (origin.txt).
            try
            {
                var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                var termRoot = Path.Combine(appData, "MetaQuotes", "Terminal");
                if (Directory.Exists(termRoot))
                {
                    foreach (var dir in Directory.GetDirectories(termRoot))
                    {
                        var origin = Path.Combine(dir, "origin.txt");
                        if (!File.Exists(origin)) continue;
                        string installDir;
                        using (var sr = new StreamReader(origin)) installDir = (sr.ReadLine() ?? "").Trim();
                        if (installDir.Length == 0) continue;
                        string cand = Path.Combine(installDir, "terminal64.exe");
                        if (File.Exists(cand)) return cand;
                    }
                }
            }
            catch { }

            // 2) Standard install folders.
            string[] guesses =
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "MetaTrader 5", "terminal64.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "MetaTrader 5", "terminal64.exe"),
                "C:\\Program Files\\MetaTrader 5\\terminal64.exe",
            };
            foreach (var g in guesses) if (File.Exists(g)) return g;
            return null;
        }

        private static bool HasInternalToken(string envPath)
        {
            try
            {
                foreach (var line in File.ReadAllLines(envPath))
                {
                    var m = line.TrimStart();
                    if (m.StartsWith("INTERNAL_API_TOKEN", StringComparison.OrdinalIgnoreCase))
                    {
                        var eq = m.IndexOf('=');
                        if (eq > 0 && m.Substring(eq + 1).Trim().Length > 0) return true;
                    }
                }
            }
            catch { }
            return false;
        }

        // ── Console / log / tray plumbing ───────────────────────────────────

        private static void AttachConsole()
        {
            if (AttachConsole(-1)) { hasConsoleWindow = true; return; }
            if (AllocConsole()) hasConsoleWindow = true;
        }

        private static void Log(string line)
        {
            var msg = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line;
            if (hasConsoleWindow) { try { Console.WriteLine(msg); } catch { } }
            try { File.AppendAllText(logFile, msg + Environment.NewLine); } catch { }
        }

        private static void Tip(string title, string text, bool error)
        {
            try
            {
                if (tray != null)
                {
                    tray.BalloonTipTitle = title;
                    tray.BalloonTipText = text;
                    tray.BalloonTipIcon = error ? ToolTipIcon.Error : ToolTipIcon.Info;
                    tray.ShowBalloonTip(6000);
                }
            }
            catch { }
            Log(title + ": " + text);
        }

        private static void Fatal(string message)
        {
            Log("FATAL: " + message);
            MessageBox.Show(message + Environment.NewLine + Environment.NewLine +
                "Details: " + logFile, "ForexBot", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AllocConsole();

        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(int processId);

        // ── Hidden message window ───────────────────────────────────────────

        private sealed class HiddenForm : Form
        {
            internal HiddenForm()
            {
                Text = "ForexBot";
                ShowInTaskbar = false;
                WindowState = FormWindowState.Minimized;
                FormBorderStyle = FormBorderStyle.None;
                Opacity = 0;
            }
            protected override void SetVisibleCore(bool value)
            {
                base.SetVisibleCore(false); // never shown: the tray icon is the UI
            }
        }
    }
}
