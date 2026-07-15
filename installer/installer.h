/*
 * installer.h — Nexia IDE Installer
 *
 * Self-contained EXE installer for Nexia IDE. Pure C / Win32,
 * no NSIS, no WiX, no external frameworks.
 *
 * Features:
 *   - Nexia-branded dark theme wizard UI
 *   - Custom install path picker
 *   - License agreement screen
 *   - Animated progress bar
 *   - Start Menu + Desktop shortcuts
 *   - File associations (.vcxproj, .xex, .c, .cpp, .h)
 *   - Uninstaller registration (Add/Remove Programs)
 *   - Optional 7-Zip bundling
 *
 * The installer payload is a flat file table appended to the
 * end of this EXE. A builder tool (install_build.bat) packs
 * all Nexia files after the EXE with a manifest header.
 *
 * ═══════════════════════════════════════════════════════════════
 *  PAYLOAD FORMAT  (appended after PE image)
 * ═══════════════════════════════════════════════════════════════
 *
 *  [PE EXE image]
 *  [NxInsPayloadHeader]        — magic, version, file count, total size
 *  [NxInsFileEntry] × N        — relative path + offset + size per file
 *  [raw file data]             — concatenated file contents
 *  [4-byte magic trailer]      — 'NXIN' for quick validation
 *
 * ═══════════════════════════════════════════════════════════════
 */

#ifndef NEXIA_INSTALLER_H
#define NEXIA_INSTALLER_H

/* ── Windows targeting (Windows 2000+ for max compatibility) ── */
#ifndef WINVER
#define WINVER          0x0500
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT    0x0500
#endif
#ifndef _WIN32_IE
#define _WIN32_IE       0x0500
#endif

#ifndef CLEARTYPE_QUALITY
#define CLEARTYPE_QUALITY 5
#endif

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>
#include <commctrl.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ═══════════════════════════════════════════════════════════════
 *  Constants
 * ═══════════════════════════════════════════════════════════════ */

#define NXI_MAX_PATH            1024
#define NXI_APP_NAME            L"Nexia IDE"

/* NXI_APP_VERSION is generated from package.json by scripts/gen-version.js.
 * Do not hardcode it: this was a literal until v2.2.2, and it drifted to 2.1.0
 * while the payload was 2.2.2 — the wizard and Add/Remove Programs both lied. */
#if defined(__has_include)
#  if !__has_include("version_generated.h")
#    error "installer/version_generated.h missing - run: node scripts/gen-version.js"
#  endif
#endif
#include "version_generated.h"

#define NXI_APP_PUBLISHER       L"Nexia Project"
#define NXI_APP_EXE             L"NexiaIDE.exe"
#define NXI_UNINSTALLER_EXE     L"uninstall.exe"
#define NXI_REGISTRY_KEY        L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NexiaIDE"

/* The default install directory is resolved at runtime by
 * NxIns_GetDefaultInstallDir() -- it is %LOCALAPPDATA%\Programs\NexiaIDE, which
 * is per-user and writable without elevation, so updates need no UAC prompt.
 * It cannot be a literal: LOCALAPPDATA differs per user and per machine.
 *
 * This used to be L"C:\\Program Files\\NexiaIDE". Program Files is only
 * writable by an administrator, which is what forced every update through UAC.
 *
 * Old installs still live in Program Files and are migrated on upgrade, so
 * both locations must stay detectable. */
#define NXI_PERUSER_SUBDIR      L"Programs\\NexiaIDE"
#define NXI_LEGACY_INSTALL_DIR  L"C:\\Program Files\\NexiaIDE"

/* Fills out with %LOCALAPPDATA%\Programs\NexiaIDE. Returns FALSE if
 * LOCALAPPDATA cannot be resolved. */
BOOL NxIns_GetDefaultInstallDir(WCHAR *out, int maxLen);

#define NXI_PAYLOAD_MAGIC       0x4E58494E  /* 'NXIN' */
#define NXI_PAYLOAD_VERSION     2
#define NXI_TRAILER_MAGIC       0x4E58494E  /* 'NXIN' */

/* ── Wizard pages ── */
#define NXI_PAGE_WELCOME        0
#define NXI_PAGE_LICENSE        1
#define NXI_PAGE_DIRECTORY      2
#define NXI_PAGE_COMPONENTS     3
#define NXI_PAGE_INSTALLING     4
#define NXI_PAGE_COMPLETE       5
#define NXI_PAGE_COUNT          6

