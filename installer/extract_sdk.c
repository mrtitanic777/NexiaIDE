/*
 * extract_sdk.c — Xbox 360 SDK extractor
 *
 * Extracts the Xbox 360 SDK from a user-supplied XDK installer EXE, without
 * ever executing it: the EXE is opened read-only and scanned for embedded MSCF
 * cabinet archives, which are then decompressed in-process via the FDI Cabinet
 * API (cabinet.dll, present on every Windows since 95).
 *
 * This was previously part of the hand-written installer (installer.c). The
 * installer is now NSIS, which handles everything else declaratively, but this
 * logic has no NSIS equivalent -- so it lives here as a small standalone tool
 * that NSIS invokes.
 *
 * Usage:
 *   extract_sdk.exe --find
 *       Print the path of an XDK installer if one can be found, else exit 1.
 *
 *   extract_sdk.exe <sdkInstallerPath> <destDir>
 *       Extract the SDK from <sdkInstallerPath> into <destDir>\SDK.
 *       Cab paths already carry an XDK\ prefix, so files land in <destDir>\SDK\XDK\...
 *
 * Exit codes: 0 = success, 1 = failure.
 * Progress is printed to stdout so NSIS can surface it via DetailPrint.
 */

#include <windows.h>
#include <shlobj.h>
#include <fdi.h>
#include <fcntl.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wctype.h>
#include <limits.h>

#define SDK_MAX_PATH   1024
#define MAX_CABS       32
#define SCAN_BUF_SIZE  (2 * 1024 * 1024)
#define IO_BUF_SIZE    (256 * 1024)

/* MSCF = Microsoft Cabinet File signature */
#define MSCF_SIGNATURE 0x4643534D

#pragma pack(push, 1)
typedef struct {
    DWORD signature;    /* MSCF */
    DWORD reserved1;
    DWORD cbCabinet;    /* total cabinet size */
    DWORD reserved2;
    DWORD coffFiles;    /* offset of first file entry */
    DWORD reserved3;
    BYTE  versionMinor;
    BYTE  versionMajor;
    WORD  cFolders;
    WORD  cFiles;
    WORD  flags;
} MSCF_HEADER;
#pragma pack(pop)

/* ── Utilities ─────────────────────────────────────────────────── */

static void EnsureDir(const WCHAR *dir)
{
    WCHAR tmp[SDK_MAX_PATH];
    wcsncpy(tmp, dir, SDK_MAX_PATH - 1);
    tmp[SDK_MAX_PATH - 1] = L'\0';

    for (WCHAR *p = tmp + 3; *p; p++) {
        if (*p == L'\\' || *p == L'/') {
            WCHAR saved = *p;
            *p = L'\0';
            CreateDirectoryW(tmp, NULL);
            *p = saved;
        }
    }
    CreateDirectoryW(tmp, NULL);
}

/* Reject absolute paths and ".." components. A cabinet is untrusted input:
 * without this, a crafted entry could write outside the destination. */
static BOOL IsPathSafe(const WCHAR *relPath)
{
    if (!relPath || relPath[0] == L'\0')
        return FALSE;

    if (relPath[0] == L'\\' || relPath[0] == L'/')
        return FALSE;

    if (((relPath[0] >= L'A' && relPath[0] <= L'Z') ||
         (relPath[0] >= L'a' && relPath[0] <= L'z')) &&
        relPath[1] == L':')
        return FALSE;

    for (const WCHAR *p = relPath; *p; p++) {
        BOOL atCompStart = (p == relPath) || (p[-1] == L'\\') || (p[-1] == L'/');
        if (atCompStart && p[0] == L'.' && p[1] == L'.' &&
            (p[2] == L'\\' || p[2] == L'/' || p[2] == L'\0'))
            return FALSE;
    }
    return TRUE;
}

/* ── Locating a user-supplied XDK installer ────────────────────── */

static BOOL MatchSdkInstaller(const WCHAR *filename)
{
    /* e.g. "XBOX360 SDK 21256.3.exe", "Xbox360SDK_21256.exe" */
    const WCHAR *name = wcsrchr(filename, L'\\');
    name = name ? name + 1 : filename;

    WCHAR lower[SDK_MAX_PATH];
    wcsncpy(lower, name, SDK_MAX_PATH - 1);
    lower[SDK_MAX_PATH - 1] = 0;
    for (WCHAR *p = lower; *p; p++) *p = towlower(*p);

    return ((wcsstr(lower, L"xbox360") || wcsstr(lower, L"xbox 360")) &&
            wcsstr(lower, L"sdk") &&
            wcsstr(lower, L".exe")) ? TRUE : FALSE;
}

