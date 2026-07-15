/*
 * install_pack.c — Nexia IDE Installer Payload Packer (v3, incremental)
 *
 * Takes a built installer EXE and a directory of files to install,
 * and appends a zlib-compressed payload to the EXE so it becomes
 * a self-extracting installer.
 *
 * v3 adds incremental compression:
 *   - Compressed blobs are cached in <files_dir>\..\dist\.build-cache\blobs\
 *   - Each cache entry stores: source file size + mtime + compressed data
 *   - On rebuild, unchanged files reuse cached blobs (instant)
 *   - Only new or modified files get compressed
 *
 * Usage:
 *   install_pack.exe <installer.exe> <files_dir> <output.exe> [--raw]
 *
 * Build (MinGW):
 *   gcc -O2 -DUNICODE -D_UNICODE install_pack.c -o install_pack.exe
 *       -luser32 -lshlwapi -lshell32 -ladvapi32 -lz -static
 */

#include "installer.h"
#include "nxcompress.h"
#include <stdio.h>

/* ── Cache blob header ── */
#pragma pack(push, 1)
typedef struct {
    DWORD   magic;          /* 'NXCC' */
    DWORD   srcSize;        /* original file size */
    DWORD   srcTimeLow;     /* FILETIME low dword */
    DWORD   srcTimeHigh;    /* FILETIME high dword */
    DWORD   compressedSize; /* size of compressed data following this header */
} NxCacheHeader;
#pragma pack(pop)

#define NX_CACHE_MAGIC 0x4343584E  /* 'NXCC' */

/* ── Recursively enumerate files in a directory ── */
typedef struct {
    NxInsFileEntry  *entries;
    int              count;
    int              capacity;
    WCHAR            baseDir[NXI_MAX_PATH];
    int              baseDirLen;
    /* Per-file metadata for caching */
    DWORD           *fileSizes;
    FILETIME        *fileTimes;
} FileCollector;

static void sCollectFiles(FileCollector *fc, const WCHAR *dir)
{
    WCHAR searchPath[NXI_MAX_PATH];
    wsprintfW(searchPath, L"%s\\*", dir);

    WIN32_FIND_DATAW fd;
    HANDLE hFind = FindFirstFileW(searchPath, &fd);
    if (hFind == INVALID_HANDLE_VALUE) return;

    do {
        if (fd.cFileName[0] == L'.') continue;

        WCHAR fullPath[NXI_MAX_PATH];
        wsprintfW(fullPath, L"%s\\%s", dir, fd.cFileName);

        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            sCollectFiles(fc, fullPath);
        } else {
            if (fc->count >= fc->capacity) {
                int newCapacity = fc->capacity ? fc->capacity * 2 : 256;
                /* realloc into temp pointers so the originals are not lost on
                 * failure (assigning NULL back would leak and then crash). */
                NxInsFileEntry *newEntries = (NxInsFileEntry *)realloc(fc->entries,
                    newCapacity * sizeof(NxInsFileEntry));
                DWORD *newSizes = (DWORD *)realloc(fc->fileSizes,
                    newCapacity * sizeof(DWORD));
                FILETIME *newTimes = (FILETIME *)realloc(fc->fileTimes,
                    newCapacity * sizeof(FILETIME));

                if (!newEntries || !newSizes || !newTimes) {
                    wprintf(L"  ERROR: Out of memory growing file table\n");
                    /* Free whatever did succeed (and the originals on the
                     * pointers that failed) before aborting. */
                    free(newEntries ? newEntries : fc->entries);
                    free(newSizes ? newSizes : fc->fileSizes);
                    free(newTimes ? newTimes : fc->fileTimes);
                    FindClose(hFind);
                    exit(1);
                }

                fc->entries = newEntries;
                fc->fileSizes = newSizes;
                fc->fileTimes = newTimes;
                fc->capacity = newCapacity;
            }

            NxInsFileEntry *fe = &fc->entries[fc->count];
            ZeroMemory(fe, sizeof(NxInsFileEntry));

            const WCHAR *rel = fullPath + fc->baseDirLen;
            if (*rel == L'\\' || *rel == L'/') rel++;
            wcsncpy(fe->relativePath, rel, 259);

            HANDLE hFile = CreateFileW(fullPath, GENERIC_READ, FILE_SHARE_READ,
                                       NULL, OPEN_EXISTING, 0, NULL);
            if (hFile != INVALID_HANDLE_VALUE) {
                fe->dataSize = GetFileSize(hFile, NULL);
                FILETIME ft;
                GetFileTime(hFile, NULL, NULL, &ft);
                fc->fileSizes[fc->count] = fe->dataSize;
                fc->fileTimes[fc->count] = ft;
                CloseHandle(hFile);
            }

            fe->attributes = fd.dwFileAttributes & ~FILE_ATTRIBUTE_DIRECTORY;
            fe->compressedSize = 0;
            fc->count++;
        }
    } while (FindNextFileW(hFind, &fd));

    FindClose(hFind);
}