/* ── Component flags ── */
#define NXI_COMP_CORE           0x0001  /* IDE core files (always) */
#define NXI_COMP_SHORTCUTS      0x0002  /* Start Menu + Desktop shortcuts */
#define NXI_COMP_FILEASSOC      0x0004  /* File associations */
#define NXI_COMP_SDK_EXTRACT    0x0008  /* Extract Xbox 360 SDK from installer */

#define NXI_COMP_DEFAULT        (NXI_COMP_CORE | NXI_COMP_SHORTCUTS | NXI_COMP_FILEASSOC | NXI_COMP_SDK_EXTRACT)

/* ── Theme colors (exact match: Nexia IDE teal/dark theme) ── */
#define NXI_COL_BG_PRIMARY      RGB(24, 24, 24)      /* #181818 — deepest background */
#define NXI_COL_BG_SECONDARY    RGB(30, 30, 30)      /* #1e1e1e — main background */
#define NXI_COL_BG_PANEL        RGB(37, 37, 38)      /* #252526 — sidebar/panel bg */
#define NXI_COL_BG_INPUT        RGB(49, 49, 49)      /* #313131 — input fields */
#define NXI_COL_BG_ELEVATED     RGB(45, 45, 48)      /* #2d2d30 — elevated surfaces */
#define NXI_COL_BG_HOVER        RGB(42, 45, 46)      /* #2a2d2e — hover state */
#define NXI_COL_BG_BUTTON       RGB(78, 201, 176)    /* #4ec9b0 — primary button (teal) */
#define NXI_COL_BG_BUTTON_HOV   RGB(110, 231, 200)   /* #6ee7c8 — primary hover */
#define NXI_COL_BG_BUTTON_SEC   RGB(49, 49, 49)      /* #313131 — secondary button */
#define NXI_COL_BG_BUTTON_SEC_H RGB(55, 55, 61)      /* #37373d — secondary hover */
#define NXI_COL_BG_PROGRESS     RGB(78, 201, 176)    /* #4ec9b0 — progress fill */
#define NXI_COL_BG_PROGRESS_TRK RGB(49, 49, 49)      /* #313131 — progress track */

#define NXI_COL_FG_PRIMARY      RGB(204, 204, 204)   /* #cccccc — body text */
#define NXI_COL_FG_SECONDARY    RGB(133, 133, 133)   /* #858585 — dim text */
#define NXI_COL_FG_MUTED        RGB(90, 90, 90)      /* #5a5a5a — muted text */
#define NXI_COL_FG_BUTTON       RGB(30, 30, 30)      /* #1e1e1e — text on teal button */
#define NXI_COL_FG_TITLE        RGB(231, 231, 231)   /* #e7e7e7 — bright title text */
#define NXI_COL_FG_SUBTITLE     RGB(78, 201, 176)    /* #4ec9b0 — teal subtitle */

#define NXI_COL_ACCENT          RGB(78, 201, 176)    /* #4ec9b0 — Xbox green/teal */
#define NXI_COL_ACCENT_DIM      RGB(46, 138, 118)    /* #2e8a76 — dimmed teal */
#define NXI_COL_ACCENT_DARK     RGB(59, 165, 142)    /* #3ba58e — dark teal */
#define NXI_COL_ACCENT_GLOW     RGB(78, 201, 176)    /* for glow effects */
#define NXI_COL_SUCCESS         RGB(78, 201, 176)    /* #4ec9b0 — same as accent */
#define NXI_COL_ERROR           RGB(241, 76, 76)     /* #f14c4c — error red */
#define NXI_COL_BORDER          RGB(60, 60, 60)      /* #3c3c3c — borders */
#define NXI_COL_BORDER_LIGHT    RGB(71, 71, 71)      /* #474747 — light borders */
#define NXI_COL_CHECK           RGB(78, 201, 176)    /* #4ec9b0 — checkbox fill */

/* ── Window sizing (larger, more spacious) ── */
#define NXI_WINDOW_W            720
#define NXI_WINDOW_H            500
#define NXI_SIDEBAR_W           190
#define NXI_HEADER_H            72
#define NXI_FOOTER_H            56
#define NXI_CONTENT_PAD         32

