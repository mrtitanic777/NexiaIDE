/*
 * installer.c — Nexia IDE Installer
 *
 * Fully custom, Nexia-branded dark-theme installer.
 * Pure C / Win32. No external frameworks.
 *
 * Build:  cl /nologo /O2 /MT /DUNICODE /D_UNICODE installer.c
 *         /Fe:NexiaSetup.exe /link /SUBSYSTEM:WINDOWS,5.00
 *         user32.lib gdi32.lib comctl32.lib shell32.lib
 *         shlwapi.lib ole32.lib advapi32.lib comdlg32.lib
 *         cabinet.lib
 *
 * The installer reads a payload appended to its own EXE image.
 * Use install_pack.c to build the final distributable.
 */

#include "installer.h"
#include <fdi.h>
#include <io.h>
#include <fcntl.h>
#include "nxcompress.h"

/* ═══════════════════════════════════════════════════════════════
 *  Globals
 * ═══════════════════════════════════════════════════════════════ */

NxInstaller g_ins;

static const WCHAR *sPageTitles[NXI_PAGE_COUNT] = {
    L"Welcome",
    L"License Agreement",
    L"Install Location",
    L"Components",
    L"Installing",
    L"Complete"
};

static const WCHAR *sPageSubtitles[NXI_PAGE_COUNT] = {
    L"Welcome to Nexia IDE Setup",
    L"Please review the license terms",
    L"Choose where to install Nexia IDE",
    L"Select optional components",
    L"Please wait while Nexia IDE is installed",
    L"Nexia IDE has been installed successfully"
};

/* ── Simple license text (embedded) ── */
static const char *sLicenseText =
    "NEXIA IDE - FREE SOFTWARE LICENSE\r\n"
    "=================================\r\n"
    "\r\n"
    "Nexia IDE is free software provided as-is for Xbox 360\r\n"
    "homebrew development.\r\n"
    "\r\n"
    "You may freely use, copy, and distribute Nexia IDE.\r\n"
    "\r\n"
    "This software is provided \"AS IS\" without warranty of\r\n"
    "any kind, express or implied. The authors shall not be\r\n"
    "liable for any damages arising from the use of this\r\n"
    "software.\r\n"
    "\r\n"
    "Nexia IDE is not affiliated with or endorsed by Microsoft\r\n"
    "Corporation. Xbox 360 is a trademark of Microsoft.\r\n"
    "\r\n"
    "By clicking \"I Accept\" you agree to these terms.\r\n";


/* ═══════════════════════════════════════════════════════════════
 *  Utility helpers
 * ═══════════════════════════════════════════════════════════════ */

void NxIns_EnsureDir(const WCHAR *dir)
{
    WCHAR tmp[NXI_MAX_PATH];
    wcsncpy(tmp, dir, NXI_MAX_PATH - 1);
    tmp[NXI_MAX_PATH - 1] = L'\0';

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

BOOL NxIns_FileExists(const WCHAR *path)
{
    DWORD attr = GetFileAttributesW(path);
    return (attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY));
}

void NxIns_SetStatus(const WCHAR *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    _vsnwprintf(g_ins.statusText, 511, fmt, args);
    va_end(args);
    g_ins.statusText[511] = L'\0';

    /* Trigger repaint of install page */
    if (g_ins.hwndMain)
        InvalidateRect(g_ins.hwndMain, NULL, FALSE);
}

BOOL NxIns_BrowseForFolder(HWND hwndOwner, WCHAR *outPath, int maxLen)
{
    (void)maxLen;
    BROWSEINFOW bi;
    ZeroMemory(&bi, sizeof(bi));
    bi.hwndOwner = hwndOwner;
    bi.lpszTitle = L"Select installation folder:";
    bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;

    PIDLIST_ABSOLUTE pidl = SHBrowseForFolderW(&bi);
    if (pidl) {
        SHGetPathFromIDListW(pidl, outPath);
        CoTaskMemFree(pidl);
        return TRUE;
    }
    return FALSE;
}


/* ═══════════════════════════════════════════════════════════════
 *  GDI Object Creation
 * ═══════════════════════════════════════════════════════════════ */