/* ── Generate cache filename from relative path ── */
static void sCachePathForFile(const WCHAR *cacheDir, const WCHAR *relPath, WCHAR *out)
{
    /* Simple hash of the relative path to make a flat filename */
    unsigned int hash = 5381;
    for (const WCHAR *p = relPath; *p; p++) {
        WCHAR c = (*p == L'\\') ? L'/' : *p;  /* normalize slashes */
        hash = ((hash << 5) + hash) + (unsigned int)c;
    }
    wsprintfW(out, L"%s\\%08X.nxc", cacheDir, hash);
}

/* ── Try to load cached compressed blob ── */
static BYTE *sLoadCachedBlob(const WCHAR *cachePath, DWORD srcSize, FILETIME srcTime, DWORD *outCompSize)
{
    HANDLE hFile = CreateFileW(cachePath, GENERIC_READ, FILE_SHARE_READ,
                               NULL, OPEN_EXISTING, 0, NULL);
    if (hFile == INVALID_HANDLE_VALUE) return NULL;

    NxCacheHeader hdr;
    DWORD bytesRead;
    ReadFile(hFile, &hdr, sizeof(hdr), &bytesRead, NULL);

    if (bytesRead != sizeof(hdr) || hdr.magic != NX_CACHE_MAGIC ||
        hdr.srcSize != srcSize ||
        hdr.srcTimeLow != srcTime.dwLowDateTime ||
        hdr.srcTimeHigh != srcTime.dwHighDateTime) {
        CloseHandle(hFile);
        return NULL;
    }

    BYTE *blob = (BYTE *)malloc(hdr.compressedSize);
    if (!blob) { CloseHandle(hFile); return NULL; }

    ReadFile(hFile, blob, hdr.compressedSize, &bytesRead, NULL);
    CloseHandle(hFile);

    if (bytesRead != hdr.compressedSize) { free(blob); return NULL; }

    *outCompSize = hdr.compressedSize;
    return blob;
}

/* ── Save compressed blob to cache ── */
static void sSaveCachedBlob(const WCHAR *cachePath, DWORD srcSize, FILETIME srcTime,
                            const BYTE *compData, DWORD compSize)
{
    HANDLE hFile = CreateFileW(cachePath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);
    if (hFile == INVALID_HANDLE_VALUE) return;

    NxCacheHeader hdr;
    hdr.magic = NX_CACHE_MAGIC;
    hdr.srcSize = srcSize;
    hdr.srcTimeLow = srcTime.dwLowDateTime;
    hdr.srcTimeHigh = srcTime.dwHighDateTime;
    hdr.compressedSize = compSize;

    DWORD written;
    WriteFile(hFile, &hdr, sizeof(hdr), &written, NULL);
    WriteFile(hFile, compData, compSize, &written, NULL);
    CloseHandle(hFile);
}

/* ── Compress a single file (chunked) and return the blob ── */
#define NX_CHUNK_SIZE (1 * 1024 * 1024)

