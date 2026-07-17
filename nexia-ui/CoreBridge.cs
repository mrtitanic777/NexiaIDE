/*
 * CoreBridge.cs — the backend client, WPF edition.
 *
 * The same idea the C++ spike proved, now in C#: spawn nexia-core.exe (the ported
 * C backend, beside this exe), read its JSON, hand back typed data. The WPF UI
 * stands on exactly the backend the Electron IDE uses — the port is untouched by
 * the move to WPF, because the boundary was always a process, not an ABI.
 *
 * JSON is read with the JavaScriptSerializer that ships in .NET Framework
 * (System.Web.Extensions), so there is no NuGet dependency to acquire.
 */
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace NexiaUI
{
    static class CoreBridge
    {
        static string ExeDir()
        {
            return Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
        }

        static string CorePath() { return Path.Combine(ExeDir(), "nexia-core.exe"); }

        /// Spawn nexia-core with args and return its stdout (UTF-8). Empty on failure.
        public static string Run(string args)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = CorePath(),
                    Arguments = args,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.UTF8,
                };
                using (var p = Process.Start(psi))
                {
                    string outp = p.StandardOutput.ReadToEnd();
                    p.WaitForExit();
                    return outp;
                }
            }
            catch { return ""; }
        }

        /// Parse a JSON document into nested Dictionary<string,object> / object[].
        public static Dictionary<string, object> ParseObject(string json)
        {
            try { return new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>; }
            catch { return null; }
        }

        // ── convenience accessors over the parsed dictionaries ──
        public static object Get(Dictionary<string, object> o, string key)
        {
            object v;
            return (o != null && o.TryGetValue(key, out v)) ? v : null;
        }
        public static string Str(Dictionary<string, object> o, string key, string fallback = "")
        {
            object v = Get(o, key);
            return v is string ? (string)v : fallback;
        }
        public static Dictionary<string, object> Obj(Dictionary<string, object> o, string key)
        {
            return Get(o, key) as Dictionary<string, object>;
        }

        // ── the two calls the shell needs right now ──

        /// The detected SDK root, or a "(not detected)" placeholder.
        public static string DetectSdk()
        {
            string exeDir = ExeDir();
            string resources = Path.Combine(exeDir, "..", "resources");
            var root = ParseObject(Run("sdk detect --resources \"" + resources + "\" --exe-dir \"" + exeDir + "\""));
            var sdk = Obj(root, "sdk");
            return sdk != null ? Str(sdk, "root", "(not detected)") : "(not detected)";
        }

        /// Open a project: returns (name, path). Empty name on failure.
        public static void OpenProject(string path, out string name, out string realPath)
        {
            var res = ParseObject(Run("project open \"" + path + "\""));
            var proj = Obj(res, "project");
            name = proj != null ? Str(proj, "name", "(open failed)") : "(open failed)";
            realPath = proj != null ? Str(proj, "path", path) : path;
        }

        /// The project's file tree as FileNode roots.
        public static List<FileNode> ProjectTree(string path)
        {
            var res = ParseObject(Run("project tree \"" + path + "\""));
            var roots = new List<FileNode>();
            var arr = Get(res, "tree") as object[];
            if (arr != null) FileNode.FromJsonArray(arr, roots);
            return roots;
        }
    }
}
