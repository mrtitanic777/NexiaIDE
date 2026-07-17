/*
 * Builder.cs — the native build loop, WPF edition (port of the C++ builder).
 *
 * Asks nexia-core for the compile plan (`build args`), then runs each cl.exe /
 * link.exe / imagexex step through nexia-core's `tool run`, which resolves the
 * tool and sets the SDK environment. Native orchestration; every Xbox-specific
 * decision stays in the C backend. Response files carry the pre-quoted argv so
 * `tool run`'s own quoting does not double them.
 */
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace NexiaUI
{
    static class Builder
    {
        static string BaseName(string p)
        {
            int s = p.LastIndexOfAny(new[] { '\\', '/' });
            return s < 0 ? p : p.Substring(s + 1);
        }

        static bool WriteRsp(string path, object[] args)
        {
            try
            {
                using (var w = new StreamWriter(path, false, new UTF8Encoding(false)))
                    foreach (var a in args) w.Write((a as string ?? "") + "\n");
                return true;
            }
            catch { return false; }
        }

        static int ToInt(object v)
        {
            if (v is int) return (int)v;
            if (v is decimal) return (int)(decimal)v;
            if (v is long) return (int)(long)v;
            return -1;
        }

        // Run a tool via `tool run`, emit its output, return the exit code.
        static int RunTool(string cmd, Action<string> sink)
        {
            var res = CoreBridge.ParseObject(CoreBridge.Run(cmd));
            if (res == null) { sink("  (no response from nexia-core)\n"); return -1; }
            string outp = CoreBridge.Str(res, "output");
            if (outp.Length > 0) sink(outp);
            return ToInt(CoreBridge.Get(res, "exitCode"));
        }

        public static bool Build(string projectPath, string config, Action<string> sink)
        {
            var plan = CoreBridge.ParseObject(CoreBridge.Run("build args \"" + projectPath + "\\nexia.json\" " + config));
            bool ok = plan != null && CoreBridge.Get(plan, "ok") is bool && (bool)plan["ok"];
            if (!ok)
            {
                sink("Build FAILED: " + (plan != null ? CoreBridge.Str(plan, "error", "could not plan the build")
                                                       : "nexia-core did not answer") + "\n");
                return false;
            }

            string outDir = CoreBridge.Str(plan, "outputDir");
            string output = CoreBridge.Str(plan, "output");
            try { Directory.CreateDirectory(outDir); } catch { }
            sink("------ Build started: " + config + " ------\n");

            // ── compile (plan order: the /Yc pass first, then /Yu) ──
            var compile = CoreBridge.Get(plan, "compile") as object[];
            string crsp = Path.Combine(outDir, "_nexia_compile.rsp");
            if (compile != null)
                foreach (var ce in compile)
                {
                    var e = ce as Dictionary<string, object>;
                    sink("  " + BaseName(CoreBridge.Str(e, "source")) + "\n");
                    WriteRsp(crsp, CoreBridge.Get(e, "args") as object[] ?? new object[0]);
                    if (RunTool("tool run cl.exe @\"" + crsp + "\"", sink) != 0) { sink("Build FAILED.\n"); return false; }
                }

            // ── link or archive ──
            var link = CoreBridge.Get(plan, "link") as object[];
            var archive = CoreBridge.Get(plan, "archive") as object[];
            if (link != null && link.Length > 0)
            {
                sink("Link:\n");
                string lrsp = Path.Combine(outDir, "_nexia_link.rsp");
                WriteRsp(lrsp, link);
                if (RunTool("tool run link.exe @\"" + lrsp + "\"", sink) != 0) { sink("Build FAILED.\n"); return false; }
            }
            else if (archive != null && archive.Length > 0)
            {
                sink("Lib:\n");
                string arsp = Path.Combine(outDir, "_nexia_lib.rsp");
                WriteRsp(arsp, archive);
                if (RunTool("tool run lib.exe @\"" + arsp + "\"", sink) != 0) { sink("Build FAILED.\n"); return false; }
                sink("Build succeeded (static library).\n");
                return true;
            }

            // ── ImageXex -> .xex ──
            if (!string.IsNullOrEmpty(output))
            {
                string xex = Path.ChangeExtension(output, ".xex");
                sink("ImageXex:\n");
                if (RunTool("tool run imagexex.exe /nologo /out:" + xex + " " + output, sink) != 0) { sink("Build FAILED.\n"); return false; }
                sink("Build succeeded  →  " + xex + "\n");
            }
            return true;
        }
    }
}
