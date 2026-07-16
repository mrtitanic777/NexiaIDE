/*
 * extensions.c — where extensions live on disk, and moving them around.
 *
 * A partial port of src/main/extensions.ts.
 *
 * WHAT DOES NOT MOVE: THE JSON.
 * The manager reads two kinds of JSON — third-party manifest.json files and its
 * own extensions-state.json — and nexia.h is explicit that this program emits
 * JSON and never parses it. That is not squeamishness. A hand-written reader
 * would have to agree with JSON.parse about \u escapes, duplicate keys and
 * number syntax on files the IDE did not author, and the first manifest it read
 * differently would install an extension under the wrong id. Manifest parsing,
 * the id/name/version validation and the state file stay in TypeScript, which
 * has a correct parser already.
 *
 * So does installFromZip: unpacking a zip means an inflate implementation or
 * shelling back out to PowerShell's Expand-Archive, and C is not better at
 * either. It calls installFromFolder once unpacked, which is here.
 *
 * WHAT MOVES: THE FILESYSTEM UNDER IT.
 * The directory scan, the recursive copy an install is, the recursive delete an
 * uninstall is, and the template writer. TypeScript reads the manifest and
 * tells us the id; we do the OS work. That is the split nexia.h already
 * describes — the caller introspects, C decides and acts.
 */
#include "extensions.h"

static const wchar_t *opt(int argc, wchar_t **argv, const wchar_t *name)
{
    for (int i = 0; i < argc - 1; i++)
        if (!wcscmp(argv[i], name)) return argv[i + 1];
    return NULL;
}

/* Write a wide string as UTF-8 with nothing added. nx_json_str would quote and
 * escape it, which is right for JSON values and wrong for a README. */
static void fput_utf8(FILE *f, const wchar_t *s)
{
    int need = WideCharToMultiByte(CP_UTF8, 0, s, -1, NULL, 0, NULL, NULL);
    if (need <= 0) return;
    char *b = (char *)malloc((size_t)need);
    if (!b) return;
    WideCharToMultiByte(CP_UTF8, 0, s, -1, b, need, NULL, NULL);
    fputs(b, f);
    free(b);
}

/* fs.mkdirSync(path, { recursive: true }). */
static int mkdirp(const wchar_t *path)
{
    wchar_t tmp[NX_PATH];
    nx_copy(tmp, NX_PATH, path);

    for (wchar_t *p = tmp + 1; *p; p++) {
        if (*p != L'\\' && *p != L'/') continue;
        *p = 0;
        /* "C:" is a drive, not a directory anyone can create; only a real
         * component failing means anything. */
        if (!(p - tmp == 2 && tmp[1] == L':'))
            if (!CreateDirectoryW(tmp, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) return 0;
        *p = L'\\';
    }
    if (!CreateDirectoryW(tmp, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) return 0;
    return 1;
}

/*
 * os.homedir(). Node reads USERPROFILE first and we must land on the same
 * ~/.nexia-ide the TypeScript did, or the two disagree about what is installed.
 */
static int home_dir(const wchar_t *hint, wchar_t *out, size_t cap)
{
    if (hint && *hint) { nx_copy(out, cap, hint); return 1; }
    DWORD got = GetEnvironmentVariableW(L"USERPROFILE", out, (DWORD)cap);
    return got > 0 && got < cap;
}

/* copyDir(): a file at a time, recursing into directories, overwriting what is
 * there — fs.copyFileSync's default. */
static int copy_dir(const wchar_t *src, const wchar_t *dest)
{
    if (!mkdirp(dest)) return 0;

    wchar_t pat[NX_PATH];
    nx_join(pat, NX_PATH, src, L"*");
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(pat, &fd);
    if (h == INVALID_HANDLE_VALUE) return 0;

    int ok = 1;
    do {
        if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) continue;
        wchar_t s[NX_PATH], d[NX_PATH];
        nx_join(s, NX_PATH, src, fd.cFileName);
        nx_join(d, NX_PATH, dest, fd.cFileName);
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ok = copy_dir(s, d) && ok;
        else ok = CopyFileW(s, d, FALSE) && ok;
    } while (FindNextFileW(h, &fd));

    FindClose(h);
    return ok;
}

/* fs.rmSync(path, { recursive: true, force: true }). */
static int rm_rf(const wchar_t *path)
{
    DWORD a = GetFileAttributesW(path);
    if (a == INVALID_FILE_ATTRIBUTES) return 1;   /* force: already gone is success */
    if (!(a & FILE_ATTRIBUTE_DIRECTORY)) return DeleteFileW(path) ? 1 : 0;

    wchar_t pat[NX_PATH];
    nx_join(pat, NX_PATH, path, L"*");
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(pat, &fd);

    int ok = 1;
    if (h != INVALID_HANDLE_VALUE) {
        do {
            if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) continue;
            wchar_t c[NX_PATH];
            nx_join(c, NX_PATH, path, fd.cFileName);
            ok = rm_rf(c) && ok;
        } while (FindNextFileW(h, &fd));
        FindClose(h);
    }
    return RemoveDirectoryW(path) && ok;
}