static BOOL ScanDirectory(const WCHAR *dir, WCHAR *outPath, int maxLen)
{
    WCHAR pattern[SDK_MAX_PATH];
    _snwprintf(pattern, SDK_MAX_PATH, L"%s\\*", dir);

    WIN32_FIND_DATAW fd;
    HANDLE hFind = FindFirstFileW(pattern, &fd);
    if (hFind == INVALID_HANDLE_VALUE) return FALSE;

    do {
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
        if (MatchSdkInstaller(fd.cFileName)) {
            _snwprintf(outPath, maxLen, L"%s\\%s", dir, fd.cFileName);
            FindClose(hFind);
            return TRUE;
        }
    } while (FindNextFileW(hFind, &fd));

    FindClose(hFind);
    return FALSE;
}

static BOOL FindSdkInstaller(WCHAR *outPath, int maxLen)
{
    /* 1. Alongside this executable */
    {
        WCHAR selfDir[SDK_MAX_PATH];
        GetModuleFileNameW(NULL, selfDir, SDK_MAX_PATH);
        WCHAR *sl = wcsrchr(selfDir, L'\\');
        if (sl) *sl = 0;
        if (ScanDirectory(selfDir, outPath, maxLen)) return TRUE;
    }

    /* 2. Desktop */
    {
        WCHAR desktop[SDK_MAX_PATH];
        if (SHGetFolderPathW(NULL, CSIDL_DESKTOPDIRECTORY, NULL, 0, desktop) == S_OK) {
            if (ScanDirectory(desktop, outPath, maxLen)) return TRUE;
        }
    }

    /* 3. Downloads */
    {
        WCHAR downloads[SDK_MAX_PATH];
        if (SHGetFolderPathW(NULL, CSIDL_PROFILE, NULL, 0, downloads) == S_OK) {
            wcsncat(downloads, L"\\Downloads", SDK_MAX_PATH - wcslen(downloads) - 1);
            if (ScanDirectory(downloads, outPath, maxLen)) return TRUE;
        }
    }

    /* 4. Common fixed locations */
    static const WCHAR *dirs[] = { L"C:\\Temp", L"D:\\", L"C:\\Users\\Public\\Downloads", NULL };
    for (int i = 0; dirs[i]; i++)
        if (ScanDirectory(dirs[i], outPath, maxLen)) return TRUE;

    return FALSE;
}

/* ── FDI cabinet decompression ─────────────────────────────────── */

typedef struct {
    WCHAR outputDir[SDK_MAX_PATH];
    int   filesExtracted;
} FdiContext;

static FdiContext *s_ctx = NULL;

static FNALLOC(fdiAlloc) { return malloc(cb); }
static FNFREE(fdiFree)   { free(pv); }

static FNOPEN(fdiOpen)
{
    int flags = (oflag & _O_WRONLY)
        ? (_O_WRONLY | _O_CREAT | _O_TRUNC | _O_BINARY)
        : (_O_RDONLY | _O_BINARY);
    return _open(pszFile, flags, pmode);
}
static FNREAD(fdiRead)   { return _read((int)(INT_PTR)hf, pv, cb); }
static FNWRITE(fdiWrite) { return _write((int)(INT_PTR)hf, pv, cb); }
static FNCLOSE(fdiClose) { return _close((int)(INT_PTR)hf); }
static FNSEEK(fdiSeek)   { return _lseek((int)(INT_PTR)hf, dist, seektype); }

static FNFDINOTIFY(fdiNotify)
{
    switch (fdint) {
    case fdintCOPY_FILE: {
        if (!s_ctx) return 0;

        WCHAR widePath[SDK_MAX_PATH];
        MultiByteToWideChar(CP_ACP, 0, pfdin->psz1, -1, widePath, SDK_MAX_PATH);

        for (WCHAR *p = widePath; *p; p++)
            if (*p == L'/') *p = L'\\';

        /* Skip this entry rather than aborting the whole cabinet. */
        if (!IsPathSafe(widePath)) {
            wprintf(L"  skipping unsafe cab path: %ls\n", widePath);
            return 0;
        }

        WCHAR fullPath[SDK_MAX_PATH];
        _snwprintf(fullPath, SDK_MAX_PATH, L"%s\\%s", s_ctx->outputDir, widePath);

        WCHAR dirBuf[SDK_MAX_PATH];
        wcsncpy(dirBuf, fullPath, SDK_MAX_PATH - 1);
        dirBuf[SDK_MAX_PATH - 1] = 0;
        WCHAR *sl = wcsrchr(dirBuf, L'\\');
        if (sl) { *sl = 0; EnsureDir(dirBuf); }

        char ansiPath[SDK_MAX_PATH];
        WideCharToMultiByte(CP_ACP, 0, fullPath, -1, ansiPath, SDK_MAX_PATH, NULL, NULL);

        int fd = _open(ansiPath, _O_WRONLY | _O_CREAT | _O_TRUNC | _O_BINARY, 0666);
        if (fd != -1) s_ctx->filesExtracted++;
        return fd;
    }

    case fdintCLOSE_FILE_INFO:
        _close((int)(INT_PTR)pfdin->hf);
        return TRUE;

    default:
        return 0;
    }
}