static BYTE *sCompressFile(const WCHAR *fullPath, DWORD originalSize, DWORD *outCompSize)
{
    if (originalSize == 0) { *outCompSize = 0; return NULL; }

    HANDLE hIn = CreateFileW(fullPath, GENERIC_READ, FILE_SHARE_READ,
                             NULL, OPEN_EXISTING, 0, NULL);
    if (hIn == INVALID_HANDLE_VALUE) { *outCompSize = 0; return NULL; }

    DWORD chunkCount = (originalSize + NX_CHUNK_SIZE - 1) / NX_CHUNK_SIZE;

    /* Allocate output buffer — worst case: header + per-chunk overhead + data */
    DWORD maxOut = 4 + chunkCount * (8 + NX_CHUNK_SIZE + 1024) + originalSize;
    BYTE *outBuf = (BYTE *)malloc(maxOut);
    if (!outBuf) { CloseHandle(hIn); *outCompSize = 0; return NULL; }

    DWORD outPos = 0;

    /* Write chunk count */
    memcpy(outBuf + outPos, &chunkCount, 4); outPos += 4;

    BYTE *srcBuf = (BYTE *)malloc(NX_CHUNK_SIZE);
    uLong compBound = compressBound((uLong)NX_CHUNK_SIZE);
    BYTE *compBuf = (BYTE *)malloc(compBound);

    DWORD remaining = originalSize;

    for (DWORD c = 0; c < chunkCount; c++) {
        DWORD chunkSize = (remaining > NX_CHUNK_SIZE) ? NX_CHUNK_SIZE : remaining;

        DWORD bytesRead;
        ReadFile(hIn, srcBuf, chunkSize, &bytesRead, NULL);

        uLongf compSize = compBound;
        int zret = compress2(compBuf, &compSize, srcBuf, (uLong)bytesRead, 9);

        if (zret != Z_OK || (DWORD)compSize >= bytesRead) {
            /* Store raw */
            DWORD rawMarker = bytesRead;
            memcpy(outBuf + outPos, &rawMarker, 4); outPos += 4;
            memcpy(outBuf + outPos, &bytesRead, 4); outPos += 4;
            memcpy(outBuf + outPos, srcBuf, bytesRead); outPos += bytesRead;
        } else {
            DWORD cs = (DWORD)compSize;
            memcpy(outBuf + outPos, &cs, 4); outPos += 4;
            memcpy(outBuf + outPos, &bytesRead, 4); outPos += 4;
            memcpy(outBuf + outPos, compBuf, cs); outPos += cs;
        }

        remaining -= bytesRead;
    }

    free(srcBuf);
    free(compBuf);
    CloseHandle(hIn);

    *outCompSize = outPos;
    return outBuf;
}