/* ── Control IDs ── */
#define IDC_NXI_BACK            101
#define IDC_NXI_NEXT            102
#define IDC_NXI_CANCEL          103
#define IDC_NXI_BROWSE          104
#define IDC_NXI_PATH_EDIT       105
#define IDC_NXI_LICENSE_TEXT    106
#define IDC_NXI_LICENSE_ACCEPT  107
#define IDC_NXI_PROGRESS        108
#define IDC_NXI_STATUS_TEXT     109
#define IDC_NXI_COMP_SHORTCUTS  110
#define IDC_NXI_COMP_FILEASSOC  111
#define IDC_NXI_LAUNCH_CHECK    113
#define IDC_NXI_DESKTOP_CHECK   114

/* ═══════════════════════════════════════════════════════════════
 *  Payload structures (packed, written by builder)
 * ═══════════════════════════════════════════════════════════════ */

#pragma pack(push, 1)

typedef struct {
    DWORD   magic;          /* NXI_PAYLOAD_MAGIC */
    DWORD   version;        /* NXI_PAYLOAD_VERSION */
    DWORD   fileCount;      /* number of files */
    DWORD   totalSize;      /* total bytes of all file data */
    DWORD   reserved[4];    /* future use */
} NxInsPayloadHeader;

typedef struct {
    WCHAR   relativePath[260];  /* e.g. L"NexiaIDE.exe" or L"tools\\7z.exe" */
    DWORD   dataOffset;         /* offset from start of raw data block */
    DWORD   dataSize;           /* original uncompressed size in bytes */
    DWORD   attributes;         /* FILE_ATTRIBUTE_xxx (preserved on extract) */
    DWORD   compressedSize;     /* compressed size (0 = not compressed, stored raw) */
} NxInsFileEntry;

#pragma pack(pop)

/* ═══════════════════════════════════════════════════════════════
 *  Installer state
 * ═══════════════════════════════════════════════════════════════ */

typedef struct {
    /* Windows */
    HINSTANCE       hInstance;
    HWND            hwndMain;
    HWND            hwndSidebar;

    /* Fonts */
    HFONT           hFontTitle;     /* 20pt Segoe UI Semibold */
    HFONT           hFontSubtitle;  /* 11pt Segoe UI */
    HFONT           hFontBody;      /* 10pt Segoe UI */
    HFONT           hFontSmall;     /* 8pt Segoe UI */
    HFONT           hFontBold;      /* 10pt Segoe UI Bold */
    HFONT           hFontMono;      /* 9pt Consolas */

    /* GDI objects */
    HBRUSH          hbrBgPrimary;
    HBRUSH          hbrBgSecondary;
    HBRUSH          hbrBgPanel;
    HBRUSH          hbrBgInput;
    HBRUSH          hbrBgElevated;
    HBRUSH          hbrBgHover;
    HBRUSH          hbrBgButton;
    HBRUSH          hbrBgButtonSec;
    HBRUSH          hbrBgProgress;
    HBRUSH          hbrBgProgressTrack;
    HPEN            hpenBorder;
    HPEN            hpenBorderLight;
    HPEN            hpenAccent;
    HPEN            hpenAccentDim;

    /* Icon */
    HICON           hIconApp;
    HICON           hIconSmall;

    /* Wizard state */
    int             currentPage;
    BOOL            licenseAccepted;
    BOOL            launchAfter;
    BOOL            createDesktopShortcut;
    DWORD           components;     /* NXI_COMP_xxx flags */

    /* Paths */
    WCHAR           installDir[NXI_MAX_PATH];
    WCHAR           selfPath[NXI_MAX_PATH];  /* path to this installer EXE */

    /* Installation progress */
    BOOL            installing;
    BOOL            installSuccess;
    volatile BOOL   installCancelled;   /* written by UI thread, read by worker in tight loops */

    /* ── Silent / update mode (/S) ──
     * Set when the IDE's updater launches setup. Shows only a progress window,
     * never a prompt: the interactive "already installed" dialog offers
     * Yes = Uninstall, which during an update removed the IDE and exited,
     * leaving the user with nothing installed. An update must never be able to
     * uninstall the application. */
    BOOL            silent;
    BOOL            migrateLegacy;      /* an old Program Files install to retire after we succeed */
    WCHAR           legacyDir[NXI_MAX_PATH];
    volatile int    filesExtracted;     /* written by worker, read by UI */
    volatile int    filesToExtract;     /* written by worker, read by UI */
    WCHAR           statusText[512];

    /* Payload info (found at end of our own EXE) */
    BOOL            payloadFound;
    DWORD           payloadOffset;      /* offset in EXE to payload header */
    NxInsPayloadHeader payloadHeader;

    /* Install thread */
    HANDLE          hInstallThread;

    /* SDK installer auto-detection */
    BOOL            sdkInstallerFound;
    WCHAR           sdkInstallerPath[NXI_MAX_PATH];
    BOOL            extractSdk;         /* user chose to extract SDK */
    volatile int    sdkExtractPhase;    /* 0=scanning, 1=extracting cabs, 2=decompressing (worker writes, UI reads) */
    volatile int    sdkCabsTotal;       /* written by worker, read by UI */
    volatile int    sdkCabsDone;        /* written by worker, read by UI */
    int             sdkFilesExtracted;

    /* Pre-flight detection */
    BOOL            preflightDone;
    BOOL            systemSdkFound;         /* Xbox 360 SDK already installed on system */
    WCHAR           systemSdkPath[NXI_MAX_PATH];
    BOOL            vs2010Found;            /* Visual Studio 2010 detected */
    BOOL            vcRuntimeFound;         /* msvcr100.dll + msvcp100.dll already present */

} NxInstaller;