/*
 * createTemplate's id: the name lowercased, every run of non-[a-z0-9] collapsed
 * to one dash, and the dashes trimmed off both ends.
 */
static void slug(const wchar_t *name, wchar_t *out, size_t cap)
{
    size_t n = 0;
    int pending = 0, any = 0;

    for (const wchar_t *p = name; *p && n + 1 < cap; p++) {
        wchar_t c = *p;
        int splits = 0;

        if (c >= L'A' && c <= L'Z') c = (wchar_t)(c - L'A' + L'a');
        /* The one character whose JavaScript lowercase is a plain ASCII letter.
         * towlower leaves it alone, the filter below would then drop it, and the
         * id would name a different folder than the one the TypeScript made. */
        else if (c == 0x212A) c = L'k';                     /* KELVIN SIGN */
        /* This one lowercases to two code points — "i" and a combining dot —
         * and the dot is not [a-z0-9], so it separates rather than vanishes:
         * "İstanbul" slugs to "i-stanbul", not "istanbul". */
        else if (c == 0x0130) { c = L'i'; splits = 1; }     /* I WITH DOT ABOVE */

        if ((c >= L'a' && c <= L'z') || (c >= L'0' && c <= L'9')) {
            if (pending && any) out[n++] = L'-';
            pending = splits;
            if (n + 1 < cap) { out[n++] = c; any = 1; }
        } else {
            pending = 1;
        }
    }
    out[n] = 0;
}

static const wchar_t *default_icon(const wchar_t *type)
{
    if (!wcscmp(type, L"tool"))     return L"\U0001F527";
    if (!wcscmp(type, L"template")) return L"\U0001F4CB";
    if (!wcscmp(type, L"snippet"))  return L"✂";
    if (!wcscmp(type, L"theme"))    return L"\U0001F3A8";
    if (!wcscmp(type, L"library"))  return L"\U0001F4DA";
    if (!wcscmp(type, L"plugin"))   return L"\U0001F50C";
    return L"\U0001F4E6";
}

/*
 * JSON.stringify(manifest, null, 2), field for field and in the same order: the
 * TypeScript reads this file straight back, and the parity test diffs the bytes
 * against what it would have written.
 */
static int write_manifest(const wchar_t *path, const wchar_t *id, const wchar_t *name,
                          const wchar_t *type, const wchar_t *desc)
{
    FILE *f = _wfopen(path, L"wb");
    if (!f) return 0;

    fputs("{\n  \"id\": ", f);            nx_json_str(f, id);
    fputs(",\n  \"name\": ", f);          nx_json_str(f, name);
    fputs(",\n  \"version\": \"1.0.0\",\n  \"author\": \"Unknown\",\n  \"description\": ", f);
    nx_json_str(f, desc);
    fputs(",\n  \"type\": ", f);          nx_json_str(f, type);
    fputs(",\n  \"icon\": ", f);          nx_json_str(f, default_icon(type));
    fputs(",\n  \"tags\": [\n    ", f);   nx_json_str(f, type);
    fputs("\n  ]\n}", f);

    fclose(f);
    return 1;
}

static int write_readme(const wchar_t *path, const wchar_t *name, const wchar_t *desc)
{
    FILE *f = _wfopen(path, L"wb");
    if (!f) return 0;
    fputs("# ", f);   fput_utf8(f, name);
    fputs("\n\n", f); fput_utf8(f, desc);
    fputs("\n\n## Installation\n\nImport this folder into Nexia IDE via the Extensions panel.\n", f);
    fclose(f);
    return 1;
}

/*
 * getInstalled()'s discovery half: the subdirectories that have a manifest.json.
 * The manifests themselves are the caller's to read, so what comes back is
 * where they are, in the order the directory hands them over. getInstalled
 * sorts by manifest.name once it has parsed them, so this order is never the
 * one a user sees.
 */
static void list_extensions(const wchar_t *ext_dir)
{
    wchar_t pat[NX_PATH];
    nx_join(pat, NX_PATH, ext_dir, L"*");
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(pat, &fd);

    printf("{\"ok\":true,\"extensions\":[");
    if (h != INVALID_HANDLE_VALUE) {
        int n = 0;
        do {
            if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
            if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) continue;

            wchar_t dir[NX_PATH], man[NX_PATH];
            nx_join(dir, NX_PATH, ext_dir, fd.cFileName);
            nx_join(man, NX_PATH, dir, L"manifest.json");
            if (!nx_exists(man)) continue;

            if (n++) printf(",");
            printf("{");
            nx_json_field(stdout, "id", fd.cFileName); printf(",");
            nx_json_field(stdout, "path", dir);        printf(",");
            nx_json_field(stdout, "manifest", man);
            printf("}");
        } while (FindNextFileW(h, &fd));
        FindClose(h);
    }
    printf("]}\n");
}