int main(int argc, char *argv[])
{
    (void)argc;
    (void)argv;

    int wargc = 0;
    LPWSTR *wargv = CommandLineToArgvW(GetCommandLineW(), &wargc);

    if (wargc < 4) {
        wprintf(L"\n");
        wprintf(L"  Nexia IDE Installer Packer (v3, incremental)\n");
        wprintf(L"  =============================================\n\n");
        wprintf(L"  Usage: install_pack.exe <installer.exe> <files_dir> <output.exe> [--raw]\n\n");
        if (wargv) LocalFree(wargv);
        return 1;
    }

    const WCHAR *installerExe = wargv[1];
    const WCHAR *filesDir = wargv[2];
    const WCHAR *outputExe = wargv[3];

    BOOL rawMode = FALSE;
    for (int a = 4; a < wargc; a++) {
        if (wcscmp(wargv[a], L"--raw") == 0) rawMode = TRUE;
    }

    if (rawMode) {
        wprintf(L"\n  Nexia IDE Installer Packer (FAST — no compression)\n\n");
    } else {
        wprintf(L"\n  Nexia IDE Installer Packer (v3, incremental)\n");
        wprintf(L"  =============================================\n\n");
    }

    /* ── Set up cache directory ── */
    WCHAR cacheDir[NXI_MAX_PATH];
    wsprintfW(cacheDir, L"%s\\..\\dist\\.build-cache\\blobs", filesDir);
    CreateDirectoryW(cacheDir, NULL);
    /* Also ensure parent exists */
    WCHAR cacheParent[NXI_MAX_PATH];
    wsprintfW(cacheParent, L"%s\\..\\dist\\.build-cache", filesDir);
    CreateDirectoryW(cacheParent, NULL);
    CreateDirectoryW(cacheDir, NULL);

    /* Step 1: Collect files */
    wprintf(L"  Scanning: %s\n", filesDir);

    FileCollector fc;
    ZeroMemory(&fc, sizeof(fc));
    wcsncpy(fc.baseDir, filesDir, NXI_MAX_PATH - 1);
    fc.baseDirLen = (int)wcslen(filesDir);

    sCollectFiles(&fc, filesDir);

    if (fc.count == 0) {
        wprintf(L"  ERROR: No files found in %s\n", filesDir);
        return 1;
    }

    DWORD totalUncompressed = 0;
    for (int i = 0; i < fc.count; i++)
        totalUncompressed += fc.entries[i].dataSize;

    wprintf(L"  Found %d files (%.1f MB uncompressed)\n\n",
            fc.count, totalUncompressed / (1024.0 * 1024.0));

    /* Step 2: Copy base installer */
    wprintf(L"  Copying base installer...\n");
    if (!CopyFileW(installerExe, outputExe, FALSE)) {
        wprintf(L"  ERROR: Could not copy %s to %s\n", installerExe, outputExe);
        return 1;
    }

    /* Step 3: Open output */
    HANDLE hOut = CreateFileW(outputExe, GENERIC_WRITE, 0, NULL,
                              OPEN_EXISTING, 0, NULL);
    if (hOut == INVALID_HANDLE_VALUE) {
        wprintf(L"  ERROR: Could not open %s for writing\n", outputExe);
        return 1;
    }

    DWORD exeSize = SetFilePointer(hOut, 0, NULL, FILE_END);
    DWORD payloadHeaderOffset = exeSize;

    wprintf(L"  Base EXE size: %u bytes\n\n", exeSize);

    /* Step 4: Write placeholder header + entry table */
    NxInsPayloadHeader header;
    ZeroMemory(&header, sizeof(header));
    header.magic = NXI_PAYLOAD_MAGIC;
    header.version = NXI_PAYLOAD_VERSION;
    header.fileCount = (DWORD)fc.count;

    DWORD written;
    WriteFile(hOut, &header, sizeof(header), &written, NULL);

    DWORD entryTablePos = SetFilePointer(hOut, 0, NULL, FILE_CURRENT);
    for (int i = 0; i < fc.count; i++) {
        WriteFile(hOut, &fc.entries[i], sizeof(NxInsFileEntry), &written, NULL);
    }

    /* Step 5: Pack each file */
    DWORD totalCompressed = 0;
    int cacheHits = 0, cacheMisses = 0;

    if (rawMode) {
        wprintf(L"  Packing %d files (no compression)...\n", fc.count);

        BYTE *copyBuf = (BYTE *)malloc(65536);
        for (int i = 0; i < fc.count; i++) {
            WCHAR fullPath[NXI_MAX_PATH];
            wsprintfW(fullPath, L"%s\\%s", filesDir, fc.entries[i].relativePath);

            fc.entries[i].dataOffset = totalCompressed;
            fc.entries[i].compressedSize = 0;

            HANDLE hIn = CreateFileW(fullPath, GENERIC_READ, FILE_SHARE_READ,
                                     NULL, OPEN_EXISTING, 0, NULL);
            if (hIn != INVALID_HANDLE_VALUE) {
                DWORD remaining = fc.entries[i].dataSize;
                while (remaining > 0) {
                    DWORD chunk = (remaining > 65536) ? 65536 : remaining;
                    DWORD bytesRead;
                    ReadFile(hIn, copyBuf, chunk, &bytesRead, NULL);
                    WriteFile(hOut, copyBuf, bytesRead, &written, NULL);
                    remaining -= bytesRead;
                    totalCompressed += bytesRead;
                }
                CloseHandle(hIn);
            }

            if ((i + 1) % 20 == 0 || i == fc.count - 1) {
                wprintf(L"    [%d/%d] %.1f MB packed\n",
                        i + 1, fc.count, totalCompressed / (1024.0 * 1024.0));
            }
        }
        free(copyBuf);
    } else {
        wprintf(L"  Compressing %d files (with cache)...\n", fc.count);

        for (int i = 0; i < fc.count; i++) {
            WCHAR fullPath[NXI_MAX_PATH];
            wsprintfW(fullPath, L"%s\\%s", filesDir, fc.entries[i].relativePath);

            fc.entries[i].dataOffset = totalCompressed;

            if (fc.entries[i].dataSize == 0) {
                fc.entries[i].compressedSize = 0;
                if ((i + 1) % 10 == 0 || i == fc.count - 1) goto progress;
                continue;
            }

            /* Try cache first */
            WCHAR cachePath[NXI_MAX_PATH];
            sCachePathForFile(cacheDir, fc.entries[i].relativePath, cachePath);

            DWORD cachedCompSize = 0;
            BYTE *cachedBlob = sLoadCachedBlob(cachePath, fc.entries[i].dataSize,
                                               fc.fileTimes[i], &cachedCompSize);

            if (cachedBlob) {
                /* Cache hit — write directly */
                WriteFile(hOut, cachedBlob, cachedCompSize, &written, NULL);
                fc.entries[i].compressedSize = cachedCompSize;
                totalCompressed += cachedCompSize;
                free(cachedBlob);
                cacheHits++;
            } else {
                /* Cache miss — compress and cache */
                DWORD compSize = 0;
                BYTE *compData = sCompressFile(fullPath, fc.entries[i].dataSize, &compSize);

                if (compData && compSize > 0) {
                    WriteFile(hOut, compData, compSize, &written, NULL);
                    fc.entries[i].compressedSize = compSize;
                    totalCompressed += compSize;

                    /* Save to cache */
                    sSaveCachedBlob(cachePath, fc.entries[i].dataSize,
                                   fc.fileTimes[i], compData, compSize);
                    free(compData);
                } else {
                    /* Compression failed — store raw */
                    wprintf(L"  WARNING: Failed to compress %s, storing raw\n",
                            fc.entries[i].relativePath);
                    HANDLE hIn = CreateFileW(fullPath, GENERIC_READ, FILE_SHARE_READ,
                                             NULL, OPEN_EXISTING, 0, NULL);
                    if (hIn != INVALID_HANDLE_VALUE) {
                        BYTE *buf = (BYTE *)malloc(65536);
                        DWORD remaining = fc.entries[i].dataSize;
                        while (remaining > 0) {
                            DWORD chunk = (remaining > 65536) ? 65536 : remaining;
                            DWORD bytesRead;
                            ReadFile(hIn, buf, chunk, &bytesRead, NULL);
                            WriteFile(hOut, buf, bytesRead, &written, NULL);
                            remaining -= bytesRead;
                        }
                        free(buf);
                        CloseHandle(hIn);
                    }
                    fc.entries[i].compressedSize = 0;
                    totalCompressed += fc.entries[i].dataSize;
                }
                cacheMisses++;
            }

progress:
            if ((i + 1) % 10 == 0 || i == fc.count - 1) {
                double ratio = totalUncompressed > 0
                    ? (1.0 - (double)totalCompressed / (double)totalUncompressed) * 100.0
                    : 0.0;
                wprintf(L"    [%d/%d] %.1f MB compressed (%.0f%% saved) [cache: %d hit, %d miss]\n",
                        i + 1, fc.count,
                        totalCompressed / (1024.0 * 1024.0), ratio,
                        cacheHits, cacheMisses);
            }
        }
    }

    /* Step 6: Rewrite header */
    header.totalSize = totalCompressed;
    SetFilePointer(hOut, payloadHeaderOffset, NULL, FILE_BEGIN);
    WriteFile(hOut, &header, sizeof(header), &written, NULL);

    SetFilePointer(hOut, entryTablePos, NULL, FILE_BEGIN);
    for (int i = 0; i < fc.count; i++) {
        WriteFile(hOut, &fc.entries[i], sizeof(NxInsFileEntry), &written, NULL);
    }

    SetFilePointer(hOut, 0, NULL, FILE_END);

    /* Step 7: Trailer */
    WriteFile(hOut, &payloadHeaderOffset, 4, &written, NULL);
    DWORD trailerMagic = NXI_TRAILER_MAGIC;
    WriteFile(hOut, &trailerMagic, 4, &written, NULL);

    DWORD finalSize = SetFilePointer(hOut, 0, NULL, FILE_CURRENT);

    CloseHandle(hOut);
    free(fc.entries);
    free(fc.fileSizes);
    free(fc.fileTimes);

    double ratio = totalUncompressed > 0
        ? (1.0 - (double)totalCompressed / (double)totalUncompressed) * 100.0
        : 0.0;

    wprintf(L"\n  Done!\n");
    wprintf(L"  Output:         %s\n", outputExe);
    wprintf(L"  Uncompressed:   %.1f MB (%d files)\n",
            totalUncompressed / (1024.0 * 1024.0), fc.count);
    wprintf(L"  Compressed:     %.1f MB (%.0f%% reduction)\n",
            totalCompressed / (1024.0 * 1024.0), ratio);
    wprintf(L"  Final size:     %.1f MB\n", finalSize / (1024.0 * 1024.0));
    if (!rawMode) {
        wprintf(L"  Cache:          %d hits, %d misses\n", cacheHits, cacheMisses);
    }
    wprintf(L"\n");

    LocalFree(wargv);
    return 0;
}
