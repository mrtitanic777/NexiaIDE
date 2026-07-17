/*
 * builder.cpp — see builder.h.
 *
 * Response files carry the argv to cl.exe/link.exe rather than a command line:
 * the plan's args are already quoted for direct tool invocation, and passing
 * them through `tool run`'s own re-quoting would double them. A .rsp holds each
 * arg verbatim on its own line, exactly as the TypeScript build writes link.rsp.
 * imagexex takes its few args directly.
 */
#include "builder.h"
#include "core_bridge.h"

#include <windows.h>
#include <cstdio>
#include <vector>

extern "C" {
#include "json_parse.h"
}

static std::wstring jvW(const jv* obj, const wchar_t* key, const wchar_t* fb = L"") {
    const wchar_t* s = jv_get_str(obj, key, fb);
    return s ? std::wstring(s) : std::wstring(fb);
}

static std::string baseName(const std::string& p) {
    size_t s = p.find_last_of("\\/");
    return s == std::string::npos ? p : p.substr(s + 1);
}

// mkdir -p: the output dir must exist before cl.exe writes .obj files into it.
static void ensureDir(const std::wstring& dir) {
    std::wstring p;
    for (wchar_t c : dir) {
        p += c;
        if (c == L'\\' || c == L'/') CreateDirectoryW(p.c_str(), NULL);
    }
    CreateDirectoryW(dir.c_str(), NULL);
}

// Write a jv array of strings to `path`, one UTF-8 arg per line (verbatim).
static bool writeRsp(const std::wstring& path, const jv* args) {
    FILE* f = _wfopen(path.c_str(), L"wb");
    if (!f) return false;
    for (int i = 0; i < jv_count(args); i++) {
        std::string a = u8(jv_str_or(jv_at(args, i), L""));
        fwrite(a.data(), 1, a.size(), f);
        fputc('\n', f);
    }
    fclose(f);
    return true;
}

// Run a tool through nexia-core's `tool run` (which sets the SDK env), emit its
// output, and return the exit code (-1 if nexia-core itself failed to answer).
static int runTool(const std::wstring& cmd,
                   const std::function<void(const std::string&)>& sink) {
    std::string res = core_run(cmd);
    jv* j = jv_parse_utf8(res.c_str(), res.size(), NULL);
    if (!j) { sink("  (no response from nexia-core)\n"); return -1; }
    if (!jv_bool_or(jv_get(j, L"ok"), 0) && jv_get(j, L"exitCode") == NULL) {
        sink("  " + u8(jv_str_or(jv_get(j, L"error"), L"tool run failed")) + "\n");
        jv_free(j);
        return -1;
    }
    int code = (int)jv_num_or(jv_get(j, L"exitCode"), -1);
    std::string out = u8(jv_str_or(jv_get(j, L"output"), L""));
    if (!out.empty()) sink(out);
    jv_free(j);
    return code;
}

bool core_build(const std::wstring& projectPath, const std::wstring& config,
                const std::function<void(const std::string&)>& sink) {
    std::wstring cfgFile = projectPath + L"\\nexia.json";
    std::string planStr = core_run(L"build args \"" + cfgFile + L"\" " + config);
    jv* plan = jv_parse_utf8(planStr.c_str(), planStr.size(), NULL);
    if (!plan || !jv_bool_or(jv_get(plan, L"ok"), 0)) {
        sink("Build FAILED: " + (plan ? u8(jv_str_or(jv_get(plan, L"error"), L"could not plan the build"))
                                      : std::string("nexia-core did not answer")) + "\n");
        if (plan) jv_free(plan);
        return false;
    }

    std::wstring outDir = jvW(plan, L"outputDir");
    std::wstring output = jvW(plan, L"output");
    ensureDir(outDir);
    sink("------ Build started: " + u8(config) + " ------\n");

    // ── compile (plan order: the /Yc pass first, then /Yu) ──
    const jv* compile = jv_get(plan, L"compile");
    std::wstring crsp = outDir + L"\\_nexia_compile.rsp";
    for (int i = 0; i < jv_count(compile); i++) {
        const jv* e = jv_at(compile, i);
        sink("  " + baseName(u8(jv_str_or(jv_get(e, L"source"), L""))) + "\n");
        if (!writeRsp(crsp, jv_get(e, L"args"))) { sink("  (could not write the compile response file)\n"); jv_free(plan); return false; }
        if (runTool(L"tool run cl.exe @\"" + crsp + L"\"", sink) != 0) {
            sink("Build FAILED.\n"); jv_free(plan); return false;
        }
    }

    // ── link or archive ──
    const jv* link = jv_get(plan, L"link");
    const jv* archive = jv_get(plan, L"archive");
    if (link && jv_count(link) > 0) {
        sink("Link:\n");
        std::wstring lrsp = outDir + L"\\_nexia_link.rsp";
        writeRsp(lrsp, link);
        if (runTool(L"tool run link.exe @\"" + lrsp + L"\"", sink) != 0) {
            sink("Build FAILED.\n"); jv_free(plan); return false;
        }
    } else if (archive && jv_count(archive) > 0) {
        sink("Lib:\n");
        std::wstring arsp = outDir + L"\\_nexia_lib.rsp";
        writeRsp(arsp, archive);
        if (runTool(L"tool run lib.exe @\"" + arsp + L"\"", sink) != 0) {
            sink("Build FAILED.\n"); jv_free(plan); return false;
        }
        sink("Build succeeded (static library).\n");
        jv_free(plan);
        return true;
    }

    // ── ImageXex → .xex (executables and dlls) ──
    if (!output.empty()) {
        std::wstring xex = output;
        size_t dot = xex.find_last_of(L'.');
        xex = (dot == std::wstring::npos) ? xex + L".xex" : xex.substr(0, dot) + L".xex";
        sink("ImageXex:\n");
        // imagexex has few args and this project's paths have no spaces; pass
        // them directly rather than assume it reads @response files.
        std::wstring cmd = L"tool run imagexex.exe /nologo /out:" + xex + L" " + output;
        if (runTool(cmd, sink) != 0) { sink("Build FAILED.\n"); jv_free(plan); return false; }
        sink("Build succeeded  \xE2\x86\x92  " + u8(xex) + "\n");
    }

    jv_free(plan);
    return true;
}