/* Returns files extracted, or -1 on error. */
static int DecompressCab(const WCHAR *cabPath, const WCHAR *outputDir)
{
    WCHAR wideDir[SDK_MAX_PATH], wideName[SDK_MAX_PATH];
    const WCHAR *lastSlash = wcsrchr(cabPath, L'\\');
    if (lastSlash) {
        int dirLen = (int)(lastSlash - cabPath) + 1;
        if (dirLen >= SDK_MAX_PATH) dirLen = SDK_MAX_PATH - 1;
        memcpy(wideDir, cabPath, dirLen * sizeof(WCHAR));
        wideDir[dirLen] = 0;
        wcsncpy(wideName, lastSlash + 1, SDK_MAX_PATH - 1);
        wideName[SDK_MAX_PATH - 1] = 0;
    } else {
        wcscpy(wideDir, L".\\");
        wcsncpy(wideName, cabPath, SDK_MAX_PATH - 1);
        wideName[SDK_MAX_PATH - 1] = 0;
    }

    char ansiDir[SDK_MAX_PATH], ansiName[SDK_MAX_PATH];
    WideCharToMultiByte(CP_ACP, 0, wideDir, -1, ansiDir, SDK_MAX_PATH, NULL, NULL);
    WideCharToMultiByte(CP_ACP, 0, wideName, -1, ansiName, SDK_MAX_PATH, NULL, NULL);

    FdiContext ctx;
    ZeroMemory(&ctx, sizeof(ctx));
    wcsncpy(ctx.outputDir, outputDir, SDK_MAX_PATH - 1);
    s_ctx = &ctx;

    ERF erf;
    ZeroMemory(&erf, sizeof(erf));
    HFDI hfdi = FDICreate(fdiAlloc, fdiFree, fdiOpen, fdiRead,
                          fdiWrite, fdiClose, fdiSeek, cpuUNKNOWN, &erf);
    if (!hfdi) { s_ctx = NULL; return -1; }

    BOOL ok = FDICopy(hfdi, ansiName, ansiDir, 0, fdiNotify, NULL, NULL);

    FDIDestroy(hfdi);
    s_ctx = NULL;

    return ok ? ctx.filesExtracted : -1;
}

/* ── Extraction ────────────────────────────────────────────────── */

