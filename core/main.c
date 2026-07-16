/*
 * main.c — nexia-core's command line.
 *
 * One tool, subcommands, JSON on stdout. The IDE spawns it the way it already
 * spawns cl.exe and extract_sdk.exe, so nothing about the app's architecture
 * changes to accommodate it — and it runs from a shell with no app at all, which
 * is how it gets tested.
 *
 *   nexia-core sdk detect [--custom P] [--resources P] [--exe-dir P]
 *   nexia-core sdk state  [--custom P] [--resources P] [--exe-dir P]
 *   nexia-core sdk tool <name> [same hints]
 *   nexia-core sdk runtime [same hints]
 *   nexia-core version
 *
 * The hints exist because this cannot introspect its host: resourcesPath is
 * Electron's, and exe-dir is the IDE's, not ours. The caller supplies the facts;
 * C makes the decisions.
 */
#include "nexia.h"
#include <io.h>
#include <fcntl.h>

static const wchar_t *opt(int argc, wchar_t **argv, const wchar_t *name)
{
    for (int i = 0; i < argc - 1; i++)
        if (!wcscmp(argv[i], name)) return argv[i + 1];
    return NULL;
}

static void hints_from(int argc, wchar_t **argv, nx_hints *h)
{
    h->custom    = opt(argc, argv, L"--custom");
    h->resources = opt(argc, argv, L"--resources");
    h->exe_dir   = opt(argc, argv, L"--exe-dir");
}

static void print_sdk(const nx_sdk *s)
{
    printf("{\"ok\":true,\"sdk\":{");
    nx_json_field(stdout, "root", s->root);         printf(",");
    nx_json_field(stdout, "bin", s->bin);           printf(",");
    nx_json_field(stdout, "binWin32", s->bin_win32); printf(",");
    nx_json_field(stdout, "binX64", s->bin_x64);    printf(",");
    nx_json_field(stdout, "include", s->include);   printf(",");
    nx_json_field(stdout, "lib", s->lib);           printf(",");
    nx_json_field(stdout, "doc", s->doc);           printf(",");
    nx_json_field(stdout, "source", s->source);     printf(",");
    nx_json_field(stdout, "system", s->system);     printf(",");
    printf("\"bundled\":%s}}\n", s->bundled ? "true" : "false");
}

static int cmd_sdk(int argc, wchar_t **argv)
{
    if (argc < 1) { nx_json_error("sdk: expected a subcommand"); return 2; }

    nx_hints h;
    hints_from(argc, argv, &h);

    if (!wcscmp(argv[0], L"detect")) {
        nx_sdk s;
        if (!nx_sdk_detect(&h, &s)) { printf("{\"ok\":true,\"sdk\":null}\n"); return 0; }
        print_sdk(&s);
        return 0;
    }

    if (!wcscmp(argv[0], L"state")) {
        wchar_t root[NX_PATH] = L"";
        nx_sdk_state st = nx_sdk_detect_state(&h, root, NX_PATH);
        const char *name = st == NX_SDK_FULL ? "full" : st == NX_SDK_PARTIAL ? "partial" : "none";
        printf("{\"ok\":true,\"state\":\"%s\",", name);
        nx_json_field(stdout, "root", root);
        printf("}\n");
        return 0;
    }

    if (!wcscmp(argv[0], L"tool")) {
        if (argc < 2) { nx_json_error("sdk tool: expected a tool name"); return 2; }
        nx_sdk s;
        if (!nx_sdk_detect(&h, &s)) { printf("{\"ok\":true,\"path\":null}\n"); return 0; }
        wchar_t p[NX_PATH];
        if (!nx_tool_path(&s, argv[1], p, NX_PATH)) { printf("{\"ok\":true,\"path\":null}\n"); return 0; }
        printf("{\"ok\":true,");
        nx_json_field(stdout, "path", p);
        printf("}\n");
        return 0;
    }

    if (!wcscmp(argv[0], L"runtime")) {
        nx_sdk s;
        if (!nx_sdk_detect(&h, &s)) { printf("{\"ok\":true,\"missing\":[]}\n"); return 0; }
        const wchar_t *missing[4];
        int n = nx_missing_runtime(&s, missing, 4);
        printf("{\"ok\":true,\"missing\":[");
        for (int i = 0; i < n; i++) { if (i) printf(","); nx_json_str(stdout, missing[i]); }
        printf("]}\n");
        return 0;
    }

    nx_json_error("sdk: unknown subcommand");
    return 2;
}

int wmain(int argc, wchar_t **argv)
{
    /* Binary mode: we write UTF-8 ourselves and do not want the CRT translating
     * newlines into CRLF inside a JSON string. */
    _setmode(_fileno(stdout), _O_BINARY);

    if (argc < 2) {
        fwprintf(stderr, L"nexia-core — Nexia IDE's Xbox 360 logic\n\n"
                         L"  nexia-core sdk detect  [--custom P] [--resources P] [--exe-dir P]\n"
                         L"  nexia-core sdk state   [hints]\n"
                         L"  nexia-core sdk tool <name> [hints]\n"
                         L"  nexia-core sdk runtime [hints]\n"
                         L"  nexia-core version\n");
        return 2;
    }

    if (!wcscmp(argv[1], L"version")) { printf("{\"ok\":true,\"version\":\"0.1.0\"}\n"); return 0; }
    if (!wcscmp(argv[1], L"sdk"))     return cmd_sdk(argc - 2, argv + 2);
    if (!wcscmp(argv[1], L"tool"))    return nx_cmd_tool(argc - 2, argv + 2);
    if (!wcscmp(argv[1], L"xex"))     return nx_cmd_xex(argc - 2, argv + 2);
    if (!wcscmp(argv[1], L"project")) return nx_cmd_project(argc - 2, argv + 2);
    if (!wcscmp(argv[1], L"emulator")) return nx_cmd_emulator(argc - 2, argv + 2);
    if (!wcscmp(argv[1], L"extensions")) return nx_cmd_extensions(argc - 2, argv + 2);
    if (!wcscmp(argv[1], L"build"))   return nx_cmd_build(argc - 2, argv + 2);
    if (!wcscmp(argv[1], L"devkit"))  return nx_cmd_devkit(argc - 2, argv + 2);

    nx_json_error("unknown command");
    return 2;
}
