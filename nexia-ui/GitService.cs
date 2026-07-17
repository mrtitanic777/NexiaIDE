/*
 * GitService.cs — a thin front over the git CLI.
 *
 * Source control is generic developer tooling, not Xbox logic, so it spawns
 * git.exe directly (the same shape as CoreBridge spawns nexia-core). Just the
 * handful of commands the panel needs: is-this-a-repo, branch, status, log,
 * stage, commit, init.
 */
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;

namespace NexiaUI
{
    public class GitFile
    {
        public string Code { get; set; }   // porcelain XY code, e.g. " M", "??", "A "
        public string Path { get; set; }
        public string Display { get { return Code + "  " + Path; } }
    }

    static class GitService
    {
        // Run git in `dir`; return (exitCode, stdout+stderr).
        public static int Run(string dir, string args, out string output)
        {
            output = "";
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "git",
                    Arguments = args,
                    WorkingDirectory = dir,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.UTF8,
                };
                using (var p = Process.Start(psi))
                {
                    string o = p.StandardOutput.ReadToEnd();
                    string err = p.StandardError.ReadToEnd();
                    p.WaitForExit();
                    output = string.IsNullOrEmpty(err) ? o : o + err;
                    return p.ExitCode;
                }
            }
            catch (Exception ex) { output = ex.Message; return -1; }
        }

        public static bool IsRepo(string dir)
        {
            string o;
            return Run(dir, "rev-parse --is-inside-work-tree", out o) == 0 && o.Trim() == "true";
        }

        public static string Branch(string dir)
        {
            string o;
            return Run(dir, "rev-parse --abbrev-ref HEAD", out o) == 0 ? o.Trim() : "";
        }

        public static List<GitFile> Status(string dir)
        {
            var list = new List<GitFile>();
            string o;
            if (Run(dir, "status --porcelain", out o) != 0) return list;
            foreach (var raw in o.Replace("\r", "").Split('\n'))
            {
                if (raw.Length < 4) continue;
                list.Add(new GitFile { Code = raw.Substring(0, 2), Path = raw.Substring(3) });
            }
            return list;
        }

        public static string Log(string dir, int n)
        {
            string o;
            Run(dir, "log --oneline -n " + n, out o);
            return o;
        }

        public static string StageAll(string dir) { string o; Run(dir, "add -A", out o); return o; }
        public static string Init(string dir) { string o; Run(dir, "init", out o); return o; }

        public static int Commit(string dir, string message, out string output)
        {
            // -F - reads the message from stdin, so a multi-line or quote-heavy
            // message needs no shell escaping.
            output = "";
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "git",
                    Arguments = "commit -F -",
                    WorkingDirectory = dir,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                using (var p = Process.Start(psi))
                {
                    p.StandardInput.Write(message);
                    p.StandardInput.Close();
                    output = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
                    p.WaitForExit();
                    return p.ExitCode;
                }
            }
            catch (Exception ex) { output = ex.Message; return -1; }
        }
    }
}