/* ── Global instance ── */
extern NxInstaller g_ins;

/* ═══════════════════════════════════════════════════════════════
 *  Functions
 * ═══════════════════════════════════════════════════════════════ */

/* ── Lifecycle ── */
BOOL    NxIns_Init(HINSTANCE hInstance);
void    NxIns_Shutdown(void);

/* ── Window ── */
BOOL    NxIns_CreateWindow(int nCmdShow);
void    NxIns_SetPage(int page);

/* ── Theme & Drawing ── */
void    NxIns_CreateFonts(void);
void    NxIns_CreateBrushes(void);
void    NxIns_DestroyGdi(void);
void    NxIns_DrawSidebar(HDC hdc, RECT *rc);
void    NxIns_DrawHeader(HDC hdc, RECT *rc, const WCHAR *title, const WCHAR *subtitle);
void    NxIns_DrawButton(HDC hdc, RECT *rc, const WCHAR *text, BOOL primary, BOOL hovered);

/* ── Pages ── */
void    NxIns_DrawPageWelcome(HDC hdc, RECT *content);
void    NxIns_DrawPageLicense(HDC hdc, RECT *content);
void    NxIns_DrawPageDirectory(HDC hdc, RECT *content);
void    NxIns_DrawPageComponents(HDC hdc, RECT *content);
void    NxIns_DrawPageInstalling(HDC hdc, RECT *content);
void    NxIns_DrawPageComplete(HDC hdc, RECT *content);

/* ── Payload ── */
BOOL    NxIns_FindPayload(void);
BOOL    NxIns_ExtractPayload(void);

/* ── Installation actions ── */
BOOL    NxIns_CopyFiles(void);
BOOL    NxIns_CreateShortcuts(void);
BOOL    NxIns_RegisterFileAssoc(void);
BOOL    NxIns_RegisterUninstaller(void);
BOOL    NxIns_Install7Zip(void);

/* ── SDK extraction (scans for and extracts Xbox 360 SDK installer) ── */
BOOL    NxIns_ScanForSdkInstaller(void);
BOOL    NxIns_ExtractSdk(void);

/* ── Install thread ── */
DWORD WINAPI NxIns_InstallThread(LPVOID param);

/* ── Uninstaller ── */
BOOL    NxIns_WriteUninstaller(void);
BOOL    NxIns_Uninstall(BOOL skipConfirm);

/* ── Utility ── */
void    NxIns_SetStatus(const WCHAR *fmt, ...);
void    NxIns_EnsureDir(const WCHAR *dir);
BOOL    NxIns_FileExists(const WCHAR *path);
BOOL    NxIns_BrowseForFolder(HWND hwndOwner, WCHAR *outPath, int maxLen);

#endif /* NEXIA_INSTALLER_H */