void NxIns_CreateFonts(void)
{
    HDC hdc = GetDC(NULL);
    int dpi = GetDeviceCaps(hdc, LOGPIXELSY);
    ReleaseDC(NULL, hdc);

    #define PT_TO_PX(pt) (-MulDiv((pt), dpi, 72))

    /* Title: light weight like IDE's h1 (font-weight: 300) */
    g_ins.hFontTitle = CreateFontW(
        PT_TO_PX(18), 0, 0, 0, FW_LIGHT, FALSE, FALSE, FALSE,
        DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");

    g_ins.hFontSubtitle = CreateFontW(
        PT_TO_PX(10), 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
        DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");

    g_ins.hFontBody = CreateFontW(
        PT_TO_PX(10), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
        DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");

    g_ins.hFontSmall = CreateFontW(
        PT_TO_PX(8), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
        DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");

    g_ins.hFontBold = CreateFontW(
        PT_TO_PX(10), 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
        DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");

    g_ins.hFontMono = CreateFontW(
        PT_TO_PX(9), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
        DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Cascadia Code");

    #undef PT_TO_PX
}

void NxIns_CreateBrushes(void)
{
    g_ins.hbrBgPrimary      = CreateSolidBrush(NXI_COL_BG_PRIMARY);
    g_ins.hbrBgSecondary    = CreateSolidBrush(NXI_COL_BG_SECONDARY);
    g_ins.hbrBgPanel        = CreateSolidBrush(NXI_COL_BG_PANEL);
    g_ins.hbrBgInput        = CreateSolidBrush(NXI_COL_BG_INPUT);
    g_ins.hbrBgElevated     = CreateSolidBrush(NXI_COL_BG_ELEVATED);
    g_ins.hbrBgHover        = CreateSolidBrush(NXI_COL_BG_HOVER);
    g_ins.hbrBgButton       = CreateSolidBrush(NXI_COL_BG_BUTTON);
    g_ins.hbrBgButtonSec    = CreateSolidBrush(NXI_COL_BG_BUTTON_SEC);
    g_ins.hbrBgProgress     = CreateSolidBrush(NXI_COL_BG_PROGRESS);
    g_ins.hbrBgProgressTrack = CreateSolidBrush(NXI_COL_BG_PROGRESS_TRK);
    g_ins.hpenBorder        = CreatePen(PS_SOLID, 1, NXI_COL_BORDER);
    g_ins.hpenBorderLight   = CreatePen(PS_SOLID, 1, NXI_COL_BORDER_LIGHT);
    g_ins.hpenAccent        = CreatePen(PS_SOLID, 2, NXI_COL_ACCENT);
    g_ins.hpenAccentDim     = CreatePen(PS_SOLID, 1, NXI_COL_ACCENT_DIM);
}

void NxIns_DestroyGdi(void)
{
    DeleteObject(g_ins.hFontTitle);
    DeleteObject(g_ins.hFontSubtitle);
    DeleteObject(g_ins.hFontBody);
    DeleteObject(g_ins.hFontSmall);
    DeleteObject(g_ins.hFontBold);
    DeleteObject(g_ins.hFontMono);

    DeleteObject(g_ins.hbrBgPrimary);
    DeleteObject(g_ins.hbrBgSecondary);
    DeleteObject(g_ins.hbrBgPanel);
    DeleteObject(g_ins.hbrBgInput);
    DeleteObject(g_ins.hbrBgElevated);
    DeleteObject(g_ins.hbrBgHover);
    DeleteObject(g_ins.hbrBgButton);
    DeleteObject(g_ins.hbrBgButtonSec);
    DeleteObject(g_ins.hbrBgProgress);
    DeleteObject(g_ins.hbrBgProgressTrack);
    DeleteObject(g_ins.hpenBorder);
    DeleteObject(g_ins.hpenBorderLight);
    DeleteObject(g_ins.hpenAccent);
    DeleteObject(g_ins.hpenAccentDim);
}


/* ═══════════════════════════════════════════════════════════════
 *  Drawing Helpers
 * ═══════════════════════════════════════════════════════════════ */

/* ── Draw the left sidebar with step indicators ── */
void NxIns_DrawSidebar(HDC hdc, RECT *rc)
{
    /* Deep dark sidebar background (like IDE activity bar) */
    FillRect(hdc, rc, g_ins.hbrBgPrimary);

    /* Right border line */
    HPEN oldPen = (HPEN)SelectObject(hdc, g_ins.hpenBorder);
    MoveToEx(hdc, rc->right - 1, rc->top, NULL);
    LineTo(hdc, rc->right - 1, rc->bottom);
    SelectObject(hdc, oldPen);

    SetBkMode(hdc, TRANSPARENT);

    /* ── Branding at top — IDE style ── */
    int brandX = rc->left + 20;
    int brandY = rc->top + 24;

    /* Teal accent bar at very top */
    HBRUSH accentBar = CreateSolidBrush(NXI_COL_ACCENT);
    RECT accentRc = { rc->left, rc->top, rc->left + 3, rc->top + 80 };
    FillRect(hdc, &accentRc, accentBar);
    DeleteObject(accentBar);

    HFONT oldFont = (HFONT)SelectObject(hdc, g_ins.hFontTitle);
    SetTextColor(hdc, NXI_COL_FG_TITLE);
    RECT titleRc = { brandX, brandY, rc->right - 10, brandY + 28 };
    DrawTextW(hdc, L"Nexia", -1, &titleRc, DT_LEFT | DT_SINGLELINE);

    SelectObject(hdc, g_ins.hFontSubtitle);
    SetTextColor(hdc, NXI_COL_ACCENT);
    RECT subtRc = { brandX, brandY + 28, rc->right - 10, brandY + 44 };
    DrawTextW(hdc, L"IDE SETUP", -1, &subtRc, DT_LEFT | DT_SINGLELINE);

    /* Thin separator under branding */
    HPEN sepPen = CreatePen(PS_SOLID, 1, RGB(50, 50, 52));
    HPEN opSep = (HPEN)SelectObject(hdc, sepPen);
    MoveToEx(hdc, brandX, brandY + 56, NULL);
    LineTo(hdc, rc->right - 16, brandY + 56);
    SelectObject(hdc, opSep);
    DeleteObject(sepPen);

    /* ── Step list ── */
    static const WCHAR *stepNames[] = {
        L"Welcome", L"License", L"Location", L"Components", L"Install", L"Finish"
    };

    int stepsTop = brandY + 72;
    int stepSpacing = 32;
    int stepY = stepsTop;
    int dotX = rc->left + 28;
    int dotR = 5;

    for (int i = 0; i < NXI_PAGE_COUNT; i++) {
        int cy = stepY + dotR;

        /* Connecting line (thin, subtle) */
        if (i < NXI_PAGE_COUNT - 1) {
            COLORREF lineCol = (i < g_ins.currentPage)
                ? NXI_COL_ACCENT_DIM : RGB(45, 45, 48);
            HPEN lp = CreatePen(PS_SOLID, 1, lineCol);
            HPEN olp = (HPEN)SelectObject(hdc, lp);
            MoveToEx(hdc, dotX, cy + dotR + 3, NULL);
            LineTo(hdc, dotX, stepY + stepSpacing - dotR + 1);
            SelectObject(hdc, olp);
            DeleteObject(lp);
        }

        /* Step dot — small, clean */
        COLORREF dotCol;
        if (i < g_ins.currentPage)
            dotCol = NXI_COL_ACCENT;
        else if (i == g_ins.currentPage)
            dotCol = NXI_COL_ACCENT;
        else
            dotCol = RGB(55, 55, 58);

        HBRUSH db = CreateSolidBrush(dotCol);
        HBRUSH oldBr = (HBRUSH)SelectObject(hdc, db);
        HPEN np = (HPEN)SelectObject(hdc, GetStockObject(NULL_PEN));

        if (i == g_ins.currentPage) {
            /* Active dot: slightly larger with a ring effect */
            Ellipse(hdc, dotX - dotR - 2, cy - dotR - 2,
                         dotX + dotR + 2, cy + dotR + 2);
        } else {
            Ellipse(hdc, dotX - dotR, cy - dotR, dotX + dotR, cy + dotR);
        }

        SelectObject(hdc, oldBr);
        SelectObject(hdc, np);
        DeleteObject(db);

        /* Checkmark for completed steps */
        if (i < g_ins.currentPage) {
            SetTextColor(hdc, NXI_COL_BG_PRIMARY);
            SelectObject(hdc, g_ins.hFontSmall);
            RECT chkRc = { dotX - dotR, cy - dotR - 1, dotX + dotR, cy + dotR - 1 };
            DrawTextW(hdc, L"\x2713", -1, &chkRc, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        }

        /* Step label */
        BOOL isCurrent = (i == g_ins.currentPage);
        BOOL isDone = (i < g_ins.currentPage);
        SelectObject(hdc, isCurrent ? g_ins.hFontBold : g_ins.hFontBody);
        SetTextColor(hdc, isCurrent ? NXI_COL_FG_TITLE :
                     (isDone ? NXI_COL_FG_PRIMARY : NXI_COL_FG_SECONDARY));

        RECT labelRc = { dotX + dotR + 12, cy - 7, rc->right - 8, cy + 9 };
        DrawTextW(hdc, stepNames[i], -1, &labelRc, DT_LEFT | DT_SINGLELINE);

        stepY += stepSpacing;
    }

    /* Version at bottom — muted */
    SelectObject(hdc, g_ins.hFontSmall);
    SetTextColor(hdc, NXI_COL_FG_MUTED);
    RECT verRc = { rc->left + 20, rc->bottom - 28, rc->right - 8, rc->bottom - 10 };
    DrawTextW(hdc, L"v" NXI_APP_VERSION, -1, &verRc, DT_LEFT | DT_SINGLELINE);

    SelectObject(hdc, oldFont);
}

/* ── Draw the header area of the content panel ── */
void NxIns_DrawHeader(HDC hdc, RECT *rc, const WCHAR *title, const WCHAR *subtitle)
{
    /* Header background — slightly elevated like IDE panel headers */
    RECT headerRc = { rc->left, rc->top, rc->right, rc->top + NXI_HEADER_H };
    FillRect(hdc, &headerRc, g_ins.hbrBgPanel);

    /* Bottom border — subtle */
    HPEN oldPen = (HPEN)SelectObject(hdc, g_ins.hpenBorder);
    MoveToEx(hdc, rc->left, rc->top + NXI_HEADER_H - 1, NULL);
    LineTo(hdc, rc->right, rc->top + NXI_HEADER_H - 1);
    SelectObject(hdc, oldPen);

    /* Teal accent underline (3px, left-aligned under title area) */
    int pad = NXI_CONTENT_PAD;
    HBRUSH accentBr = CreateSolidBrush(NXI_COL_ACCENT);
    RECT accentLine = { rc->left + pad, rc->top + NXI_HEADER_H - 3,
                        rc->left + pad + 40, rc->top + NXI_HEADER_H - 1 };
    FillRect(hdc, &accentLine, accentBr);
    DeleteObject(accentBr);

    SetBkMode(hdc, TRANSPARENT);

    /* Title */
    HFONT oldFont = (HFONT)SelectObject(hdc, g_ins.hFontTitle);
    SetTextColor(hdc, NXI_COL_FG_TITLE);
    RECT tRc = { rc->left + pad, rc->top + 12, rc->right - pad, rc->top + 40 };
    DrawTextW(hdc, title, -1, &tRc, DT_LEFT | DT_SINGLELINE | DT_VCENTER);

    /* Subtitle — dim, smaller */
    SelectObject(hdc, g_ins.hFontBody);
    SetTextColor(hdc, NXI_COL_FG_SECONDARY);
    RECT sRc = { rc->left + pad, rc->top + 42, rc->right - pad, rc->top + NXI_HEADER_H - 8 };
    DrawTextW(hdc, subtitle, -1, &sRc, DT_LEFT | DT_SINGLELINE);

    SelectObject(hdc, oldFont);
}

/* ── Draw a themed button (IDE-style) ── */
void NxIns_DrawButton(HDC hdc, RECT *rc, const WCHAR *text, BOOL primary, BOOL hovered)
{
    HBRUSH br;
    HPEN borderPen;

    if (primary) {
        br = CreateSolidBrush(hovered ? NXI_COL_BG_BUTTON_HOV : NXI_COL_BG_BUTTON);
        borderPen = CreatePen(PS_SOLID, 1, hovered ? NXI_COL_BG_BUTTON_HOV : NXI_COL_ACCENT);
    } else {
        br = CreateSolidBrush(hovered ? NXI_COL_BG_BUTTON_SEC_H : NXI_COL_BG_BUTTON_SEC);
        borderPen = CreatePen(PS_SOLID, 1, NXI_COL_BORDER);
    }

    HBRUSH oldBr = (HBRUSH)SelectObject(hdc, br);
    HPEN oldPen = (HPEN)SelectObject(hdc, borderPen);

    /* Rounded rectangle — matches IDE radius-sm (4px) */
    RoundRect(hdc, rc->left, rc->top, rc->right, rc->bottom, 8, 8);

    SelectObject(hdc, oldBr);
    SelectObject(hdc, oldPen);
    DeleteObject(br);
    DeleteObject(borderPen);

    /* Text — dark on teal for primary, light for secondary */
    SetBkMode(hdc, TRANSPARENT);
    HFONT oldFont = (HFONT)SelectObject(hdc, g_ins.hFontBold);
    SetTextColor(hdc, primary ? NXI_COL_FG_BUTTON : NXI_COL_FG_PRIMARY);
    DrawTextW(hdc, text, -1, rc, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    SelectObject(hdc, oldFont);
}

/* ── Draw a custom checkbox (IDE-style) ── */
static void sDrawCheckbox(HDC hdc, int x, int y, BOOL checked, const WCHAR *label)
{
    int boxSize = 16;

    /* Box — rounded, teal fill when checked */
    RECT boxRc = { x, y, x + boxSize, y + boxSize };
    HBRUSH bgBr = CreateSolidBrush(checked ? NXI_COL_ACCENT : NXI_COL_BG_INPUT);
    HPEN borderPen = CreatePen(PS_SOLID, 1, checked ? NXI_COL_ACCENT : NXI_COL_BORDER);

    HBRUSH oldBr = (HBRUSH)SelectObject(hdc, bgBr);
    HPEN oldPen = (HPEN)SelectObject(hdc, borderPen);
    RoundRect(hdc, boxRc.left, boxRc.top, boxRc.right, boxRc.bottom, 4, 4);
    SelectObject(hdc, oldBr);
    SelectObject(hdc, oldPen);
    DeleteObject(bgBr);
    DeleteObject(borderPen);

    /* Checkmark — dark on teal */
    if (checked) {
        SetTextColor(hdc, NXI_COL_BG_PRIMARY);
        SetBkMode(hdc, TRANSPARENT);
        HFONT oldFont = (HFONT)SelectObject(hdc, g_ins.hFontSmall);
        RECT chkRc = { x, y - 1, x + boxSize, y + boxSize - 1 };
        DrawTextW(hdc, L"\x2713", -1, &chkRc, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        SelectObject(hdc, oldFont);
    }

    /* Label */
    SetTextColor(hdc, NXI_COL_FG_PRIMARY);
    SetBkMode(hdc, TRANSPARENT);
    HFONT oldFont = (HFONT)SelectObject(hdc, g_ins.hFontBody);
    RECT labelRc = { x + boxSize + 10, y, x + 400, y + boxSize };
    DrawTextW(hdc, label, -1, &labelRc, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
    SelectObject(hdc, oldFont);
}

/* ── Draw a progress bar (IDE-style pill with teal fill) ── */
static void sDrawProgressBar(HDC hdc, RECT *rc, int percent)
{
    int radius = (rc->bottom - rc->top) / 2;
    if (radius < 4) radius = 4;

    /* Track — dark rounded pill */
    HBRUSH oldBr = (HBRUSH)SelectObject(hdc, g_ins.hbrBgProgressTrack);
    HPEN trkPen = CreatePen(PS_SOLID, 1, NXI_COL_BORDER);
    HPEN oldPen = (HPEN)SelectObject(hdc, trkPen);
    RoundRect(hdc, rc->left, rc->top, rc->right, rc->bottom, radius * 2, radius * 2);
    SelectObject(hdc, oldPen);
    DeleteObject(trkPen);

    /* Fill — teal */
    if (percent > 0) {
        int fillW = (int)((rc->right - rc->left) * percent / 100);
        if (fillW < radius * 2) fillW = radius * 2;
        SelectObject(hdc, g_ins.hbrBgProgress);
        HPEN np = (HPEN)SelectObject(hdc, GetStockObject(NULL_PEN));
        RoundRect(hdc, rc->left, rc->top, rc->left + fillW, rc->bottom, radius * 2, radius * 2);
        SelectObject(hdc, np);
    }

    SelectObject(hdc, oldBr);

    /* Percentage text — centered on bar */
    WCHAR pctText[16];
    wsprintfW(pctText, L"%d%%", percent);
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, percent > 45 ? NXI_COL_BG_PRIMARY : NXI_COL_FG_PRIMARY);
    HFONT oldFont = (HFONT)SelectObject(hdc, g_ins.hFontBold);
    DrawTextW(hdc, pctText, -1, rc, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    SelectObject(hdc, oldFont);
}


/* ═══════════════════════════════════════════════════════════════
 *  Page Drawing
 * ═══════════════════════════════════════════════════════════════ */

void NxIns_DrawPageWelcome(HDC hdc, RECT *content)
{
    SetBkMode(hdc, TRANSPARENT);
    int pad = NXI_CONTENT_PAD;
    int x = content->left + pad;
    int w = content->right - content->left - pad * 2;
    int y = content->top + NXI_HEADER_H + pad;

    HFONT oldFont = (HFONT)SelectObject(hdc, g_ins.hFontBody);
    SetTextColor(hdc, NXI_COL_FG_PRIMARY);

    RECT textRc = { x, y, x + w, y + 120 };
    DrawTextW(hdc,
        L"This wizard will install Nexia IDE on your computer.\r\n\r\n"
        L"Nexia IDE is a free development environment for Xbox 360 "
        L"homebrew development. It provides a complete toolchain "
        L"including compilation, XEX generation, devkit deployment, "
        L"and GOD package creation.\r\n\r\n"
        L"Click Next to continue.",
        -1, &textRc, DT_LEFT | DT_WORDBREAK);

    /* System requirements — card style */
    y += 140;

    /* Card background */
    RECT cardRc = { x, y, x + w, y + 100 };
    HBRUSH cardBr = CreateSolidBrush(NXI_COL_BG_PRIMARY);
    FillRect(hdc, &cardRc, cardBr);
    DeleteObject(cardBr);

    /* Card border */
    HPEN cardPen = CreatePen(PS_SOLID, 1, NXI_COL_BORDER);
    HPEN op = (HPEN)SelectObject(hdc, cardPen);
    HBRUSH obr = (HBRUSH)SelectObject(hdc, GetStockObject(NULL_BRUSH));
    RoundRect(hdc, cardRc.left, cardRc.top, cardRc.right, cardRc.bottom, 8, 8);
    SelectObject(hdc, obr);
    SelectObject(hdc, op);
    DeleteObject(cardPen);

    /* Card title */
    int cy = y + 10;
    SelectObject(hdc, g_ins.hFontBold);
    SetTextColor(hdc, NXI_COL_ACCENT);
    RECT reqTitle = { x + 14, cy, x + w - 14, cy + 18 };
    DrawTextW(hdc, L"System Requirements", -1, &reqTitle, DT_LEFT | DT_SINGLELINE);

    cy += 24;
    SelectObject(hdc, g_ins.hFontBody);
    SetTextColor(hdc, NXI_COL_FG_SECONDARY);
    RECT reqRc = { x + 14, cy, x + w - 14, cy + 60 };
    DrawTextW(hdc,
        L"\x2022  Windows 7 SP1 or later (x64)\r\n"
        L"\x2022  700 MB free disk space\r\n"
        L"\x2022  Xbox 360 SDK (detected automatically)",
        -1, &reqRc, DT_LEFT | DT_WORDBREAK);

    SelectObject(hdc, oldFont);
}

void NxIns_DrawPageLicense(HDC hdc, RECT *content)
{
    int y = content->top + NXI_HEADER_H + NXI_CONTENT_PAD;
    int x = content->left + NXI_CONTENT_PAD;
    int w = content->right - content->left - NXI_CONTENT_PAD * 2;

    /* License text area (dark inset) */
    RECT licRc = { x, y, x + w, y + 200 };
    FillRect(hdc, &licRc, g_ins.hbrBgInput);

    /* Border around license area */
    HPEN oldPen = (HPEN)SelectObject(hdc, g_ins.hpenBorder);
    HBRUSH oldBr = (HBRUSH)SelectObject(hdc, GetStockObject(NULL_BRUSH));
    Rectangle(hdc, licRc.left, licRc.top, licRc.right, licRc.bottom);
    SelectObject(hdc, oldBr);
    SelectObject(hdc, oldPen);

    /* Draw license text */
    SetBkMode(hdc, TRANSPARENT);
    HFONT oldFont = (HFONT)SelectObject(hdc, g_ins.hFontMono);
    SetTextColor(hdc, NXI_COL_FG_PRIMARY);

    RECT textRc = { licRc.left + 12, licRc.top + 8, licRc.right - 12, licRc.bottom - 8 };
    /* Convert ANSI license to wide */
    WCHAR licWide[2048];
    MultiByteToWideChar(CP_ACP, 0, sLicenseText, -1, licWide, 2048);
    DrawTextW(hdc, licWide, -1, &textRc, DT_LEFT | DT_WORDBREAK);

    /* Accept checkbox */
    y += 216;
    sDrawCheckbox(hdc, x, y, g_ins.licenseAccepted, L"I accept the license agreement");

    SelectObject(hdc, oldFont);
}

void NxIns_DrawPageDirectory(HDC hdc, RECT *content)
{
    SetBkMode(hdc, TRANSPARENT);
    int y = content->top + NXI_HEADER_H + NXI_CONTENT_PAD;
    int x = content->left + NXI_CONTENT_PAD;
    int w = content->right - content->left - NXI_CONTENT_PAD * 2;

    /* Description */
    HFONT oldFont = (HFONT)SelectObject(hdc, g_ins.hFontBody);
    SetTextColor(hdc, NXI_COL_FG_PRIMARY);
    RECT descRc = { x, y, x + w, y + 40 };
    DrawTextW(hdc,
        L"Nexia IDE will be installed to the following folder. "
        L"Click Browse to choose a different location.",
        -1, &descRc, DT_LEFT | DT_WORDBREAK);

    /* Path label */
    y += 52;
    SelectObject(hdc, g_ins.hFontBold);
    SetTextColor(hdc, NXI_COL_FG_SECONDARY);
    RECT labelRc = { x, y, x + w, y + 18 };
    DrawTextW(hdc, L"Destination Folder:", -1, &labelRc, DT_LEFT | DT_SINGLELINE);

    /* Path display box */
    y += 22;
    int btnW = 80;
    RECT pathRc = { x, y, x + w - btnW - 8, y + 28 };
    FillRect(hdc, &pathRc, g_ins.hbrBgInput);

    HPEN oldPen = (HPEN)SelectObject(hdc, g_ins.hpenBorder);
    HBRUSH oldBr = (HBRUSH)SelectObject(hdc, GetStockObject(NULL_BRUSH));
    Rectangle(hdc, pathRc.left, pathRc.top, pathRc.right, pathRc.bottom);
    SelectObject(hdc, oldBr);
    SelectObject(hdc, oldPen);

    /* Path text */
    SelectObject(hdc, g_ins.hFontMono);
    SetTextColor(hdc, NXI_COL_FG_PRIMARY);
    RECT pathTextRc = { pathRc.left + 8, pathRc.top + 2, pathRc.right - 4, pathRc.bottom - 2 };
    DrawTextW(hdc, g_ins.installDir, -1, &pathTextRc,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_PATH_ELLIPSIS);

    /* Browse button */
    RECT browseRc = { x + w - btnW, y, x + w, y + 28 };
    NxIns_DrawButton(hdc, &browseRc, L"Browse...", FALSE, FALSE);

    /* Space required info */
    y += 48;
    SelectObject(hdc, g_ins.hFontBody);
    SetTextColor(hdc, NXI_COL_FG_SECONDARY);
    RECT spaceRc = { x, y, x + w, y + 20 };
    DrawTextW(hdc, L"Space required: ~700 MB", -1, &spaceRc, DT_LEFT | DT_SINGLELINE);

    /* Disk space available */
    ULARGE_INTEGER freeBytes;
    if (GetDiskFreeSpaceExW(g_ins.installDir, &freeBytes, NULL, NULL)) {
        WCHAR freeBuf[64];
        wsprintfW(freeBuf, L"Space available: %u MB",
                  (DWORD)(freeBytes.QuadPart / (1024 * 1024)));
        RECT freeRc = { x, y + 18, x + w, y + 38 };
        DrawTextW(hdc, freeBuf, -1, &freeRc, DT_LEFT | DT_SINGLELINE);
    }

    SelectObject(hdc, oldFont);
}

void NxIns_DrawPageComponents(HDC hdc, RECT *content)
{
    SetBkMode(hdc, TRANSPARENT);
    int pad = NXI_CONTENT_PAD;
    int x = content->left + pad;
    int w = content->right - content->left - pad * 2;
    int y = content->top + NXI_HEADER_H + pad;

    HFONT oldFont = (HFONT)SelectObject(hdc, g_ins.hFontBody);
    SetTextColor(hdc, NXI_COL_FG_PRIMARY);
    RECT descRc = { x, y, x + w, y + 18 };
    DrawTextW(hdc, L"Select the components to install:", -1, &descRc, DT_LEFT | DT_SINGLELINE);

    y += 32;
    int checkSpacing = 28;

    sDrawCheckbox(hdc, x, y, TRUE, L"Nexia IDE Core Files (required)");

    y += checkSpacing;
    sDrawCheckbox(hdc, x, y, (g_ins.components & NXI_COMP_SHORTCUTS) != 0,
                  L"Start Menu && Desktop Shortcuts");

    y += checkSpacing;
    sDrawCheckbox(hdc, x, y, (g_ins.components & NXI_COMP_FILEASSOC) != 0,
                  L"File Associations (.vcxproj, .c, .cpp, .h)");

    /* SDK extraction option — only show if the SDK installer was found
     * AND the SDK is NOT already installed on the system.  If the system
     * SDK is present the IDE will detect it automatically. */
    if (g_ins.sdkInstallerFound && !g_ins.systemSdkFound) {
        y += checkSpacing;
        sDrawCheckbox(hdc, x, y, (g_ins.components & NXI_COMP_SDK_EXTRACT) != 0,
                      L"Extract Xbox 360 SDK (from bundled installer)");

        y += 20;
        SelectObject(hdc, g_ins.hFontSmall);
        SetTextColor(hdc, RGB(100, 100, 105));
        RECT sdkRc = { x + 26, y, x + w, y + 32 };
        WCHAR sdkNote[512];
        wsprintfW(sdkNote, L"Found: %s", g_ins.sdkInstallerPath);
        DrawTextW(hdc, sdkNote, -1, &sdkRc, DT_LEFT | DT_WORDBREAK | DT_PATH_ELLIPSIS);
    }

    /* ── System detection results ── */
    y += (g_ins.sdkInstallerFound && !g_ins.systemSdkFound) ? 44 : 36;
    HPEN hp = CreatePen(PS_SOLID, 1, NXI_COL_BORDER);
    HPEN op = (HPEN)SelectObject(hdc, hp);
    MoveToEx(hdc, x, y, NULL);
    LineTo(hdc, x + w, y);
    SelectObject(hdc, op);
    DeleteObject(hp);

    y += 10;
    SelectObject(hdc, g_ins.hFontSmall);
    SetTextColor(hdc, NXI_COL_FG_SECONDARY);
    RECT detLabel = { x, y, x + w, y + 16 };
    DrawTextW(hdc, L"System Detection:", -1, &detLabel, DT_LEFT | DT_SINGLELINE);
    y += 20;

    /* Xbox 360 SDK */
    if (g_ins.systemSdkFound) {
        SetTextColor(hdc, NXI_COL_SUCCESS);
        RECT r = { x + 8, y, x + w, y + 16 };
        DrawTextW(hdc, L"\x2713  Xbox 360 SDK installed", -1, &r, DT_LEFT | DT_SINGLELINE);
        y += 16;
        SetTextColor(hdc, RGB(100, 100, 105));
        RECT p = { x + 22, y, x + w, y + 14 };
        DrawTextW(hdc, g_ins.systemSdkPath, -1, &p, DT_LEFT | DT_SINGLELINE | DT_PATH_ELLIPSIS);
    } else {
        SetTextColor(hdc, NXI_COL_FG_MUTED);
        RECT r = { x + 8, y, x + w, y + 16 };
        DrawTextW(hdc, L"\x2013  Xbox 360 SDK not found (will extract from installer)", -1, &r, DT_LEFT | DT_SINGLELINE);
    }
    y += 20;

    /* Visual Studio 2010 */
    if (g_ins.vs2010Found) {
        SetTextColor(hdc, NXI_COL_SUCCESS);
        RECT r = { x + 8, y, x + w, y + 16 };
        DrawTextW(hdc, L"\x2713  Visual Studio 2010 detected", -1, &r, DT_LEFT | DT_SINGLELINE);
    } else {
        SetTextColor(hdc, NXI_COL_FG_MUTED);
        RECT r = { x + 8, y, x + w, y + 16 };
        DrawTextW(hdc, L"\x2013  Visual Studio 2010 not found (not required)", -1, &r, DT_LEFT | DT_SINGLELINE);
    }
    y += 20;

    /* VC++ 2010 Runtime */
    if (g_ins.vcRuntimeFound) {
        SetTextColor(hdc, NXI_COL_SUCCESS);
        RECT r = { x + 8, y, x + w, y + 16 };
        DrawTextW(hdc, L"\x2713  VC++ 2010 runtime present (skipping install)", -1, &r, DT_LEFT | DT_SINGLELINE);
    } else {
        SetTextColor(hdc, NXI_COL_FG_MUTED);
        RECT r = { x + 8, y, x + w, y + 16 };
        DrawTextW(hdc, L"\x2013  VC++ 2010 runtime not found (will install)", -1, &r, DT_LEFT | DT_SINGLELINE);
    }

    SelectObject(hdc, oldFont);
}

void NxIns_DrawPageInstalling(HDC hdc, RECT *content)
{
    SetBkMode(hdc, TRANSPARENT);
    int pad = NXI_CONTENT_PAD;
    int x = content->left + pad;
    int w = content->right - content->left - pad * 2;
    int areaTop = content->top + NXI_HEADER_H + pad;
    int areaBot = content->bottom - pad;
    int areaH = areaBot - areaTop;

    /* Calculate overall progress */
    int percent = 0;
    if (g_ins.sdkExtractPhase > 0 && g_ins.sdkCabsTotal > 0) {
        int payloadPct = (g_ins.filesToExtract > 0) ?
            (g_ins.filesExtracted * 100 / g_ins.filesToExtract) : 100;
        int sdkPct = (g_ins.sdkCabsDone * 100) / g_ins.sdkCabsTotal;
        percent = (payloadPct * 10 + sdkPct * 90) / 100;
    } else if (g_ins.filesToExtract > 0) {
        percent = (g_ins.filesExtracted * 100) / g_ins.filesToExtract;
    }
    if (percent > 100) percent = 100;

    /* Center the progress block vertically: bar + status + count = ~80px */
    int blockH = 90;
    int blockY = areaTop + (areaH - blockH) / 3;  /* 1/3 from top looks better than centered */

    /* Progress bar */
    int barH = 22;
    RECT progRc = { x, blockY, x + w, blockY + barH };
    sDrawProgressBar(hdc, &progRc, percent);

    /* Status text — below bar */
    int statusY = blockY + barH + 14;
    HFONT oldFont = (HFONT)SelectObject(hdc, g_ins.hFontBody);
    SetTextColor(hdc, NXI_COL_FG_SECONDARY);
    RECT statRc = { x, statusY, x + w, statusY + 36 };
    DrawTextW(hdc, g_ins.statusText, -1, &statRc,
              DT_LEFT | DT_WORDBREAK | DT_PATH_ELLIPSIS);

    /* File count */
    int countY = statusY + 40;
    WCHAR countBuf[256];
    SetTextColor(hdc, RGB(100, 100, 105));
    if (g_ins.sdkExtractPhase >= 2 && g_ins.sdkCabsTotal > 0) {
        wsprintfW(countBuf, L"IDE Files: %d / %d   \x2022   SDK Archives: %d / %d",
                  g_ins.filesExtracted, g_ins.filesToExtract,
                  g_ins.sdkCabsDone, g_ins.sdkCabsTotal);
    } else if (g_ins.sdkExtractPhase == 1) {
        wsprintfW(countBuf, L"IDE Files: %d / %d   \x2022   Scanning SDK...",
                  g_ins.filesExtracted, g_ins.filesToExtract);
    } else {
        wsprintfW(countBuf, L"Files: %d / %d", g_ins.filesExtracted, g_ins.filesToExtract);
    }
    SelectObject(hdc, g_ins.hFontSmall);
    RECT countRc = { x, countY, x + w, countY + 16 };
    DrawTextW(hdc, countBuf, -1, &countRc, DT_LEFT | DT_SINGLELINE);

    SelectObject(hdc, oldFont);
}

void NxIns_DrawPageComplete(HDC hdc, RECT *content)
{
    SetBkMode(hdc, TRANSPARENT);
    int pad = NXI_CONTENT_PAD;
    int x = content->left + pad;
    int w = content->right - content->left - pad * 2;
    int areaTop = content->top + NXI_HEADER_H + pad;

    /* Success/error indicator — larger, centered on line */
    HFONT oldFont = (HFONT)SelectObject(hdc, g_ins.hFontTitle);
    int y = areaTop + 10;

    if (g_ins.installSuccess) {
        /* Teal check + text on same baseline */
        SetTextColor(hdc, NXI_COL_SUCCESS);
        RECT chkRc = { x, y, x + 32, y + 32 };
        DrawTextW(hdc, L"\x2713", -1, &chkRc, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

        SetTextColor(hdc, NXI_COL_FG_PRIMARY);
        RECT msgRc = { x + 38, y + 2, x + w, y + 32 };
        DrawTextW(hdc, L"Installation Complete!", -1, &msgRc, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
    } else {
        SetTextColor(hdc, NXI_COL_ERROR);
        RECT chkRc = { x, y, x + 32, y + 32 };
        DrawTextW(hdc, L"\x2717", -1, &chkRc, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

        SetTextColor(hdc, NXI_COL_FG_PRIMARY);
        RECT msgRc = { x + 38, y + 2, x + w, y + 32 };
        DrawTextW(hdc, L"Installation Failed", -1, &msgRc, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
    }

    /* Details */
    y += 48;
    SelectObject(hdc, g_ins.hFontBody);
    SetTextColor(hdc, NXI_COL_FG_SECONDARY);

    if (g_ins.installSuccess) {
        RECT detRc = { x, y, x + w, y + 100 };
        WCHAR detBuf[1024];
        if (g_ins.systemSdkFound) {
            wsprintfW(detBuf,
                L"Nexia IDE has been installed to:\r\n%s\r\n\r\n"
                L"%d files installed. Using system Xbox 360 SDK.",
                g_ins.installDir, g_ins.filesExtracted);
        } else if (g_ins.sdkInstallerFound && (g_ins.components & NXI_COMP_SDK_EXTRACT)) {
            wsprintfW(detBuf,
                L"Nexia IDE has been installed to:\r\n%s\r\n\r\n"
                L"%d files installed. Xbox 360 SDK extracted.",
                g_ins.installDir, g_ins.filesExtracted);
        } else {
            wsprintfW(detBuf,
                L"Nexia IDE has been installed to:\r\n%s\r\n\r\n"
                L"%d files were installed successfully.",
                g_ins.installDir, g_ins.filesExtracted);
        }
        DrawTextW(hdc, detBuf, -1, &detRc, DT_LEFT | DT_WORDBREAK);

        /* Launch checkbox */
        y += 110;
        sDrawCheckbox(hdc, x, y, g_ins.launchAfter, L"Launch Nexia IDE now");
    } else {
        RECT detRc = { x, y, x + w, y + 80 };
        DrawTextW(hdc, g_ins.statusText, -1, &detRc, DT_LEFT | DT_WORDBREAK);
    }

    SelectObject(hdc, oldFont);
}


/* ═══════════════════════════════════════════════════════════════
 *  Footer Buttons
 * ═══════════════════════════════════════════════════════════════ */

static void sDrawFooter(HDC hdc, RECT *footer)
{
    /* Footer background — elevated surface */
    FillRect(hdc, footer, g_ins.hbrBgPanel);

    /* Top border */
    HPEN oldPen = (HPEN)SelectObject(hdc, g_ins.hpenBorder);
    MoveToEx(hdc, footer->left, footer->top, NULL);
    LineTo(hdc, footer->right, footer->top);
    SelectObject(hdc, oldPen);

    int page = g_ins.currentPage;
    int pad = NXI_CONTENT_PAD;
    int btnW = 96, btnH = 32;
    int btnY = footer->top + (NXI_FOOTER_H - btnH) / 2;
    int rightEdge = footer->right - pad;

    /* Next/Install/Finish button (always shown, right-most) */
    const WCHAR *nextText;
    if (page == NXI_PAGE_COMPLETE)       nextText = L"Finish";
    else if (page == NXI_PAGE_COMPONENTS) nextText = L"Install";
    else                                  nextText = L"Next \x203A";

    BOOL nextEnabled = TRUE;
    if (page == NXI_PAGE_LICENSE && !g_ins.licenseAccepted) nextEnabled = FALSE;
    if (page == NXI_PAGE_INSTALLING) nextEnabled = FALSE;

    RECT nextRc = { rightEdge - btnW, btnY, rightEdge, btnY + btnH };
    NxIns_DrawButton(hdc, &nextRc, nextText, nextEnabled, FALSE);

    /* Back button (shown on pages 1-3, left of Next) */
    if (page > NXI_PAGE_WELCOME && page < NXI_PAGE_INSTALLING) {
        RECT backRc = { rightEdge - btnW - 10 - btnW, btnY, rightEdge - btnW - 10, btnY + btnH };
        NxIns_DrawButton(hdc, &backRc, L"\x2039 Back", FALSE, FALSE);
    }
}


/* ═══════════════════════════════════════════════════════════════
 *  Payload Detection & Extraction
 * ═══════════════════════════════════════════════════════════════ */

BOOL NxIns_FindPayload(void)
{
    /*
     * The payload is appended after the PE image.
     * We find it by reading from the end of our own EXE:
     *   - Last 4 bytes = trailer magic (NXI_TRAILER_MAGIC)
     *   - Before that = NxInsPayloadHeader
     *   - Before that = NxInsFileEntry array
     *   - Before that = raw file data
     *
     * Alternatively, we use the PE header to find the end of
     * the image and look for the payload header right after.
     */

    HANDLE hFile = CreateFileW(g_ins.selfPath, GENERIC_READ, FILE_SHARE_READ,
                               NULL, OPEN_EXISTING, 0, NULL);
    if (hFile == INVALID_HANDLE_VALUE) return FALSE;

    DWORD fileSize = GetFileSize(hFile, NULL);
    if (fileSize < sizeof(NxInsPayloadHeader) + 4) {
        CloseHandle(hFile);
        return FALSE;
    }

    /* Check trailer magic at end of file */
    DWORD trailer = 0;
    SetFilePointer(hFile, fileSize - 4, NULL, FILE_BEGIN);
    DWORD bytesRead;
    ReadFile(hFile, &trailer, 4, &bytesRead, NULL);

    if (trailer != NXI_TRAILER_MAGIC) {
        CloseHandle(hFile);
        return FALSE;
    }

    /* Read payload header (just before trailer and file data) */
    /* The layout is: [PE] [PayloadHeader] [FileEntries...] [FileData...] [Trailer] */
    /* We need to find the PayloadHeader. Search backwards from the trailer. */

    /* Strategy: the header is at a known offset stored just before the trailer */
    /* Actually, let's use a simpler approach: store the offset to the header
       in the 4 bytes before the trailer magic */
    DWORD headerOffset = 0;
    SetFilePointer(hFile, fileSize - 8, NULL, FILE_BEGIN);
    ReadFile(hFile, &headerOffset, 4, &bytesRead, NULL);

    if (headerOffset >= fileSize) {
        CloseHandle(hFile);
        return FALSE;
    }

    /* Read the payload header */
    SetFilePointer(hFile, headerOffset, NULL, FILE_BEGIN);
    ReadFile(hFile, &g_ins.payloadHeader, sizeof(NxInsPayloadHeader), &bytesRead, NULL);

    if (g_ins.payloadHeader.magic != NXI_PAYLOAD_MAGIC ||
        g_ins.payloadHeader.version != NXI_PAYLOAD_VERSION) {
        CloseHandle(hFile);
        return FALSE;
    }

    g_ins.payloadOffset = headerOffset;
    g_ins.payloadFound = TRUE;
    g_ins.filesToExtract = (int)g_ins.payloadHeader.fileCount;

    CloseHandle(hFile);
    return TRUE;
}

/* ── Reject unsafe extraction paths (path traversal / absolute paths) ──
 * Returns TRUE if the relative path is safe to extract. Rejects:
 *   - empty paths
 *   - absolute paths (leading '\' or '/', or drive-letter "X:")
 *   - any path containing a ".." component
 */
static BOOL sNxIns_IsPathSafe(const WCHAR *relPath)
{
    if (!relPath || relPath[0] == L'\0')
        return FALSE;

    /* Absolute path: leading separator */
    if (relPath[0] == L'\\' || relPath[0] == L'/')
        return FALSE;

    /* Absolute path: drive letter "X:" */
    if (((relPath[0] >= L'A' && relPath[0] <= L'Z') ||
         (relPath[0] >= L'a' && relPath[0] <= L'z')) &&
        relPath[1] == L':')
        return FALSE;

    /* Scan for ".." path components (bounded by separators or string ends) */
    {
        const WCHAR *p = relPath;
        while (*p) {
            /* Are we at the start of a component? (begin of string or after a separator) */
            BOOL atCompStart = (p == relPath) || (p[-1] == L'\\') || (p[-1] == L'/');
            if (atCompStart && p[0] == L'.' && p[1] == L'.' &&
                (p[2] == L'\\' || p[2] == L'/' || p[2] == L'\0'))
                return FALSE;
            p++;
        }
    }

    return TRUE;
}

BOOL NxIns_ExtractPayload(void)
{
    if (!g_ins.payloadFound) return FALSE;

    HANDLE hFile = CreateFileW(g_ins.selfPath, GENERIC_READ, FILE_SHARE_READ,
                               NULL, OPEN_EXISTING, 0, NULL);
    if (hFile == INVALID_HANDLE_VALUE) return FALSE;

    DWORD bytesRead;
    DWORD fileCount = g_ins.payloadHeader.fileCount;

    /* Sanity-bound fileCount to defend against a corrupt/hostile payload:
     * reject absurd counts and any value whose entry-table size would
     * overflow a 32-bit DWORD or exceed the actual EXE size. */
    {
        DWORD fileSizeHigh = 0;
        DWORD fileSizeLow = GetFileSize(hFile, &fileSizeHigh);
        ULONGLONG totalFileSize = ((ULONGLONG)fileSizeHigh << 32) | fileSizeLow;

        if (fileCount == 0 || fileCount > 1000000) {
            NxIns_SetStatus(L"Error: payload file count out of range.");
            CloseHandle(hFile);
            return FALSE;
        }
        /* fileCount * sizeof(NxInsFileEntry) must not overflow DWORD */
        if (fileCount > (0xFFFFFFFFu / sizeof(NxInsFileEntry))) {
            NxIns_SetStatus(L"Error: payload entry table too large.");
            CloseHandle(hFile);
            return FALSE;
        }
        /* Entry table must fit within the file. */
        if ((ULONGLONG)g_ins.payloadOffset + sizeof(NxInsPayloadHeader) +
            (ULONGLONG)fileCount * sizeof(NxInsFileEntry) > totalFileSize) {
            NxIns_SetStatus(L"Error: payload entry table exceeds file size.");
            CloseHandle(hFile);
            return FALSE;
        }
    }

    /* Seek past the payload header to the file entry table */
    DWORD entryTableOffset = g_ins.payloadOffset + sizeof(NxInsPayloadHeader);
    DWORD dataBlockOffset = entryTableOffset + (fileCount * sizeof(NxInsFileEntry));

    /* Read all file entries */
    NxInsFileEntry *entries = (NxInsFileEntry *)calloc(fileCount, sizeof(NxInsFileEntry));
    if (!entries) { CloseHandle(hFile); return FALSE; }

    SetFilePointer(hFile, entryTableOffset, NULL, FILE_BEGIN);
    ReadFile(hFile, entries, fileCount * sizeof(NxInsFileEntry), &bytesRead, NULL);

    /* Ensure install directory exists */
    NxIns_EnsureDir(g_ins.installDir);

    /* Extract each file */
    BYTE *copyBuf = (BYTE *)malloc(65536);
    if (!copyBuf) { free(entries); CloseHandle(hFile); return FALSE; }

    for (DWORD i = 0; i < fileCount; i++) {
        if (g_ins.installCancelled) break;

        NxInsFileEntry *fe = &entries[i];

        /* Defend against path traversal: ensure the relative path is bounded
         * (NUL-terminated) and contains no ".." / absolute components, else
         * skip this entry with a logged warning. */
        fe->relativePath[259] = L'\0';
        if (!sNxIns_IsPathSafe(fe->relativePath)) {
            NxIns_SetStatus(L"Warning: skipping unsafe path: %s", fe->relativePath);
            continue;
        }

        /* Build full output path */
        WCHAR outPath[NXI_MAX_PATH];
        wsprintfW(outPath, L"%s\\%s", g_ins.installDir, fe->relativePath);

        /* Ensure parent directory */
        WCHAR parentDir[NXI_MAX_PATH];
        wcsncpy(parentDir, outPath, NXI_MAX_PATH - 1);
        parentDir[NXI_MAX_PATH - 1] = L'\0';
        PathRemoveFileSpecW(parentDir);
        NxIns_EnsureDir(parentDir);

        /* Update status */
        NxIns_SetStatus(L"Extracting: %s", fe->relativePath);

        /* Create output file */
        HANDLE hOut = CreateFileW(outPath, GENERIC_WRITE, 0, NULL,
                                  CREATE_ALWAYS, fe->attributes, NULL);
        if (hOut == INVALID_HANDLE_VALUE) continue;

        /* Seek to this file's data in the payload */
        SetFilePointer(hFile, dataBlockOffset + fe->dataOffset, NULL, FILE_BEGIN);

        if (fe->compressedSize > 0 && fe->compressedSize != fe->dataSize) {
            /* Compressed file (chunked format v2) — read chunk count, decompress each */
            DWORD chunkCount = 0;
            if (!ReadFile(hFile, &chunkCount, 4, &bytesRead, NULL) || bytesRead != 4)
                chunkCount = 0;  /* corrupt header — extract nothing for this file */

            for (DWORD c = 0; c < chunkCount; c++) {
                DWORD compChunkSize = 0, origChunkSize = 0;
                /* Read both size fields; bail on any read failure / short read. */
                if (!ReadFile(hFile, &compChunkSize, 4, &bytesRead, NULL) || bytesRead != 4)
                    break;
                if (!ReadFile(hFile, &origChunkSize, 4, &bytesRead, NULL) || bytesRead != 4)
                    break;

                BYTE *compBuf = (BYTE *)malloc(compChunkSize);
                BYTE *decompBuf = (BYTE *)malloc(origChunkSize);

                if (!compBuf || !decompBuf) {
                    /* Alloc failed — abort this file cleanly rather than skipping
                     * only the read (which would misalign the file pointer). */
                    if (compBuf) free(compBuf);
                    if (decompBuf) free(decompBuf);
                    break;
                }

                if (!ReadFile(hFile, compBuf, compChunkSize, &bytesRead, NULL) ||
                    bytesRead != compChunkSize) {
                    /* Truncated compressed data — abort this file. */
                    free(compBuf);
                    free(decompBuf);
                    break;
                }

                if (compChunkSize == origChunkSize) {
                    /* Stored raw (compression failed for this chunk) */
                    DWORD written;
                    WriteFile(hOut, compBuf, compChunkSize, &written, NULL);
                } else {
                    uLongf decompSize = (uLongf)origChunkSize;
                    int zret = uncompress(decompBuf, &decompSize, compBuf, (uLong)compChunkSize);

                    DWORD written;
                    if (zret == Z_OK) {
                        WriteFile(hOut, decompBuf, (DWORD)decompSize, &written, NULL);
                    } else {
                        /* Decompression failed — write raw as fallback */
                        WriteFile(hOut, compBuf, compChunkSize, &written, NULL);
                    }
                }

                free(compBuf);
                free(decompBuf);
            }
        } else {
            /* Uncompressed file — copy raw in chunks */
            DWORD remaining = fe->dataSize;

            while (remaining > 0) {
                DWORD chunk = (remaining > 65536) ? 65536 : remaining;
                /* Bail on read failure or short/zero read (truncated payload)
                 * to avoid an infinite loop (remaining never decreases). */
                if (!ReadFile(hFile, copyBuf, chunk, &bytesRead, NULL) || bytesRead == 0)
                    break;

                DWORD written;
                WriteFile(hOut, copyBuf, bytesRead, &written, NULL);
                remaining -= bytesRead;
            }
        }

        CloseHandle(hOut);
        g_ins.filesExtracted++;

        /* Trigger UI update */
        if (g_ins.hwndMain)
            PostMessage(g_ins.hwndMain, WM_APP + 100, 0, 0);
    }

    free(copyBuf);
    free(entries);
    CloseHandle(hFile);

    return !g_ins.installCancelled;
}


/* ═══════════════════════════════════════════════════════════════
 *  Installation Actions
 * ═══════════════════════════════════════════════════════════════ */

BOOL NxIns_CreateShortcuts(void)
{
    if (!(g_ins.components & NXI_COMP_SHORTCUTS)) return TRUE;

    NxIns_SetStatus(L"Creating shortcuts...");

    CoInitialize(NULL);

    /* Build path to NexiaIDE.exe */
    WCHAR exePath[NXI_MAX_PATH];
    wsprintfW(exePath, L"%s\\%s", g_ins.installDir, NXI_APP_EXE);

    /* Start Menu folder */
    WCHAR startMenuDir[NXI_MAX_PATH];
    if (SHGetFolderPathW(NULL, CSIDL_PROGRAMS, NULL, 0, startMenuDir) == S_OK) {
        wcscat(startMenuDir, L"\\Nexia IDE");
        CreateDirectoryW(startMenuDir, NULL);

        WCHAR lnkPath[NXI_MAX_PATH];
        wsprintfW(lnkPath, L"%s\\Nexia IDE.lnk", startMenuDir);

        /* Create shortcut via IShellLink */
        IShellLinkW *psl = NULL;
        HRESULT hr = CoCreateInstance(&CLSID_ShellLink, NULL, CLSCTX_INPROC_SERVER,
                                      &IID_IShellLinkW, (void **)&psl);
        if (SUCCEEDED(hr) && psl) {
            psl->lpVtbl->SetPath(psl, exePath);
            psl->lpVtbl->SetWorkingDirectory(psl, g_ins.installDir);
            psl->lpVtbl->SetDescription(psl, L"Nexia IDE - Xbox 360 Development Environment");

            IPersistFile *ppf = NULL;
            hr = psl->lpVtbl->QueryInterface(psl, &IID_IPersistFile, (void **)&ppf);
            if (SUCCEEDED(hr) && ppf) {
                ppf->lpVtbl->Save(ppf, lnkPath, TRUE);
                ppf->lpVtbl->Release(ppf);
            }
            psl->lpVtbl->Release(psl);
        }
    }

    /* Desktop shortcut */
    if (g_ins.createDesktopShortcut) {
        WCHAR desktopDir[NXI_MAX_PATH];
        if (SHGetFolderPathW(NULL, CSIDL_DESKTOPDIRECTORY, NULL, 0, desktopDir) == S_OK) {
            WCHAR lnkPath[NXI_MAX_PATH];
            wsprintfW(lnkPath, L"%s\\Nexia IDE.lnk", desktopDir);

            IShellLinkW *psl = NULL;
            HRESULT hr = CoCreateInstance(&CLSID_ShellLink, NULL, CLSCTX_INPROC_SERVER,
                                          &IID_IShellLinkW, (void **)&psl);
            if (SUCCEEDED(hr) && psl) {
                psl->lpVtbl->SetPath(psl, exePath);
                psl->lpVtbl->SetWorkingDirectory(psl, g_ins.installDir);
                psl->lpVtbl->SetDescription(psl, L"Nexia IDE - Xbox 360 Development Environment");

                IPersistFile *ppf = NULL;
                hr = psl->lpVtbl->QueryInterface(psl, &IID_IPersistFile, (void **)&ppf);
                if (SUCCEEDED(hr) && ppf) {
                    ppf->lpVtbl->Save(ppf, lnkPath, TRUE);
                    ppf->lpVtbl->Release(ppf);
                }
                psl->lpVtbl->Release(psl);
            }
        }
    }

    CoUninitialize();
    return TRUE;
}

BOOL NxIns_RegisterFileAssoc(void)
{
    if (!(g_ins.components & NXI_COMP_FILEASSOC)) return TRUE;

    NxIns_SetStatus(L"Registering file associations...");

    WCHAR exePath[NXI_MAX_PATH];
    wsprintfW(exePath, L"\"%s\\%s\" \"%%1\"", g_ins.installDir, NXI_APP_EXE);

    /* File extensions to associate */
    static const WCHAR *exts[] = {
        L".vcxproj", L".c", L".cpp", L".h", L".hpp", L".hlsl", NULL
    };

    HKEY hKey;

    for (int i = 0; exts[i]; i++) {
        WCHAR keyBuf[256];

        /* Set extension -> progid */
        wsprintfW(keyBuf, L"Software\\Classes\\%s", exts[i]);
        if (RegCreateKeyExW(HKEY_CURRENT_USER, keyBuf, 0, NULL, 0,
                            KEY_WRITE, NULL, &hKey, NULL) == ERROR_SUCCESS) {
            RegSetValueExW(hKey, NULL, 0, REG_SZ,
                           (BYTE *)L"NexiaIDE.File", 28);
            RegCloseKey(hKey);
        }
    }

    /* Set progid -> command */
    if (RegCreateKeyExW(HKEY_CURRENT_USER,
                        L"Software\\Classes\\NexiaIDE.File\\shell\\open\\command",
                        0, NULL, 0, KEY_WRITE, NULL, &hKey, NULL) == ERROR_SUCCESS) {
        RegSetValueExW(hKey, NULL, 0, REG_SZ, (BYTE *)exePath,
                       (DWORD)(wcslen(exePath) + 1) * sizeof(WCHAR));
        RegCloseKey(hKey);
    }

    /* Friendly name */
    if (RegCreateKeyExW(HKEY_CURRENT_USER,
                        L"Software\\Classes\\NexiaIDE.File",
                        0, NULL, 0, KEY_WRITE, NULL, &hKey, NULL) == ERROR_SUCCESS) {
        RegSetValueExW(hKey, NULL, 0, REG_SZ,
                       (BYTE *)L"Nexia IDE Source File", 44);
        RegCloseKey(hKey);
    }

    /* Notify shell of changes */
    SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, NULL, NULL);

    return TRUE;
}

BOOL NxIns_RegisterUninstaller(void)
{
    NxIns_SetStatus(L"Registering uninstaller...");

    WCHAR uninstPath[NXI_MAX_PATH];
    wsprintfW(uninstPath, L"\"%s\\%s\"", g_ins.installDir, NXI_UNINSTALLER_EXE);

    WCHAR iconPath[NXI_MAX_PATH];
    wsprintfW(iconPath, L"%s\\%s", g_ins.installDir, NXI_APP_EXE);

    HKEY hKey;
    LONG result = RegCreateKeyExW(HKEY_LOCAL_MACHINE, NXI_REGISTRY_KEY,
                                  0, NULL, 0, KEY_WRITE, NULL, &hKey, NULL);

    /* Fall back to HKCU if no admin rights */
    if (result != ERROR_SUCCESS) {
        result = RegCreateKeyExW(HKEY_CURRENT_USER, NXI_REGISTRY_KEY,
                                 0, NULL, 0, KEY_WRITE, NULL, &hKey, NULL);
    }

    if (result != ERROR_SUCCESS) return FALSE;

    RegSetValueExW(hKey, L"DisplayName", 0, REG_SZ,
                   (BYTE *)NXI_APP_NAME, (DWORD)(wcslen(NXI_APP_NAME) + 1) * sizeof(WCHAR));
    RegSetValueExW(hKey, L"DisplayVersion", 0, REG_SZ,
                   (BYTE *)NXI_APP_VERSION, (DWORD)(wcslen(NXI_APP_VERSION) + 1) * sizeof(WCHAR));
    RegSetValueExW(hKey, L"Publisher", 0, REG_SZ,
                   (BYTE *)NXI_APP_PUBLISHER, (DWORD)(wcslen(NXI_APP_PUBLISHER) + 1) * sizeof(WCHAR));
    RegSetValueExW(hKey, L"UninstallString", 0, REG_SZ,
                   (BYTE *)uninstPath, (DWORD)(wcslen(uninstPath) + 1) * sizeof(WCHAR));
    RegSetValueExW(hKey, L"DisplayIcon", 0, REG_SZ,
                   (BYTE *)iconPath, (DWORD)(wcslen(iconPath) + 1) * sizeof(WCHAR));
    RegSetValueExW(hKey, L"InstallLocation", 0, REG_SZ,
                   (BYTE *)g_ins.installDir, (DWORD)(wcslen(g_ins.installDir) + 1) * sizeof(WCHAR));

    DWORD noModify = 1;
    RegSetValueExW(hKey, L"NoModify", 0, REG_DWORD, (BYTE *)&noModify, sizeof(DWORD));
    RegSetValueExW(hKey, L"NoRepair", 0, REG_DWORD, (BYTE *)&noModify, sizeof(DWORD));

    RegCloseKey(hKey);
    return TRUE;
}

BOOL NxIns_WriteUninstaller(void)
{
    NxIns_SetStatus(L"Writing uninstaller...");

    /*
     * Copy this EXE as uninstall.exe into the install directory.
     * When run with /uninstall flag it will remove files.
     */
    WCHAR uninstDst[NXI_MAX_PATH];
    wsprintfW(uninstDst, L"%s\\%s", g_ins.installDir, NXI_UNINSTALLER_EXE);

    return CopyFileW(g_ins.selfPath, uninstDst, FALSE);
}


/* ═══════════════════════════════════════════════════════════════
 *  Pre-Flight System Detection
 *
 *  Checks if the Xbox 360 SDK is already installed on the system
 *  and whether VS2010 / VC++ runtime is already present.
 *  Results are displayed on the Components page so the user knows
 *  what they already have and what needs to be installed.
 * ═══════════════════════════════════════════════════════════════ */

static BOOL sIsDirectoryW(const WCHAR *path)
{
    DWORD attr = GetFileAttributesW(path);
    return (attr != INVALID_FILE_ATTRIBUTES) && (attr & FILE_ATTRIBUTE_DIRECTORY);
}

static void NxIns_PreflightCheck(void)
{
    if (g_ins.preflightDone) return;
    g_ins.preflightDone = TRUE;

    /* ── Check for existing Xbox 360 SDK installation ── */
    g_ins.systemSdkFound = FALSE;

    /* Method 1: Check registry (HKLM\SOFTWARE\Microsoft\Xbox\2.0\SDK) */
    {
        HKEY hKey = NULL;
        static const WCHAR *regPaths[] = {
            L"SOFTWARE\\Microsoft\\Xbox\\2.0\\SDK",
            L"SOFTWARE\\Wow6432Node\\Microsoft\\Xbox\\2.0\\SDK",
            NULL
        };
        for (int i = 0; regPaths[i] && !g_ins.systemSdkFound; i++) {
            if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, regPaths[i], 0, KEY_READ, &hKey) == ERROR_SUCCESS) {
                WCHAR sdkPath[NXI_MAX_PATH];
                DWORD pathSize = sizeof(sdkPath);
                if (RegQueryValueExW(hKey, L"InstallPath", NULL, NULL, (LPBYTE)sdkPath, &pathSize) == ERROR_SUCCESS) {
                    /* Strip trailing backslash if present */
                    int len = (int)wcslen(sdkPath);
                    if (len > 0 && sdkPath[len - 1] == L'\\') sdkPath[len - 1] = L'\0';

                    /* Check for bin + include directories (matches IDE's toolchain.ts detection) */
                    WCHAR probe[NXI_MAX_PATH];
                    wsprintfW(probe, L"%s\\bin", sdkPath);
                    BOOL hasBin = sIsDirectoryW(probe);
                    wsprintfW(probe, L"%s\\include", sdkPath);
                    BOOL hasInc = sIsDirectoryW(probe);
                    if (hasBin && hasInc) {
                        g_ins.systemSdkFound = TRUE;
                        wcscpy(g_ins.systemSdkPath, sdkPath);
                    }
                }
                RegCloseKey(hKey);
            }
        }
    }

    /* Method 2: Check common install paths */
    if (!g_ins.systemSdkFound) {
        static const WCHAR *sdkPaths[] = {
            L"C:\\Program Files (x86)\\Microsoft Xbox 360 SDK",
            L"C:\\Program Files\\Microsoft Xbox 360 SDK",
            L"D:\\Program Files (x86)\\Microsoft Xbox 360 SDK",
            NULL
        };
        for (int i = 0; sdkPaths[i] && !g_ins.systemSdkFound; i++) {
            WCHAR probeBin[NXI_MAX_PATH];
            WCHAR probeInc[NXI_MAX_PATH];
            wsprintfW(probeBin, L"%s\\bin", sdkPaths[i]);
            wsprintfW(probeInc, L"%s\\include", sdkPaths[i]);
            if (sIsDirectoryW(probeBin) && sIsDirectoryW(probeInc)) {
                g_ins.systemSdkFound = TRUE;
                wcscpy(g_ins.systemSdkPath, sdkPaths[i]);
            }
        }
    }


    /* ── Check for Visual Studio 2010 ── */
    g_ins.vs2010Found = FALSE;
    {
        static const WCHAR *vs2010Paths[] = {
            L"C:\\Program Files (x86)\\Microsoft Visual Studio 10.0\\Common7\\IDE\\devenv.exe",
            L"C:\\Program Files\\Microsoft Visual Studio 10.0\\Common7\\IDE\\devenv.exe",
            NULL
        };
        for (int i = 0; vs2010Paths[i]; i++) {
            if (NxIns_FileExists(vs2010Paths[i])) {
                g_ins.vs2010Found = TRUE;
                break;
            }
        }
        if (!g_ins.vs2010Found) {
            HKEY hKey = NULL;
            if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\VisualStudio\\10.0", 0, KEY_READ, &hKey) == ERROR_SUCCESS) {
                g_ins.vs2010Found = TRUE;
                RegCloseKey(hKey);
            }
            if (!g_ins.vs2010Found && RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Wow6432Node\\Microsoft\\VisualStudio\\10.0", 0, KEY_READ, &hKey) == ERROR_SUCCESS) {
                g_ins.vs2010Found = TRUE;
                RegCloseKey(hKey);
            }
        }
    }

    /* ── Check for VC++ 2010 runtime DLLs ── */
    g_ins.vcRuntimeFound = FALSE;
    {
        WCHAR winDir[NXI_MAX_PATH];
        WCHAR probe[NXI_MAX_PATH];
        GetWindowsDirectoryW(winDir, NXI_MAX_PATH);

        wsprintfW(probe, L"%s\\SysWOW64\\msvcr100.dll", winDir);
        if (NxIns_FileExists(probe)) {
            wsprintfW(probe, L"%s\\SysWOW64\\msvcp100.dll", winDir);
            if (NxIns_FileExists(probe))
                g_ins.vcRuntimeFound = TRUE;
        }
        if (!g_ins.vcRuntimeFound) {
            wsprintfW(probe, L"%s\\System32\\msvcr100.dll", winDir);
            if (NxIns_FileExists(probe)) {
                wsprintfW(probe, L"%s\\System32\\msvcp100.dll", winDir);
                if (NxIns_FileExists(probe))
                    g_ins.vcRuntimeFound = TRUE;
            }
        }
    }
}


/* ═══════════════════════════════════════════════════════════════
 *  Xbox 360 SDK Auto-Detection & Extraction
 *
 *  Scans common locations for "XBOX360 SDK 21256.3.exe" or similar.
 *  If found, extracts the SDK using the built-in FDI Cabinet API
 *  (same approach as sdkextract.c in the IDE). No external tools.
 *  The installer EXE is NEVER executed — opened as raw binary only.
 * ═══════════════════════════════════════════════════════════════ */

/* MSCF = Microsoft Cabinet File signature */
#define MSCF_SIGNATURE  0x4643534D

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

static BOOL sMatchSdkInstaller(const WCHAR *filename)
{
    /* Match patterns like "XBOX360 SDK 21256.3.exe", "Xbox360SDK_21256.exe", etc. */
    const WCHAR *name = wcsrchr(filename, L'\\');
    name = name ? name + 1 : filename;

    /* Case-insensitive search for key parts */
    WCHAR lower[NXI_MAX_PATH];
    wcsncpy(lower, name, NXI_MAX_PATH - 1);
    lower[NXI_MAX_PATH - 1] = 0;
    for (WCHAR *p = lower; *p; p++) *p = towlower(*p);

    if ((wcsstr(lower, L"xbox360") || wcsstr(lower, L"xbox 360")) &&
        wcsstr(lower, L"sdk") &&
        wcsstr(lower, L".exe")) {
        return TRUE;
    }
    return FALSE;
}

static BOOL sScanDirectory(const WCHAR *dir, WCHAR *outPath, int maxLen)
{
    WCHAR pattern[NXI_MAX_PATH];
    wsprintfW(pattern, L"%s\\*", dir);

    WIN32_FIND_DATAW fd;
    HANDLE hFind = FindFirstFileW(pattern, &fd);
    if (hFind == INVALID_HANDLE_VALUE) return FALSE;

    do {
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
        if (sMatchSdkInstaller(fd.cFileName)) {
            wsprintfW(outPath, L"%s\\%s", dir, fd.cFileName);
            FindClose(hFind);
            return TRUE;
        }
    } while (FindNextFileW(hFind, &fd));

    FindClose(hFind);
    return FALSE;
}

BOOL NxIns_ScanForSdkInstaller(void)
{
    NxIns_SetStatus(L"Scanning for Xbox 360 SDK installer...");

    /* 1. Same directory as this installer */
    {
        WCHAR selfDir[NXI_MAX_PATH];
        wcscpy(selfDir, g_ins.selfPath);
        WCHAR *sl = wcsrchr(selfDir, L'\\');
        if (sl) *sl = 0;
        if (sScanDirectory(selfDir, g_ins.sdkInstallerPath, NXI_MAX_PATH)) {
            g_ins.sdkInstallerFound = TRUE;
            return TRUE;
        }
    }

    /* 2. Desktop */
    {
        WCHAR desktop[NXI_MAX_PATH];
        if (SHGetFolderPathW(NULL, CSIDL_DESKTOPDIRECTORY, NULL, 0, desktop) == S_OK) {
            if (sScanDirectory(desktop, g_ins.sdkInstallerPath, NXI_MAX_PATH)) {
                g_ins.sdkInstallerFound = TRUE;
                return TRUE;
            }
        }
    }

    /* 3. Downloads folder (Vista+: FOLDERID_Downloads, fallback: profile\Downloads) */
    {
        WCHAR downloads[NXI_MAX_PATH];
        if (SHGetFolderPathW(NULL, CSIDL_PROFILE, NULL, 0, downloads) == S_OK) {
            wcscat(downloads, L"\\Downloads");
            if (sScanDirectory(downloads, g_ins.sdkInstallerPath, NXI_MAX_PATH)) {
                g_ins.sdkInstallerFound = TRUE;
                return TRUE;
            }
        }
    }

    /* 4. Common fixed paths */
    static const WCHAR *searchDirs[] = {
        L"C:\\Temp",
        L"D:\\",
        L"C:\\Users\\Public\\Downloads",
        NULL
    };
    for (int i = 0; searchDirs[i]; i++) {
        if (sScanDirectory(searchDirs[i], g_ins.sdkInstallerPath, NXI_MAX_PATH)) {
            g_ins.sdkInstallerFound = TRUE;
            return TRUE;
        }
    }

    g_ins.sdkInstallerFound = FALSE;
    return FALSE;
}

/* ═══════════════════════════════════════════════════════════════
 *  FDI Cabinet API — in-process decompression
 *
 *  Much faster than expand.exe: no process spawn, in-memory
 *  decompression, per-file progress callbacks.
 *  cabinet.dll ships with every Windows since 95.
 * ═══════════════════════════════════════════════════════════════ */

typedef struct {
    WCHAR   outputDir[NXI_MAX_PATH];
    int     filesExtracted;
    int     cabIndex;       /* for progress display */
    int     cabTotal;
} NxiFdiContext;

static NxiFdiContext *s_fdiCtx = NULL;

static FNALLOC(sNxiFdiAlloc)  { return malloc(cb); }
static FNFREE(sNxiFdiFree)    { free(pv); }

static FNOPEN(sNxiFdiOpen)
{
    int flags = (oflag & _O_WRONLY)
        ? (_O_WRONLY | _O_CREAT | _O_TRUNC | _O_BINARY)
        : (_O_RDONLY | _O_BINARY);
    return _open(pszFile, flags, pmode);
}
static FNREAD(sNxiFdiRead)    { return _read((int)(INT_PTR)hf, pv, cb); }
static FNWRITE(sNxiFdiWrite)  { return _write((int)(INT_PTR)hf, pv, cb); }
static FNCLOSE(sNxiFdiClose)  { return _close((int)(INT_PTR)hf); }
static FNSEEK(sNxiFdiSeek)    { return _lseek((int)(INT_PTR)hf, dist, seektype); }

static FNFDINOTIFY(sNxiFdiNotify)
{
    switch (fdint) {
    case fdintCOPY_FILE: {
        if (!s_fdiCtx) return 0;

        /* pfdin->psz1 = relative path inside the cab (ANSI) */
        WCHAR widePath[NXI_MAX_PATH];
        MultiByteToWideChar(CP_ACP, 0, pfdin->psz1, -1, widePath, NXI_MAX_PATH);

        /* Normalize slashes */
        for (WCHAR *p = widePath; *p; p++)
            if (*p == L'/') *p = L'\\';

        /* Defend against path traversal / absolute paths in the cab entry.
         * Return 0 to skip this file without aborting the whole cabinet. */
        if (!sNxIns_IsPathSafe(widePath)) {
            NxIns_SetStatus(L"Warning: skipping unsafe cab path: %s", widePath);
            return 0;
        }

        /* Build full output path */
        WCHAR fullPath[NXI_MAX_PATH];
        _snwprintf(fullPath, NXI_MAX_PATH, L"%s\\%s",
                   s_fdiCtx->outputDir, widePath);

        /* Ensure parent directory exists */
        WCHAR dirBuf[NXI_MAX_PATH];
        wcsncpy(dirBuf, fullPath, NXI_MAX_PATH - 1);
        dirBuf[NXI_MAX_PATH - 1] = 0;
        WCHAR *sl = wcsrchr(dirBuf, L'\\');
        if (sl) {
            *sl = 0;
            NxIns_EnsureDir(dirBuf);
        }

        /* Convert to ANSI for _open */
        char ansiPath[NXI_MAX_PATH];
        WideCharToMultiByte(CP_ACP, 0, fullPath, -1, ansiPath,
                            NXI_MAX_PATH, NULL, NULL);

        int fd = _open(ansiPath, _O_WRONLY | _O_CREAT | _O_TRUNC | _O_BINARY, 0666);
        if (fd != -1)
            s_fdiCtx->filesExtracted++;

        /* Update status every 10 files to keep UI responsive */
        if (s_fdiCtx->filesExtracted % 10 == 0 && g_ins.hwndMain) {
            WCHAR msg[256];
            wsprintfW(msg, L"Decompressing %d/%d \x2014 %d files extracted...",
                      s_fdiCtx->cabIndex, s_fdiCtx->cabTotal,
                      s_fdiCtx->filesExtracted);
            NxIns_SetStatus(msg);
            PostMessage(g_ins.hwndMain, WM_APP + 100, 0, 0);
            Sleep(0);  /* yield to let UI thread repaint */
        }

        return fd;
    }

    case fdintCLOSE_FILE_INFO:
        _close((int)(INT_PTR)pfdin->hf);
        return TRUE;

    default:
        return 0;
    }
}

/*
 * Decompress a cab file using FDI. Returns files extracted, or -1 on error.
 */
static int sDecompressCabFdi(const WCHAR *cabPath, const WCHAR *outputDir,
                              int cabIdx, int cabTotal)
{

    /* Split path into directory + filename for FDI */
    WCHAR wideDir[NXI_MAX_PATH], wideName[NXI_MAX_PATH];
    const WCHAR *lastSlash = wcsrchr(cabPath, L'\\');
    if (lastSlash) {
        int dirLen = (int)(lastSlash - cabPath) + 1;
        if (dirLen >= NXI_MAX_PATH) dirLen = NXI_MAX_PATH - 1;
        memcpy(wideDir, cabPath, dirLen * sizeof(WCHAR));
        wideDir[dirLen] = 0;
        wcsncpy(wideName, lastSlash + 1, NXI_MAX_PATH - 1);
        wideName[NXI_MAX_PATH - 1] = 0;
    } else {
        wcscpy(wideDir, L".\\");
        wcsncpy(wideName, cabPath, NXI_MAX_PATH - 1);
        wideName[NXI_MAX_PATH - 1] = 0;
    }

    char ansiDir[NXI_MAX_PATH], ansiName[NXI_MAX_PATH];
    WideCharToMultiByte(CP_ACP, 0, wideDir, -1, ansiDir, NXI_MAX_PATH, NULL, NULL);
    WideCharToMultiByte(CP_ACP, 0, wideName, -1, ansiName, NXI_MAX_PATH, NULL, NULL);

    NxiFdiContext ctx = {0};
    wcsncpy(ctx.outputDir, outputDir, NXI_MAX_PATH - 1);
    ctx.cabIndex = cabIdx;
    ctx.cabTotal = cabTotal;
    s_fdiCtx = &ctx;

    ERF erf = {0};
    HFDI hfdi = FDICreate(sNxiFdiAlloc, sNxiFdiFree, sNxiFdiOpen, sNxiFdiRead,
                           sNxiFdiWrite, sNxiFdiClose, sNxiFdiSeek,
                           cpuUNKNOWN, &erf);
    if (!hfdi) {
        s_fdiCtx = NULL;
        return -1;
    }

    BOOL ok = FDICopy(hfdi, ansiName, ansiDir, 0, sNxiFdiNotify, NULL, NULL);

    FDIDestroy(hfdi);
    s_fdiCtx = NULL;

    return ok ? ctx.filesExtracted : -1;
}


/*
 * NxIns_ExtractSdk — Extract the Xbox 360 SDK from the installer EXE.
 *
 * Scans the raw binary for embedded MSCF cabinet signatures, extracts
 * each needed cab to a temp file, then decompresses in-process using
 * the FDI Cabinet API (cabinet.dll). The installer is NEVER executed.
 */
BOOL NxIns_ExtractSdk(void)
{
    if (!g_ins.sdkInstallerFound) return FALSE;

    NxIns_SetStatus(L"Opening SDK installer (read-only)...");
    if (g_ins.hwndMain) { PostMessage(g_ins.hwndMain, WM_APP + 100, 0, 0); Sleep(30); }

    HANDLE hFile = CreateFileW(g_ins.sdkInstallerPath, GENERIC_READ,
                                FILE_SHARE_READ, NULL, OPEN_EXISTING,
                                FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        NxIns_SetStatus(L"Failed to open SDK installer.");
        return FALSE;
    }

    DWORD fileSize = GetFileSize(hFile, NULL);
    if (fileSize < 1024) { CloseHandle(hFile); return FALSE; }

    /* Extract to SDK/ — cab paths already contain XDK\ prefix
     * (e.g. XDK\bin\win32\cl.exe → SDK\XDK\bin\win32\cl.exe) */
    WCHAR sdkDir[NXI_MAX_PATH];
    wsprintfW(sdkDir, L"%s\\SDK", g_ins.installDir);
    NxIns_EnsureDir(sdkDir);

    WCHAR tempDir[NXI_MAX_PATH];
    wsprintfW(tempDir, L"%s\\SDK\\_sdktmp", g_ins.installDir);
    NxIns_EnsureDir(tempDir);

    /* ── Phase 1: Scan for MSCF cabinet signatures ── */
    g_ins.sdkExtractPhase = 1;
    g_ins.sdkCabsTotal = 100;  /* percentage-based during scan */
    g_ins.sdkCabsDone = 0;


    #define SCAN_BUF_SIZE  (2 * 1024 * 1024)  /* 2MB chunks for faster I/O */
    BYTE *scanBuf = (BYTE *)malloc(SCAN_BUF_SIZE);
    if (!scanBuf) { CloseHandle(hFile); return FALSE; }

    #define MAX_CABS 32
    struct { DWORD offset; DWORD size; } cabs[MAX_CABS];
    int cabCount = 0;

    DWORD pos = 0;
    DWORD lastUpdate = GetTickCount();
    while (pos < fileSize && cabCount < MAX_CABS) {
        if (g_ins.installCancelled) break;

        SetFilePointer(hFile, pos, NULL, FILE_BEGIN);
        DWORD toRead = (fileSize - pos > SCAN_BUF_SIZE) ? SCAN_BUF_SIZE : (fileSize - pos);
        DWORD bytesRead;
        ReadFile(hFile, scanBuf, toRead, &bytesRead, NULL);

        /* Scan every byte — MSCF headers may not be DWORD-aligned */
        for (DWORD i = 0; i + sizeof(MSCF_HEADER) <= bytesRead; i++) {
            if (*(DWORD *)(scanBuf + i) == MSCF_SIGNATURE) {
                MSCF_HEADER *hdr = (MSCF_HEADER *)(scanBuf + i);
                if (hdr->versionMajor == 1 && hdr->versionMinor == 3 &&
                    hdr->cbCabinet > 256 && hdr->cbCabinet <= fileSize) {
                    cabs[cabCount].offset = pos + i;
                    cabs[cabCount].size = hdr->cbCabinet;
                    cabCount++;
                    /* Jump past this cab entirely */
                    i += hdr->cbCabinet - 1;
                }
            }
        }

        /* Advance position, small overlap for boundary cabs */
        if (bytesRead <= 64) break;  /* reached end of file */
        pos += bytesRead - 64;
        if (pos >= fileSize) break;

        DWORD now = GetTickCount();
        if (now - lastUpdate > 150) {
            int scanPct = (int)((ULONGLONG)pos * 100 / fileSize);
            g_ins.sdkCabsDone = scanPct;
            WCHAR msg[256];
            wsprintfW(msg, L"Scanning SDK installer... %d%% (%d archives found)", scanPct, cabCount);
            NxIns_SetStatus(msg);
            if (g_ins.hwndMain) PostMessage(g_ins.hwndMain, WM_APP + 100, 0, 0);
            lastUpdate = now;
        }
    }
    free(scanBuf);

    if (cabCount == 0 || g_ins.installCancelled) {
        CloseHandle(hFile);
        NxIns_SetStatus(L"No cabinet archives found in SDK installer.");
        return FALSE;
    }

    /* ── Extract ALL cabs — full SDK installation ── */
    {
        BOOL cabNeeded[MAX_CABS];
        int neededCount = 0;
        ULONGLONG totalBytes = 0;
        int i, c;

        for (i = 0; i < cabCount; i++) {
            cabNeeded[i] = TRUE;
            neededCount++;
            totalBytes += cabs[i].size;
        }

        g_ins.sdkCabsTotal = neededCount;
        g_ins.sdkCabsDone = 0;
        g_ins.sdkExtractPhase = 2;


        {
            WCHAR msg[256];
            wsprintfW(msg, L"Processing %d of %d archives (%u MB)...",
                      neededCount, cabCount, (DWORD)(totalBytes / (1024 * 1024)));
            NxIns_SetStatus(msg);
            if (g_ins.hwndMain) { PostMessage(g_ins.hwndMain, WM_APP + 100, 0, 0); Sleep(200); }
        }

        /* ── Extract + decompress each needed cab one at a time ── */
        {
            BYTE *ioBuf = (BYTE *)malloc(256 * 1024);
            int processedIdx = 0;

            if (!ioBuf) { CloseHandle(hFile); return FALSE; }

            for (c = 0; c < cabCount; c++) {
                if (g_ins.installCancelled) break;
                if (!cabNeeded[c]) continue;
                processedIdx++;


        /* ── Step A: Copy cab from installer to temp file ── */
        WCHAR cabPath[NXI_MAX_PATH];
        wsprintfW(cabPath, L"%s\\sdk_%d.cab", tempDir, c + 1);

        HANDLE hCab = CreateFileW(cabPath, GENERIC_WRITE, 0, NULL,
                                   CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        if (hCab == INVALID_HANDLE_VALUE) continue;

        SetFilePointer(hFile, cabs[c].offset, NULL, FILE_BEGIN);
        DWORD remaining = cabs[c].size;
        DWORD cabWritten = 0;
        lastUpdate = GetTickCount();

        while (remaining > 0) {
            DWORD chunk = (remaining > (256 * 1024)) ? (256 * 1024) : remaining;
            DWORD br, wr;
            /* Bail on read failure or short/zero read (truncated installer)
             * to avoid an infinite loop (remaining never decreases). */
            if (!ReadFile(hFile, ioBuf, chunk, &br, NULL) || br == 0)
                break;
            WriteFile(hCab, ioBuf, br, &wr, NULL);
            remaining -= br;
            cabWritten += br;

            DWORD now = GetTickCount();
            if (now - lastUpdate > 200) {
                int cabPct = (int)((ULONGLONG)cabWritten * 100 / cabs[c].size);
                WCHAR msg[256];
                wsprintfW(msg, L"Reading archive %d/%d (cab %d)... %d%%",
                          processedIdx, neededCount, c + 1, cabPct);
                NxIns_SetStatus(msg);
                if (g_ins.hwndMain) PostMessage(g_ins.hwndMain, WM_APP + 100, 0, 0);
                Sleep(1);  /* yield to UI thread */
                lastUpdate = now;
            }
        }
        CloseHandle(hCab);
        /* ── Step B: Decompress this cab using FDI (in-process, no expand.exe) ── */
        {
            WCHAR msg[256];
            int filesDecompressed;
            wsprintfW(msg, L"Decompressing %d/%d (cab %d, %u MB)...",
                      processedIdx, neededCount, c + 1, cabs[c].size / (1024 * 1024));
            NxIns_SetStatus(msg);
            if (g_ins.hwndMain) { PostMessage(g_ins.hwndMain, WM_APP + 100, 0, 0); Sleep(10); }

            filesDecompressed = sDecompressCabFdi(cabPath, sdkDir,
                                                       processedIdx, neededCount);

            if (filesDecompressed < 0) {
                wsprintfW(msg, L"Warning: FDI failed on cab %d (continuing...)", c + 1);
                NxIns_SetStatus(msg);
            }
        }

        /* Delete temp cab immediately — frees disk space for next one */
        DeleteFileW(cabPath);

        g_ins.sdkCabsDone++;
        if (g_ins.hwndMain) PostMessage(g_ins.hwndMain, WM_APP + 100, 0, 0);
    }
    free(ioBuf);
    }  /* end extraction block */
    }  /* end cab selection block */
    CloseHandle(hFile);

    /* Clean up temp directory */
    RemoveDirectoryW(tempDir);

    /* Verify: check for key files (cab paths put things under XDK\) */
    {
        WCHAR testPath[NXI_MAX_PATH];
        wsprintfW(testPath, L"%s\\XDK\\include\\xbox\\xtl.h", sdkDir);
        if (GetFileAttributesW(testPath) != INVALID_FILE_ATTRIBUTES) {
            NxIns_SetStatus(L"SDK extraction complete \x2014 verified xtl.h present.");
        } else {
            NxIns_SetStatus(L"SDK extraction complete (could not verify xtl.h).");
        }
    }
    if (g_ins.hwndMain) PostMessage(g_ins.hwndMain, WM_APP + 100, 0, 0);
    return TRUE;
}



/* ═══════════════════════════════════════════════════════════════
 *  VC++ 2010 Runtime Installation
 *
 *  The Xbox 360 SDK tools (cl.exe, link.exe, etc.) are MSVC 2010 era
 *  and require msvcr100.dll + msvcp100.dll. This function:
 *    1. Runs vcredist_x86.exe silently (bundled in installer payload)
 *    2. Copies the runtime DLLs into the SDK bin\win32 folder
 * ═══════════════════════════════════════════════════════════════ */

static void NxIns_InstallVCRuntime(void)
{
    WCHAR sdkBin[NXI_MAX_PATH];
    WCHAR vcredistPath[NXI_MAX_PATH];
    WCHAR dllSrc[NXI_MAX_PATH];
    WCHAR dllDst[NXI_MAX_PATH];

    /* Build path to bundled vcredist_x86.exe */
    wsprintfW(vcredistPath, L"%s\\vcredist_x86.exe", g_ins.installDir);

    /* Check if vcredist was included in the payload */
    if (!NxIns_FileExists(vcredistPath)) {
        /* Not bundled — check if runtime DLLs are already available */
        NxIns_SetStatus(L"VC++ 2010 runtime not bundled, checking system...");
        goto copy_dlls;
    }

    /* Run vcredist_x86.exe silently */
    NxIns_SetStatus(L"Installing Microsoft Visual C++ 2010 runtime...");
    {
        SHELLEXECUTEINFOW sei;
        ZeroMemory(&sei, sizeof(sei));
        sei.cbSize = sizeof(sei);
        sei.fMask = SEE_MASK_NOCLOSEPROCESS;
        sei.lpFile = vcredistPath;
        sei.lpParameters = L"/q /norestart";
        sei.nShow = SW_HIDE;

        if (ShellExecuteExW(&sei) && sei.hProcess) {
            WaitForSingleObject(sei.hProcess, 120000); /* 2 min timeout */
            CloseHandle(sei.hProcess);
        }

        /* Delete the vcredist EXE after install — not needed anymore */
        DeleteFileW(vcredistPath);
    }

copy_dlls:
    /* Build SDK bin\win32 path */
    wsprintfW(sdkBin, L"%s\\SDK\\XDK\\bin\\win32", g_ins.installDir);

    /* Only copy if the SDK bin directory exists */
    if (GetFileAttributesW(sdkBin) == INVALID_FILE_ATTRIBUTES)
        return;

    /* Copy msvcr100.dll and msvcp100.dll from SysWOW64 (or System32) into SDK bin */
    static const WCHAR *sDlls[] = { L"msvcr100.dll", L"msvcp100.dll" };
    WCHAR sysDirBuf[NXI_MAX_PATH];
    BOOL foundSysDir = FALSE;

    /* Find system directory containing the DLLs */
    {
        WCHAR winDir[NXI_MAX_PATH];
        WCHAR probe[NXI_MAX_PATH];

        GetWindowsDirectoryW(winDir, NXI_MAX_PATH);

        /* Try SysWOW64 first (32-bit DLLs on 64-bit Windows) */
        wsprintfW(sysDirBuf, L"%s\\SysWOW64", winDir);
        wsprintfW(probe, L"%s\\msvcr100.dll", sysDirBuf);
        if (NxIns_FileExists(probe)) {
            foundSysDir = TRUE;
        } else {
            /* Fall back to System32 */
            wsprintfW(sysDirBuf, L"%s\\System32", winDir);
            wsprintfW(probe, L"%s\\msvcr100.dll", sysDirBuf);
            if (NxIns_FileExists(probe))
                foundSysDir = TRUE;
        }
    }

    if (!foundSysDir) {
        NxIns_SetStatus(L"Warning: VC++ 2010 runtime DLLs not found in system directories.");
        return;
    }

    NxIns_SetStatus(L"Copying VC++ 2010 runtime into SDK...");
    for (int i = 0; i < 2; i++) {
        wsprintfW(dllSrc, L"%s\\%s", sysDirBuf, sDlls[i]);
        wsprintfW(dllDst, L"%s\\%s", sdkBin, sDlls[i]);
        if (!NxIns_FileExists(dllDst)) {
            CopyFileW(dllSrc, dllDst, FALSE);
        }
    }
}


/* ═══════════════════════════════════════════════════════════════
 *  Install Thread
 * ═══════════════════════════════════════════════════════════════ */

DWORD WINAPI NxIns_InstallThread(LPVOID param)
{
    (void)param;

    g_ins.installing = TRUE;
    g_ins.installSuccess = FALSE;

    /* Step 1: Extract payload files */
    NxIns_SetStatus(L"Extracting files...");
    if (!NxIns_ExtractPayload()) {
        if (!g_ins.installCancelled)
            NxIns_SetStatus(L"Failed to extract files.");
        goto done;
    }

    /* Step 2: Xbox 360 SDK */
    if (g_ins.systemSdkFound) {
        /* SDK already installed on system — the IDE will detect it automatically
         * at the standard path (e.g. C:\Program Files (x86)\Microsoft Xbox 360 SDK).
         * No junction or extraction needed. */
        NxIns_SetStatus(L"Xbox 360 SDK detected \x2014 using existing system installation.");
    } else if (g_ins.sdkInstallerFound && (g_ins.components & NXI_COMP_SDK_EXTRACT)) {
        NxIns_SetStatus(L"Extracting Xbox 360 SDK...");
        if (!NxIns_ExtractSdk()) {
            if (!g_ins.installCancelled)
                NxIns_SetStatus(L"Warning: SDK extraction failed. You can extract later via Tools > Extract SDK.");
        }
    }

    /* Step 3: Install VC++ 2010 runtime & copy DLLs into SDK bin */
    if (g_ins.vcRuntimeFound || g_ins.vs2010Found) {
        NxIns_SetStatus(L"VC++ 2010 runtime already present \x2014 skipping installer.");
    } else {
        NxIns_InstallVCRuntime();
    }
    /* Always copy DLLs into SDK bin folder regardless */
    {
        WCHAR sdkBin[NXI_MAX_PATH];
        if (g_ins.systemSdkFound) {
            /* System SDK — copy DLLs into its bin\win32 */
            wsprintfW(sdkBin, L"%s\\bin\\win32", g_ins.systemSdkPath);
        } else {
            /* Bundled/extracted SDK */
            wsprintfW(sdkBin, L"%s\\SDK\\XDK\\bin\\win32", g_ins.installDir);
        }
        if (GetFileAttributesW(sdkBin) != INVALID_FILE_ATTRIBUTES) {
            static const WCHAR *dlls[] = { L"msvcr100.dll", L"msvcp100.dll" };
            WCHAR winDir[NXI_MAX_PATH];
            GetWindowsDirectoryW(winDir, NXI_MAX_PATH);
            for (int i = 0; i < 2; i++) {
                WCHAR dst[NXI_MAX_PATH];
                wsprintfW(dst, L"%s\\%s", sdkBin, dlls[i]);
                if (!NxIns_FileExists(dst)) {
                    WCHAR src[NXI_MAX_PATH];
                    wsprintfW(src, L"%s\\SysWOW64\\%s", winDir, dlls[i]);
                    if (!NxIns_FileExists(src))
                        wsprintfW(src, L"%s\\System32\\%s", winDir, dlls[i]);
                    CopyFileW(src, dst, FALSE);
                }
            }
        }
    }

    /* Step 4: Create shortcuts */
    if (!NxIns_CreateShortcuts()) {
        NxIns_SetStatus(L"Warning: Could not create shortcuts.");
    }

    /* Step 5: File associations */
    if (!NxIns_RegisterFileAssoc()) {
        NxIns_SetStatus(L"Warning: Could not register file associations.");
    }

    /* Step 6: Uninstaller */
    NxIns_WriteUninstaller();
    NxIns_RegisterUninstaller();

    g_ins.installSuccess = TRUE;
    NxIns_SetStatus(L"Installation complete.");

done:
    g_ins.installing = FALSE;

    /* Move to completion page */
    PostMessage(g_ins.hwndMain, WM_APP + 101, 0, 0);

    return 0;
}


/* ═══════════════════════════════════════════════════════════════
 *  Uninstall Logic
 * ═══════════════════════════════════════════════════════════════ */

/* Recursively delete all files and subdirectories within a directory.
 * Skips the uninstaller EXE itself (will be cleaned up by cmd /c later). */
static void sDeleteDirectoryContents(const WCHAR *dir)
{
    WCHAR searchPath[NXI_MAX_PATH];
    wsprintfW(searchPath, L"%s\\*", dir);

    WIN32_FIND_DATAW fd;
    HANDLE hFind = FindFirstFileW(searchPath, &fd);
    if (hFind == INVALID_HANDLE_VALUE) return;

    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0)
            continue;

        WCHAR fullPath[NXI_MAX_PATH];
        wsprintfW(fullPath, L"%s\\%s", dir, fd.cFileName);

        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
                /* This is a junction or symlink — remove the link itself,
                 * do NOT recurse into it or we'd delete the target's files
                 * (e.g. the system Xbox 360 SDK). */
                RemoveDirectoryW(fullPath);
            } else {
                /* Regular directory — recurse */
                sDeleteDirectoryContents(fullPath);
                RemoveDirectoryW(fullPath);
            }
        } else {
            /* Skip uninstaller (it's still running) */
            if (wcscmp(fd.cFileName, NXI_UNINSTALLER_EXE) == 0)
                continue;
            /* Clear read-only flag if set */
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_READONLY)
                SetFileAttributesW(fullPath, FILE_ATTRIBUTE_NORMAL);
            DeleteFileW(fullPath);
        }
    } while (FindNextFileW(hFind, &fd));
    FindClose(hFind);
}

/* ═══════════════════════════════════════════════════════════════
 *  Themed Uninstall Confirmation Dialog
 * ═══════════════════════════════════════════════════════════════ */

#define NXU_DLG_W   420
#define NXU_DLG_H   240
#define NXU_BTN_UNINSTALL  5001
#define NXU_BTN_CANCEL     5002

static int g_uninstallResult = 0;

static LRESULT CALLBACK sUninstallWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC hdc = BeginPaint(hwnd, &ps);

        /* Background */
        RECT rc;
        GetClientRect(hwnd, &rc);
        HBRUSH bgBrush = CreateSolidBrush(NXI_COL_BG_PRIMARY);
        FillRect(hdc, &rc, bgBrush);
        DeleteObject(bgBrush);

        /* Top accent line */
        HPEN accentPen = CreatePen(PS_SOLID, 2, 0x004444EF); /* red accent for uninstall */
        HPEN oldPen = (HPEN)SelectObject(hdc, accentPen);
        MoveToEx(hdc, 0, 0, NULL);
        LineTo(hdc, rc.right, 0);
        SelectObject(hdc, oldPen);
        DeleteObject(accentPen);

        SetBkMode(hdc, TRANSPARENT);

        /* Icon area — warning triangle */
        HFONT hFontIcon = CreateFontW(36, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
            DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI Symbol");
        HFONT oldFont = (HFONT)SelectObject(hdc, hFontIcon);
        SetTextColor(hdc, 0x0055AAFF); /* amber */
        RECT iconRc = { 0, 28, rc.right, 68 };
        DrawTextW(hdc, L"\x26A0", -1, &iconRc, DT_CENTER | DT_SINGLELINE);
        SelectObject(hdc, oldFont);
        DeleteObject(hFontIcon);

        /* Title */
        HFONT hFontTitle = CreateFontW(-20, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE,
            DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
        SelectObject(hdc, hFontTitle);
        SetTextColor(hdc, NXI_COL_FG_PRIMARY);
        RECT titleRc = { 30, 76, rc.right - 30, 100 };
        DrawTextW(hdc, L"Uninstall Nexia IDE?", -1, &titleRc, DT_CENTER | DT_SINGLELINE);
        SelectObject(hdc, oldFont);
        DeleteObject(hFontTitle);

        /* Body text */
        HFONT hFontBody = CreateFontW(-13, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
            DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
        SelectObject(hdc, hFontBody);
        SetTextColor(hdc, NXI_COL_FG_SECONDARY);
        RECT bodyRc = { 40, 108, rc.right - 40, 155 };
        DrawTextW(hdc, L"This will remove all program files, SDK data, and shortcuts from your computer.",
                  -1, &bodyRc, DT_CENTER | DT_WORDBREAK);
        SelectObject(hdc, oldFont);
        DeleteObject(hFontBody);

        /* Bottom border */
        HPEN borderPen = CreatePen(PS_SOLID, 1, NXI_COL_BORDER);
        oldPen = (HPEN)SelectObject(hdc, borderPen);
        MoveToEx(hdc, 0, NXU_DLG_H - 56, NULL);
        LineTo(hdc, rc.right, NXU_DLG_H - 56);
        SelectObject(hdc, oldPen);
        DeleteObject(borderPen);

        /* Button bar background */
        RECT btnBar = { 0, NXU_DLG_H - 55, rc.right, rc.bottom };
        HBRUSH barBrush = CreateSolidBrush(NXI_COL_BG_SECONDARY);
        FillRect(hdc, &btnBar, barBrush);
        DeleteObject(barBrush);

        EndPaint(hwnd, &ps);
        return 0;
    }

    case WM_COMMAND:
        if (LOWORD(wParam) == NXU_BTN_UNINSTALL) {
            g_uninstallResult = IDYES;
            DestroyWindow(hwnd);
        } else if (LOWORD(wParam) == NXU_BTN_CANCEL) {
            g_uninstallResult = IDNO;
            DestroyWindow(hwnd);
        }
        return 0;

    case WM_CLOSE:
        g_uninstallResult = IDNO;
        DestroyWindow(hwnd);
        return 0;

    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

static int sShowUninstallDialog(HINSTANCE hInst)
{
    WNDCLASSEXW wc;
    ZeroMemory(&wc, sizeof(wc));
    wc.cbSize        = sizeof(WNDCLASSEXW);
    wc.style         = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc   = sUninstallWndProc;
    wc.hInstance      = hInst;
    wc.hCursor        = LoadCursor(NULL, IDC_ARROW);
    wc.hbrBackground  = NULL;
    wc.lpszClassName  = L"NexiaUninstallDlg";

    if (!RegisterClassExW(&wc)) return IDNO;

    int screenW = GetSystemMetrics(SM_CXSCREEN);
    int screenH = GetSystemMetrics(SM_CYSCREEN);
    RECT rc = { 0, 0, NXU_DLG_W, NXU_DLG_H };
    DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU;
    AdjustWindowRect(&rc, style, FALSE);
    int winW = rc.right - rc.left;
    int winH = rc.bottom - rc.top;

    HWND hwnd = CreateWindowExW(0, L"NexiaUninstallDlg", L"Nexia IDE",
        style,
        (screenW - winW) / 2, (screenH - winH) / 2, winW, winH,
        NULL, NULL, hInst, NULL);

    if (!hwnd) return IDNO;

    /* Cancel button */
    HWND hCancel = CreateWindowExW(0, L"BUTTON", L"Cancel",
        WS_CHILD | WS_VISIBLE | BS_FLAT,
        NXU_DLG_W - 100 - 20, NXU_DLG_H - 44, 100, 32,
        hwnd, (HMENU)(INT_PTR)NXU_BTN_CANCEL, hInst, NULL);

    /* Uninstall button */
    HWND hUninst = CreateWindowExW(0, L"BUTTON", L"Uninstall",
        WS_CHILD | WS_VISIBLE | BS_FLAT,
        NXU_DLG_W - 100 - 20 - 110 - 10, NXU_DLG_H - 44, 110, 32,
        hwnd, (HMENU)(INT_PTR)NXU_BTN_UNINSTALL, hInst, NULL);

    /* Style buttons with dark theme fonts */
    HFONT hBtnFont = CreateFontW(-13, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
        DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    SendMessage(hCancel, WM_SETFONT, (WPARAM)hBtnFont, TRUE);
    SendMessage(hUninst, WM_SETFONT, (WPARAM)hBtnFont, TRUE);

    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);

    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    DeleteObject(hBtnFont);
    UnregisterClassW(L"NexiaUninstallDlg", hInst);
    return g_uninstallResult;
}

/* ═══════════════════════════════════════════════════════════════ */

static int sShowUninstallCompleteDialog(HINSTANCE hInst)
{
    /* Simple success message — also dark themed */
    MessageBoxW(NULL,
        L"Nexia IDE has been uninstalled successfully.\n\n"
        L"The install directory and shortcuts have been removed.",
        L"Nexia IDE", MB_OK | MB_ICONINFORMATION);
    return 0;
}

BOOL NxIns_Uninstall(BOOL skipConfirm)
{
    if (!skipConfirm) {
        int result = sShowUninstallDialog(g_ins.hInstance);
        if (result != IDYES) return FALSE;
    }

    /* Read install location from registry */
    WCHAR installDir[NXI_MAX_PATH] = {0};
    DWORD dirSize = sizeof(installDir);
    DWORD regType = 0;
    HKEY hKey = NULL;

    /* Try HKLM first, then HKCU */
    LONG regResult = RegOpenKeyExW(HKEY_LOCAL_MACHINE, NXI_REGISTRY_KEY,
                                   0, KEY_READ, &hKey);
    if (regResult == ERROR_SUCCESS) {
        regResult = RegQueryValueExW(hKey, L"InstallLocation", NULL, &regType,
                                     (BYTE *)installDir, &dirSize);
        RegCloseKey(hKey);
        hKey = NULL;
    }
    if (regResult != ERROR_SUCCESS || installDir[0] == L'\0') {
        dirSize = sizeof(installDir);
        regResult = RegOpenKeyExW(HKEY_CURRENT_USER, NXI_REGISTRY_KEY,
                                  0, KEY_READ, &hKey);
        if (regResult == ERROR_SUCCESS) {
            regResult = RegQueryValueExW(hKey, L"InstallLocation", NULL, &regType,
                                         (BYTE *)installDir, &dirSize);
            RegCloseKey(hKey);
            hKey = NULL;
        }
    }

    if (regResult != ERROR_SUCCESS || installDir[0] == L'\0') {
        MessageBoxW(NULL, L"Could not find installation directory in registry.",
                    L"Uninstall Error", MB_OK | MB_ICONERROR);
        return FALSE;
    }

    /* Recursively delete all files and subdirectories in install directory */
    sDeleteDirectoryContents(installDir);

    /* Remove Start Menu shortcuts */
    WCHAR startMenuDir[NXI_MAX_PATH];
    if (SHGetFolderPathW(NULL, CSIDL_PROGRAMS, NULL, 0, startMenuDir) == S_OK) {
        wcscat(startMenuDir, L"\\Nexia IDE");
        WCHAR lnkPath[NXI_MAX_PATH];
        wsprintfW(lnkPath, L"%s\\Nexia IDE.lnk", startMenuDir);
        DeleteFileW(lnkPath);
        RemoveDirectoryW(startMenuDir);
    }

    /* Remove Desktop shortcuts */
    WCHAR desktopDir[NXI_MAX_PATH];
    if (SHGetFolderPathW(NULL, CSIDL_DESKTOPDIRECTORY, NULL, 0, desktopDir) == S_OK) {
        WCHAR lnkPath[NXI_MAX_PATH];
        wsprintfW(lnkPath, L"%s\\Nexia IDE.lnk", desktopDir);
        DeleteFileW(lnkPath);
        wsprintfW(lnkPath, L"%s\\NexiaIDE Projects.lnk", desktopDir);
        DeleteFileW(lnkPath);
    }

    /* Remove file associations */
    SHDeleteKeyW(HKEY_CURRENT_USER, L"Software\\Classes\\NexiaIDE.File");

    static const WCHAR *exts[] = { L".vcxproj", L".c", L".cpp", L".h", L".hpp", L".hlsl", NULL };
    for (int i = 0; exts[i]; i++) {
        WCHAR keyBuf[256];
        wsprintfW(keyBuf, L"Software\\Classes\\%s", exts[i]);

        /* Only remove if it points to us */
        HKEY hExtKey = NULL;
        if (RegOpenKeyExW(HKEY_CURRENT_USER, keyBuf, 0, KEY_READ, &hExtKey) == ERROR_SUCCESS) {
            WCHAR val[256] = {0};
            DWORD valSize = sizeof(val);
            DWORD valType = 0;
            if (RegQueryValueExW(hExtKey, NULL, NULL, &valType,
                                 (BYTE *)val, &valSize) == ERROR_SUCCESS) {
                if (wcscmp(val, L"NexiaIDE.File") == 0) {
                    RegCloseKey(hExtKey);
                    hExtKey = NULL;
                    SHDeleteKeyW(HKEY_CURRENT_USER, keyBuf);
                }
            }
            if (hExtKey) RegCloseKey(hExtKey);
        }
    }

    /* Remove uninstall registry entry */
    SHDeleteKeyW(HKEY_LOCAL_MACHINE, NXI_REGISTRY_KEY);
    SHDeleteKeyW(HKEY_CURRENT_USER, NXI_REGISTRY_KEY);

    /* Notify shell */
    SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, NULL, NULL);

    /* Schedule self-deletion (the uninstaller EXE) via cmd */
    WCHAR selfPath[NXI_MAX_PATH];
    wsprintfW(selfPath, L"%s\\%s", installDir, NXI_UNINSTALLER_EXE);

    WCHAR cmdLine[NXI_MAX_PATH * 2];
    wsprintfW(cmdLine,
        L"cmd /c ping 127.0.0.1 -n 2 >nul & del /f /q \"%s\" & rmdir /s /q \"%s\"",
        selfPath, installDir);

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    ZeroMemory(&pi, sizeof(pi));

    CreateProcessW(NULL, cmdLine, NULL, NULL, FALSE,
                   CREATE_NO_WINDOW, NULL, NULL, &si, &pi);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);

    sShowUninstallCompleteDialog(g_ins.hInstance);

    return TRUE;
}


/* ═══════════════════════════════════════════════════════════════
 *  Hit Testing
 * ═══════════════════════════════════════════════════════════════ */

static BOOL sPtInRect(RECT *rc, int x, int y)
{
    return (x >= rc->left && x < rc->right && y >= rc->top && y < rc->bottom);
}

static void sHandleClick(HWND hwnd, int mx, int my)
{
    RECT clientRc;
    GetClientRect(hwnd, &clientRc);

    int contentLeft = NXI_SIDEBAR_W;
    int contentW = clientRc.right - NXI_SIDEBAR_W;
    int contentTop = 0;

    /* Footer area */
    RECT footer = { contentLeft, clientRc.bottom - NXI_FOOTER_H,
                    clientRc.right, clientRc.bottom };

    /* Content area (between header and footer) */
    RECT content = { contentLeft, contentTop,
                     clientRc.right, clientRc.bottom - NXI_FOOTER_H };

    int page = g_ins.currentPage;

    /* Check footer buttons — compute rects matching footer drawing */
    int pad = NXI_CONTENT_PAD;
    int btnW = 96, btnH = 32;
    int btnY = footer.top + (NXI_FOOTER_H - btnH) / 2;
    int rightEdge = footer.right - pad;

    RECT nextBtn = { rightEdge - btnW, btnY, rightEdge, btnY + btnH };
    RECT backBtn = { rightEdge - btnW - 10 - btnW, btnY, rightEdge - btnW - 10, btnY + btnH };

    /* Back button */
    if (page > NXI_PAGE_WELCOME && page < NXI_PAGE_INSTALLING &&
        sPtInRect(&backBtn, mx, my)) {
        NxIns_SetPage(page - 1);
        return;
    }

    /* Next / Install / Finish button */
    if (sPtInRect(&nextBtn, mx, my)) {
        if (page == NXI_PAGE_LICENSE && !g_ins.licenseAccepted) return;
        if (page == NXI_PAGE_INSTALLING) return;

        if (page == NXI_PAGE_COMPLETE) {
            /* Finish */
            if (g_ins.launchAfter && g_ins.installSuccess) {
                WCHAR exePath[NXI_MAX_PATH];
                wsprintfW(exePath, L"%s\\%s", g_ins.installDir, NXI_APP_EXE);
                ShellExecuteW(NULL, L"open", exePath, NULL, g_ins.installDir, SW_SHOWNORMAL);
            }
            PostQuitMessage(0);
            return;
        }

        if (page == NXI_PAGE_COMPONENTS) {
            /* Start installation */
            NxIns_SetPage(NXI_PAGE_INSTALLING);
            g_ins.hInstallThread = CreateThread(NULL, 0, NxIns_InstallThread, NULL, 0, NULL);
            return;
        }

        NxIns_SetPage(page + 1);
        return;
    }

    /* Page-specific click handling */
    int contentY = content.top + NXI_HEADER_H + NXI_CONTENT_PAD;
    int contentX = content.left + NXI_CONTENT_PAD;

    if (page == NXI_PAGE_LICENSE) {
        /* License accept checkbox area */
        int chkY = contentY + 216;
        RECT chkRc = { contentX, chkY, contentX + 300, chkY + 20 };
        if (sPtInRect(&chkRc, mx, my)) {
            g_ins.licenseAccepted = !g_ins.licenseAccepted;
            InvalidateRect(hwnd, NULL, FALSE);
        }
    }

    if (page == NXI_PAGE_DIRECTORY) {
        /* Browse button */
        int browseY = contentY + 52 + 22;
        int w = contentW - NXI_CONTENT_PAD * 2;
        RECT browseRc = { contentX + w - 80, browseY, contentX + w, browseY + 28 };
        if (sPtInRect(&browseRc, mx, my)) {
            WCHAR newPath[NXI_MAX_PATH];
            if (NxIns_BrowseForFolder(hwnd, newPath, NXI_MAX_PATH)) {
                wcsncpy(g_ins.installDir, newPath, NXI_MAX_PATH - 1);
                InvalidateRect(hwnd, NULL, FALSE);
            }
        }
    }

    if (page == NXI_PAGE_COMPONENTS) {
        int y = contentY + 32;
        int sp = 28;

        /* Skip core (index 0, not toggleable) */
        /* Shortcuts checkbox (index 1) */
        y += sp;
        RECT shortcutsRc = { contentX, y, contentX + 400, y + 20 };
        if (sPtInRect(&shortcutsRc, mx, my)) {
            g_ins.components ^= NXI_COMP_SHORTCUTS;
            InvalidateRect(hwnd, NULL, FALSE);
        }

        /* File assoc checkbox (index 2) */
        y += sp;
        RECT fileRc = { contentX, y, contentX + 400, y + 20 };
        if (sPtInRect(&fileRc, mx, my)) {
            g_ins.components ^= NXI_COMP_FILEASSOC;
            InvalidateRect(hwnd, NULL, FALSE);
        }

        /* SDK extract checkbox (index 3, only if found and system SDK not present) */
        if (g_ins.sdkInstallerFound && !g_ins.systemSdkFound) {
            y += sp;
            RECT sdkRc = { contentX, y, contentX + 400, y + 20 };
            if (sPtInRect(&sdkRc, mx, my)) {
                g_ins.components ^= NXI_COMP_SDK_EXTRACT;
                InvalidateRect(hwnd, NULL, FALSE);
            }
        }
    }

    if (page == NXI_PAGE_COMPLETE && g_ins.installSuccess) {
        /* Launch checkbox — must match DrawPageComplete layout */
        int launchY = contentY + 10 + 48 + 110;
        RECT launchRc = { contentX, launchY, contentX + 300, launchY + 20 };
        if (sPtInRect(&launchRc, mx, my)) {
            g_ins.launchAfter = !g_ins.launchAfter;
            InvalidateRect(hwnd, NULL, FALSE);
        }
    }
}


/* ═══════════════════════════════════════════════════════════════
 *  Window Procedure
 * ═══════════════════════════════════════════════════════════════ */

static LRESULT CALLBACK sInstallerWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
    case WM_CREATE:
        return 0;

    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC hdc = BeginPaint(hwnd, &ps);

        RECT clientRc;
        GetClientRect(hwnd, &clientRc);

        /* Double-buffer */
        HDC memDC = CreateCompatibleDC(hdc);
        HBITMAP memBmp = CreateCompatibleBitmap(hdc,
            clientRc.right - clientRc.left, clientRc.bottom - clientRc.top);
        HBITMAP oldBmp = (HBITMAP)SelectObject(memDC, memBmp);

        /* Background — content area uses secondary (IDE's bg-base #1e1e1e) */
        FillRect(memDC, &clientRc, g_ins.hbrBgSecondary);

        /* Sidebar */
        RECT sidebarRc = { 0, 0, NXI_SIDEBAR_W, clientRc.bottom };
        NxIns_DrawSidebar(memDC, &sidebarRc);

        /* Content area */
        RECT content = { NXI_SIDEBAR_W, 0, clientRc.right, clientRc.bottom - NXI_FOOTER_H };

        /* Header */
        NxIns_DrawHeader(memDC, &content,
                         sPageTitles[g_ins.currentPage],
                         sPageSubtitles[g_ins.currentPage]);

        /* Page content */
        switch (g_ins.currentPage) {
        case NXI_PAGE_WELCOME:    NxIns_DrawPageWelcome(memDC, &content);    break;
        case NXI_PAGE_LICENSE:    NxIns_DrawPageLicense(memDC, &content);    break;
        case NXI_PAGE_DIRECTORY:  NxIns_DrawPageDirectory(memDC, &content);  break;
        case NXI_PAGE_COMPONENTS: NxIns_DrawPageComponents(memDC, &content); break;
        case NXI_PAGE_INSTALLING: NxIns_DrawPageInstalling(memDC, &content); break;
        case NXI_PAGE_COMPLETE:   NxIns_DrawPageComplete(memDC, &content);   break;
        }

        /* Footer */
        RECT footer = { NXI_SIDEBAR_W, clientRc.bottom - NXI_FOOTER_H,
                        clientRc.right, clientRc.bottom };
        sDrawFooter(memDC, &footer);

        /* Blit */
        BitBlt(hdc, 0, 0, clientRc.right, clientRc.bottom, memDC, 0, 0, SRCCOPY);

        SelectObject(memDC, oldBmp);
        DeleteObject(memBmp);
        DeleteDC(memDC);

        EndPaint(hwnd, &ps);
        return 0;
    }

    case WM_LBUTTONDOWN: {
        int mx = (short)LOWORD(lParam);
        int my = (short)HIWORD(lParam);
        sHandleClick(hwnd, mx, my);
        return 0;
    }

    case WM_ERASEBKGND:
        return 1; /* We handle all painting */

    case WM_APP + 100:
        /* Progress update from install thread — force immediate repaint */
        InvalidateRect(hwnd, NULL, FALSE);
        UpdateWindow(hwnd);
        return 0;

    case WM_APP + 101:
        /* Installation complete — switch to final page */
        NxIns_SetPage(NXI_PAGE_COMPLETE);
        return 0;

    case WM_CLOSE:
        if (g_ins.installing) {
            int r = MessageBoxW(hwnd,
                L"Installation is in progress. Cancel?",
                NXI_APP_NAME, MB_YESNO | MB_ICONWARNING);
            if (r != IDYES) return 0;
            g_ins.installCancelled = TRUE;
        }
        DestroyWindow(hwnd);
        return 0;

    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }

    return DefWindowProcW(hwnd, msg, wParam, lParam);
}


/* ═══════════════════════════════════════════════════════════════
 *  Window Creation & Page Navigation
 * ═══════════════════════════════════════════════════════════════ */

void NxIns_SetPage(int page)
{
    if (page < 0 || page >= NXI_PAGE_COUNT) return;
    g_ins.currentPage = page;

    /* Scan for SDK installer when entering components page (once) */
    if (page == NXI_PAGE_COMPONENTS && !g_ins.sdkInstallerFound) {
        NxIns_ScanForSdkInstaller();
    }

    /* Run pre-flight system detection on components page */
    if (page == NXI_PAGE_COMPONENTS) {
        NxIns_PreflightCheck();

        /* If the system SDK is already installed, disable the extract option —
         * the IDE will use the system SDK directly. */
        if (g_ins.systemSdkFound) {
            g_ins.components &= ~NXI_COMP_SDK_EXTRACT;
        }
    }

    InvalidateRect(g_ins.hwndMain, NULL, FALSE);
}

BOOL NxIns_CreateWindow(int nCmdShow)
{
    WNDCLASSEXW wc;
    ZeroMemory(&wc, sizeof(wc));
    wc.cbSize        = sizeof(WNDCLASSEXW);
    wc.style         = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc   = sInstallerWndProc;
    wc.hInstance      = g_ins.hInstance;
    wc.hCursor        = LoadCursor(NULL, IDC_ARROW);
    wc.hbrBackground  = NULL;
    wc.lpszClassName  = L"NexiaInstallerWindow";
    wc.hIcon          = g_ins.hIconApp;
    wc.hIconSm        = g_ins.hIconSmall;

    if (!RegisterClassExW(&wc)) return FALSE;

    /* Center on screen */
    int screenW = GetSystemMetrics(SM_CXSCREEN);
    int screenH = GetSystemMetrics(SM_CYSCREEN);
    int x = (screenW - NXI_WINDOW_W) / 2;
    int y = (screenH - NXI_WINDOW_H) / 2;

    /* Adjust for non-client area */
    RECT rc = { 0, 0, NXI_WINDOW_W, NXI_WINDOW_H };
    DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
    AdjustWindowRect(&rc, style, FALSE);

    g_ins.hwndMain = CreateWindowExW(
        0, L"NexiaInstallerWindow", L"Nexia IDE Setup",
        style,
        x, y, rc.right - rc.left, rc.bottom - rc.top,
        NULL, NULL, g_ins.hInstance, NULL);

    if (!g_ins.hwndMain) return FALSE;

    ShowWindow(g_ins.hwndMain, nCmdShow);
    UpdateWindow(g_ins.hwndMain);

    return TRUE;
}


/* ═══════════════════════════════════════════════════════════════
 *  Lifecycle
 * ═══════════════════════════════════════════════════════════════ */

BOOL NxIns_Init(HINSTANCE hInstance)
{
    ZeroMemory(&g_ins, sizeof(g_ins));

    g_ins.hInstance = hInstance;
    g_ins.currentPage = NXI_PAGE_WELCOME;
    g_ins.components = NXI_COMP_DEFAULT;
    g_ins.launchAfter = TRUE;
    g_ins.createDesktopShortcut = TRUE;
    wcsncpy(g_ins.installDir, NXI_DEFAULT_INSTALL_DIR, NXI_MAX_PATH - 1);

    /* Get our own EXE path */
    GetModuleFileNameW(NULL, g_ins.selfPath, NXI_MAX_PATH);

    /* Init common controls */
    INITCOMMONCONTROLSEX icc = { sizeof(icc), ICC_PROGRESS_CLASS | ICC_WIN95_CLASSES };
    InitCommonControlsEx(&icc);

    /* Create GDI objects */
    NxIns_CreateFonts();
    NxIns_CreateBrushes();

    /* Try to load app icon */
    g_ins.hIconApp = LoadIconW(hInstance, MAKEINTRESOURCEW(100));
    g_ins.hIconSmall = LoadIconW(hInstance, MAKEINTRESOURCEW(100));
    if (!g_ins.hIconApp) {
        g_ins.hIconApp = LoadIconW(NULL, IDI_APPLICATION);
        g_ins.hIconSmall = LoadIconW(NULL, IDI_APPLICATION);
    }

    /* Locate payload in our EXE */
    NxIns_FindPayload();

    return TRUE;
}

void NxIns_Shutdown(void)
{
    if (g_ins.hInstallThread) {
        /* If the worker is still running after the wait, do NOT CloseHandle it:
         * closing a handle to a live thread and then exiting is risky. On a
         * forced exit we intentionally leak this one handle (the process is
         * about to terminate anyway, which reclaims it). */
        if (WaitForSingleObject(g_ins.hInstallThread, 5000) != WAIT_TIMEOUT) {
            CloseHandle(g_ins.hInstallThread);
        }
    }

    NxIns_DestroyGdi();
}


/* ═══════════════════════════════════════════════════════════════
 *  Entry Point
 * ═══════════════════════════════════════════════════════════════ */

/* ── Check if Nexia IDE is already installed ── */
static BOOL sIsAlreadyInstalled(WCHAR *outInstallDir, int maxLen)
{
    HKEY hKey = NULL;
    DWORD dirSize = (DWORD)(maxLen * sizeof(WCHAR));
    DWORD regType = 0;

    /* Try HKLM first */
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, NXI_REGISTRY_KEY, 0, KEY_READ, &hKey) == ERROR_SUCCESS) {
        if (RegQueryValueExW(hKey, L"InstallLocation", NULL, &regType,
                             (BYTE *)outInstallDir, &dirSize) == ERROR_SUCCESS &&
            outInstallDir[0] != L'\0') {
            RegCloseKey(hKey);
            /* Verify the installation actually exists on disk.
             * A previous uninstall may have deleted files but failed to
             * remove the HKLM key (e.g. insufficient privileges). */
            WCHAR exePath[NXI_MAX_PATH];
            wsprintfW(exePath, L"%s\\%s", outInstallDir, NXI_APP_EXE);
            if (GetFileAttributesW(exePath) != INVALID_FILE_ATTRIBUTES) {
                return TRUE;
            }
            /* Stale registry entry — try to clean it up */
            RegDeleteKeyW(HKEY_LOCAL_MACHINE, NXI_REGISTRY_KEY);
            outInstallDir[0] = L'\0';
        } else {
            RegCloseKey(hKey);
        }
    }

    /* Try HKCU */
    dirSize = (DWORD)(maxLen * sizeof(WCHAR));
    if (RegOpenKeyExW(HKEY_CURRENT_USER, NXI_REGISTRY_KEY, 0, KEY_READ, &hKey) == ERROR_SUCCESS) {
        if (RegQueryValueExW(hKey, L"InstallLocation", NULL, &regType,
                             (BYTE *)outInstallDir, &dirSize) == ERROR_SUCCESS &&
            outInstallDir[0] != L'\0') {
            RegCloseKey(hKey);
            /* Same check: verify installation actually exists */
            WCHAR exePath[NXI_MAX_PATH];
            wsprintfW(exePath, L"%s\\%s", outInstallDir, NXI_APP_EXE);
            if (GetFileAttributesW(exePath) != INVALID_FILE_ATTRIBUTES) {
                return TRUE;
            }
            /* Stale registry entry — clean up */
            RegDeleteKeyW(HKEY_CURRENT_USER, NXI_REGISTRY_KEY);
            outInstallDir[0] = L'\0';
        } else {
            RegCloseKey(hKey);
        }
    }

    return FALSE;
}


int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance,
                   LPSTR lpCmdLineA, int nCmdShow)
{
    (void)hPrevInstance;
    (void)lpCmdLineA;

    /* ── Windows version gate ──
     * Nexia IDE requires Windows 7 SP1 or later (NT 6.1+).
     * Block installation on XP (5.1), Vista (6.0), Win7 RTM (6.1 SP0),
     * and anything older. */
    {
        OSVERSIONINFOEXW osvi;
        ZeroMemory(&osvi, sizeof(osvi));
        osvi.dwOSVersionInfoSize = sizeof(osvi);
        #ifdef _MSC_VER
        #pragma warning(push)
        #pragma warning(disable: 4996)
        #endif
        #ifdef __GNUC__
        #pragma GCC diagnostic push
        #pragma GCC diagnostic ignored "-Wdeprecated-declarations"
        #endif
        GetVersionExW((OSVERSIONINFOW *)&osvi);
        #ifdef _MSC_VER
        #pragma warning(pop)
        #endif
        #ifdef __GNUC__
        #pragma GCC diagnostic pop
        #endif

        BOOL blocked = FALSE;
        const WCHAR *reason = NULL;

        if (osvi.dwMajorVersion < 6) {
            /* XP (5.1) or older */
            blocked = TRUE;
            reason = L"Nexia IDE requires Windows 7 SP1 or later.\n\n"
                     L"Your system is running Windows XP or older, "
                     L"which is not supported.\n\n"
                     L"Please upgrade to Windows 7 SP1, 8.1, 10, or 11.";
        } else if (osvi.dwMajorVersion == 6 && osvi.dwMinorVersion == 0) {
            /* Vista (6.0) — blocked entirely */
            blocked = TRUE;
            reason = L"Nexia IDE requires Windows 7 SP1 or later.\n\n"
                     L"Your system is running Windows Vista, "
                     L"which is not supported.\n\n"
                     L"Please upgrade to Windows 7 SP1, 8.1, 10, or 11.";
        } else if (osvi.dwMajorVersion == 6 && osvi.dwMinorVersion == 1
                   && osvi.wServicePackMajor < 1) {
            /* Windows 7 RTM without SP1 */
            blocked = TRUE;
            reason = L"Nexia IDE requires Windows 7 Service Pack 1.\n\n"
                     L"Your system is running Windows 7 without SP1. "
                     L"Please install Service Pack 1 from Windows Update "
                     L"before installing Nexia IDE.";
        }

        if (blocked) {
            MessageBoxW(NULL, reason,
                L"Nexia IDE - System Requirements",
                MB_OK | MB_ICONERROR);
            return 1;
        }
    }

    /* Get wide command line (works on all Windows versions) */
    LPWSTR lpCmdLine = GetCommandLineW();

    /* Check for /uninstall flag */
    if (lpCmdLine && (wcsstr(lpCmdLine, L"/uninstall") || wcsstr(lpCmdLine, L"-uninstall"))) {
        CoInitialize(NULL);
        NxIns_Uninstall(FALSE);
        CoUninitialize();
        return 0;
    }

    if (!NxIns_Init(hInstance)) return 1;

    /* Check if already installed (registry + filesystem verified).
     * If so, offer Uninstall / Reinstall / Cancel before the wizard. */
    {
        WCHAR existingDir[NXI_MAX_PATH] = {0};
        if (sIsAlreadyInstalled(existingDir, NXI_MAX_PATH)) {
            WCHAR msg[NXI_MAX_PATH + 256];
            wsprintfW(msg,
                L"Nexia IDE is already installed at:\n\n"
                L"%s\n\n"
                L"What would you like to do?\n\n"
                L"  Yes  =  Uninstall (remove Nexia IDE)\n"
                L"  No   =  Reinstall (overwrite current installation)\n"
                L"  Cancel  =  Exit",
                existingDir);

            int result = MessageBoxW(NULL, msg, L"Nexia IDE Setup",
                                     MB_YESNOCANCEL | MB_ICONQUESTION);

            if (result == IDYES) {
                /* Uninstall */
                CoInitialize(NULL);
                NxIns_Uninstall(TRUE);
                CoUninitialize();
                return 0;
            } else if (result == IDCANCEL) {
                return 0;
            }
            /* IDNO = reinstall — pre-fill path and continue to wizard */
            wcsncpy(g_ins.installDir, existingDir, NXI_MAX_PATH - 1);
        }
    }

    if (!NxIns_CreateWindow(nCmdShow)) return 1;

    /* Message loop */
    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    NxIns_Shutdown();
    return (int)msg.wParam;
}