static int ExtractSdk(const WCHAR *installerPath, const WCHAR *destDir)
{
    wprintf(L"Opening SDK installer (read-only): %ls\n", installerPath);

    HANDLE hFile = CreateFileW(installerPath, GENERIC_READ, FILE_SHARE_READ,
                               NULL, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        wprintf(L"ERROR: cannot open installer\n");
        return 1;
    }

    DWORD fileSize = GetFileSize(hFile, NULL);
    if (fileSize < 1024) { CloseHandle(hFile); wprintf(L"ERROR: file too small\n"); return 1; }

    /* Cab paths already contain an XDK\ prefix, so this yields <dest>\SDK\XDK\... */
    WCHAR sdkDir[SDK_MAX_PATH], tempDir[SDK_MAX_PATH];
    _snwprintf(sdkDir, SDK_MAX_PATH, L"%s\\SDK", destDir);
    _snwprintf(tempDir, SDK_MAX_PATH, L"%s\\SDK\\_sdktmp", destDir);
    EnsureDir(sdkDir);
    EnsureDir(tempDir);

    /* ── Phase 1: locate embedded cabinets ── */
    BYTE *scanBuf = (BYTE *)malloc(SCAN_BUF_SIZE);
    if (!scanBuf) { CloseHandle(hFile); return 1; }

    struct { DWORD offset; DWORD size; } cabs[MAX_CABS];
    int cabCount = 0;
    DWORD pos = 0;

    while (pos < fileSize && cabCount < MAX_CABS) {
        SetFilePointer(hFile, pos, NULL, FILE_BEGIN);
        DWORD toRead = (fileSize - pos > SCAN_BUF_SIZE) ? SCAN_BUF_SIZE : (fileSize - pos);
        DWORD bytesRead = 0;
        if (!ReadFile(hFile, scanBuf, toRead, &bytesRead, NULL) || bytesRead == 0) break;

        /* Byte-by-byte: MSCF headers are not necessarily DWORD-aligned. */
        for (DWORD i = 0; i + sizeof(MSCF_HEADER) <= bytesRead; i++) {
            if (*(DWORD *)(scanBuf + i) == MSCF_SIGNATURE) {
                MSCF_HEADER *hdr = (MSCF_HEADER *)(scanBuf + i);
                if (hdr->versionMajor == 1 && hdr->versionMinor == 3 &&
                    hdr->cbCabinet > 256 && hdr->cbCabinet <= fileSize) {
                    cabs[cabCount].offset = pos + i;
                    cabs[cabCount].size = hdr->cbCabinet;
                    cabCount++;
                    if (cabCount >= MAX_CABS) break;
                    i += hdr->cbCabinet - 1;   /* skip past this cabinet */
                }
            }
        }

        if (bytesRead <= 64) break;
        pos += bytesRead - 64;   /* small overlap so a header spanning the boundary is not missed */
    }
    free(scanBuf);

    if (cabCount == 0) {
        CloseHandle(hFile);
        wprintf(L"ERROR: no cabinet archives found in installer\n");
        return 1;
    }

    wprintf(L"Found %d archive(s)\n", cabCount);

    /* ── Phase 2: copy each cabinet out, then decompress it ── */
    BYTE *ioBuf = (BYTE *)malloc(IO_BUF_SIZE);
    if (!ioBuf) { CloseHandle(hFile); return 1; }

    int totalFiles = 0;
    for (int c = 0; c < cabCount; c++) {
        WCHAR cabPath[SDK_MAX_PATH];
        _snwprintf(cabPath, SDK_MAX_PATH, L"%s\\sdk_%d.cab", tempDir, c + 1);

        HANDLE hCab = CreateFileW(cabPath, GENERIC_WRITE, 0, NULL,
                                  CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        if (hCab == INVALID_HANDLE_VALUE) continue;

        SetFilePointer(hFile, cabs[c].offset, NULL, FILE_BEGIN);
        DWORD remaining = cabs[c].size;
        while (remaining > 0) {
            DWORD chunk = (remaining > IO_BUF_SIZE) ? IO_BUF_SIZE : remaining;
            DWORD br = 0, wr = 0;
            /* Bail on a short/failed read: a truncated installer would otherwise
             * spin forever, since remaining never decreases. */
            if (!ReadFile(hFile, ioBuf, chunk, &br, NULL) || br == 0) break;
            WriteFile(hCab, ioBuf, br, &wr, NULL);
            remaining -= br;
        }
        CloseHandle(hCab);

        wprintf(L"Decompressing archive %d/%d...\n", c + 1, cabCount);
        int n = DecompressCab(cabPath, sdkDir);
        if (n < 0)
            wprintf(L"  warning: FDI failed on archive %d (continuing)\n", c + 1);
        else
            totalFiles += n;

        DeleteFileW(cabPath);   /* free the disk space before the next one */
    }
    free(ioBuf);
    CloseHandle(hFile);

    RemoveDirectoryW(tempDir);

    /* Verify a known header landed where it should. */
    WCHAR testPath[SDK_MAX_PATH];
    _snwprintf(testPath, SDK_MAX_PATH, L"%s\\XDK\\include\\xbox\\xtl.h", sdkDir);
    if (GetFileAttributesW(testPath) != INVALID_FILE_ATTRIBUTES) {
        wprintf(L"SDK extraction complete - %d files, xtl.h verified.\n", totalFiles);
        return 0;
    }

    wprintf(L"SDK extraction finished - %d files, but xtl.h was not found.\n", totalFiles);
    return (totalFiles > 0) ? 0 : 1;
}

/* ── Entry point ───────────────────────────────────────────────── */

int wmain(int argc, WCHAR **argv)
{
    if (argc >= 2 && _wcsicmp(argv[1], L"--find") == 0) {
        WCHAR found[SDK_MAX_PATH];
        if (FindSdkInstaller(found, SDK_MAX_PATH)) {
            /* %ls, not %s: MinGW's wprintf follows the C standard, where %s is a
             * NARROW string and %ls is wide (MSVC treats %s as wide). With %s
             * this printed only the first character, so NSIS would have captured
             * "C" instead of the installer path. */
            wprintf(L"%ls\n", found);
            return 0;
        }
        return 1;
    }

    if (argc < 3) {
        wprintf(L"Usage:\n"
                L"  extract_sdk.exe --find\n"
                L"  extract_sdk.exe <sdkInstallerPath> <destDir>\n");
        return 1;
    }

    return ExtractSdk(argv[1], argv[2]);
}