int nx_cmd_extensions(int argc, wchar_t **argv)
{
    if (argc < 1) { nx_json_error("extensions: expected a subcommand"); return 2; }

    wchar_t home[NX_PATH];
    if (!home_dir(opt(argc, argv, L"--home"), home, NX_PATH)) {
        nx_json_error("extensions: no home directory (USERPROFILE is unset); pass --home");
        return 2;
    }

    wchar_t nexia[NX_PATH], ext_dir[NX_PATH], state[NX_PATH];
    nx_join(nexia, NX_PATH, home, L".nexia-ide");
    nx_join(ext_dir, NX_PATH, nexia, L"extensions");
    nx_join(state, NX_PATH, nexia, L"extensions-state.json");

    /* The constructor makes the directory before anything else can run, so
     * every subcommand starts from the same guarantee its methods did. */
    if (!mkdirp(ext_dir)) { nx_json_error("extensions: could not create the extensions directory"); return 1; }

    if (!wcscmp(argv[0], L"dir")) {
        printf("{\"ok\":true,");
        nx_json_field(stdout, "path", ext_dir); printf(",");
        nx_json_field(stdout, "stateFile", state);
        printf("}\n");
        return 0;
    }

    if (!wcscmp(argv[0], L"list")) {
        list_extensions(ext_dir);
        return 0;
    }

    if (!wcscmp(argv[0], L"install")) {
        if (argc < 3) { nx_json_error("extensions install: expected a folder and an id"); return 2; }
        const wchar_t *src = argv[1], *id = argv[2];

        wchar_t man[NX_PATH];
        nx_join(man, NX_PATH, src, L"manifest.json");
        /* The caller sees this one, so it is worded exactly as installFromFolder
         * worded it. */
        if (!nx_exists(man)) { nx_json_error("No manifest.json found in the selected folder."); return 1; }

        wchar_t dest[NX_PATH];
        nx_join(dest, NX_PATH, ext_dir, id);
        if (!rm_rf(dest)) { nx_json_error("extensions install: could not replace the existing extension"); return 1; }
        if (!copy_dir(src, dest)) { nx_json_error("extensions install: copy failed"); return 1; }

        printf("{\"ok\":true,");
        nx_json_field(stdout, "path", dest);
        printf("}\n");
        return 0;
    }

    if (!wcscmp(argv[0], L"uninstall")) {
        if (argc < 2) { nx_json_error("extensions uninstall: expected an id"); return 2; }
        wchar_t dest[NX_PATH];
        nx_join(dest, NX_PATH, ext_dir, argv[1]);
        if (!rm_rf(dest)) { nx_json_error("extensions uninstall: could not remove the extension"); return 1; }
        printf("{\"ok\":true,");
        nx_json_field(stdout, "path", dest);
        printf("}\n");
        return 0;
    }

    if (!wcscmp(argv[0], L"template")) {
        if (argc < 3) { nx_json_error("extensions template: expected a name and a type"); return 2; }
        const wchar_t *name = argv[1], *type = argv[2];

        wchar_t id[NX_PATH];
        slug(name, id, NX_PATH);

        wchar_t dir[NX_PATH];
        nx_join(dir, NX_PATH, ext_dir, id);
        if (!mkdirp(dir)) { nx_json_error("extensions template: could not create the extension directory"); return 1; }

        wchar_t desc[NX_PATH];
        _snwprintf(desc, NX_PATH - 1, L"A %ls extension for Nexia IDE.", type);
        desc[NX_PATH - 1] = 0;

        wchar_t man[NX_PATH], readme[NX_PATH];
        nx_join(man, NX_PATH, dir, L"manifest.json");
        nx_join(readme, NX_PATH, dir, L"README.md");
        if (!write_manifest(man, id, name, type, desc)) { nx_json_error("extensions template: could not write manifest.json"); return 1; }
        if (!write_readme(readme, name, desc)) { nx_json_error("extensions template: could not write README.md"); return 1; }

        printf("{\"ok\":true,");
        nx_json_field(stdout, "id", id); printf(",");
        nx_json_field(stdout, "path", dir);
        printf("}\n");
        return 0;
    }

    if (!wcscmp(argv[0], L"open")) {
        wchar_t cmd[NX_PATH + 32];
        _snwprintf(cmd, NX_PATH + 31, L"explorer.exe \"%ls\"", ext_dir);
        cmd[NX_PATH + 31] = 0;

        STARTUPINFOW si;
        ZeroMemory(&si, sizeof(si));
        si.cb = sizeof(si);
        PROCESS_INFORMATION pi;
        ZeroMemory(&pi, sizeof(pi));

        /* spawn(..., { detached: true }).unref(): started, disowned, not waited
         * for. Explorer outlives us either way. */
        if (!CreateProcessW(NULL, cmd, NULL, NULL, FALSE, DETACHED_PROCESS, NULL, NULL, &si, &pi)) {
            nx_json_error("extensions open: could not start explorer");
            return 1;
        }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        printf("{\"ok\":true}\n");
        return 0;
    }

    nx_json_error("extensions: unknown subcommand");
    return 2;
}
