/**
 * Project Manager
 * Handles project creation from templates, loading, and saving.
 */

import * as path from 'path';
import * as fs from 'fs';
import { ProjectConfig, ProjectTemplate, FileNode } from '../shared/types';

const PROJECT_FILE = 'nexia.json';

// ── Precompiled Header Content ──

const STDAFX_H = `#pragma once
/**
 * stdafx.h — Precompiled Header
 * Include common Xbox 360 SDK headers here.
 * All .cpp files must #include "stdafx.h" as the first line.
 */

// Xbox 360 core
#include <xtl.h>
#include <xboxmath.h>
#include <xinput2.h>

// Direct3D 9
#include <d3d9.h>
#include <d3dx9.h>
#include <xgraphics.h>

// Xbox services
#include <xam.h>

// C standard library
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
`;

const STDAFX_CPP = `/**
 * stdafx.cpp — Precompiled Header Source
 * This file is compiled with /Yc to create the .pch file.
 * Do NOT add any code here.
 */

#include "stdafx.h"
`;

// ── Template Source Files ──

const HELLO_MAIN = `/**
 * Xbox 360 Minecraft Spinning Block Demo
 * Textured rotating cube with vertex/pixel shaders.
 */

#include "stdafx.h"

#ifndef M_PI
#define M_PI 3.14159265358979323846f
#endif

//-------------------------------------------------------------------------------------
// Vertex shader
//-------------------------------------------------------------------------------------
const char* g_strVertexShaderProgram =
    " float4x4 matWVP : register(c0); "
    " struct VS_IN { float4 ObjPos : POSITION; float2 Tex : TEXCOORD0; }; "
    " struct VS_OUT { float4 ProjPos : POSITION; float2 Tex : TEXCOORD0; }; "
    " VS_OUT main(VS_IN In) { "
    " VS_OUT Out; "
    " Out.ProjPos = mul(matWVP, In.ObjPos); "
    " Out.Tex = In.Tex; "
    " return Out; "
    " } ";

//-------------------------------------------------------------------------------------
// Pixel shader
//-------------------------------------------------------------------------------------
const char* g_strPixelShaderProgram =
    " sampler2D texSampler : register(s0); "
    " struct PS_IN { float2 Tex : TEXCOORD0; }; "
    " float4 main(PS_IN In) : COLOR { "
    "     return tex2D(texSampler, In.Tex); "
    " }";

//-------------------------------------------------------------------------------------
// Vertex structure
//-------------------------------------------------------------------------------------
struct TEXVERTEX {
    float x, y, z;
    float u, v;
};
#define D3DFVF_TEXVERTEX (D3DFVF_XYZ | D3DFVF_TEX1)

//-------------------------------------------------------------------------------------
// Globals
//-------------------------------------------------------------------------------------
LPDIRECT3DDEVICE9 g_pd3dDevice = NULL;
LPDIRECT3DVERTEXBUFFER9 g_pVB = NULL;
LPDIRECT3DINDEXBUFFER9 g_pIB = NULL;
LPDIRECT3DVERTEXDECLARATION9 g_pVertexDecl = NULL;
LPDIRECT3DVERTEXSHADER9 g_pVertexShader = NULL;
LPDIRECT3DPIXELSHADER9 g_pPixelShader = NULL;
LPDIRECT3DTEXTURE9 g_pTexture = NULL;

D3DXMATRIX g_matWorld, g_matView, g_matProj;
bool g_bWidescreen = false;
XVIDEO_MODE VideoMode;

struct TimeInfo {
    LARGE_INTEGER qwTime;
    LARGE_INTEGER qwAppTime;
    float fAppTime;
    float fElapsedTime;
    float fSecsPerTick;
} g_Time;

//-------------------------------------------------------------------------------------
// InitTime
//-------------------------------------------------------------------------------------
void InitTime() {
    LARGE_INTEGER qwTicksPerSec;
    QueryPerformanceFrequency(&qwTicksPerSec);
    g_Time.fSecsPerTick = 1.0f / (float)qwTicksPerSec.QuadPart;
    QueryPerformanceCounter(&g_Time.qwTime);
    g_Time.qwAppTime.QuadPart = 0;
    g_Time.fAppTime = 0.0f;
    g_Time.fElapsedTime = 0.0f;
}

//-------------------------------------------------------------------------------------
// UpdateTime
//-------------------------------------------------------------------------------------
void UpdateTime() {
    LARGE_INTEGER qwNewTime;
    QueryPerformanceCounter(&qwNewTime);
    LARGE_INTEGER qwDeltaTime;
    qwDeltaTime.QuadPart = qwNewTime.QuadPart - g_Time.qwTime.QuadPart;
    g_Time.qwAppTime.QuadPart += qwDeltaTime.QuadPart;
    g_Time.qwTime.QuadPart = qwNewTime.QuadPart;
    g_Time.fElapsedTime = g_Time.fSecsPerTick * (float)qwDeltaTime.QuadPart;
    g_Time.fAppTime = g_Time.fSecsPerTick * (float)g_Time.qwAppTime.QuadPart;
}

//-------------------------------------------------------------------------------------
// InitD3D
//-------------------------------------------------------------------------------------
HRESULT InitD3D()
{
    Direct3D* pD3D = Direct3DCreate9(D3D_SDK_VERSION);
    if (!pD3D)
        return E_FAIL;

    D3DPRESENT_PARAMETERS d3dpp;
    ZeroMemory(&d3dpp, sizeof(d3dpp));

    XGetVideoMode(&VideoMode);
    g_bWidescreen = (VideoMode.fIsWideScreen != 0);

    d3dpp.BackBufferWidth        = min(VideoMode.dwDisplayWidth, 1280);
    d3dpp.BackBufferHeight       = min(VideoMode.dwDisplayHeight, 720);
    d3dpp.BackBufferFormat       = D3DFMT_X8R8G8B8;
    d3dpp.BackBufferCount        = 1;
    d3dpp.EnableAutoDepthStencil = TRUE;
    d3dpp.AutoDepthStencilFormat = D3DFMT_D24S8;
    d3dpp.SwapEffect             = D3DSWAPEFFECT_DISCARD;
    d3dpp.PresentationInterval   = D3DPRESENT_INTERVAL_IMMEDIATE;

    if (FAILED(pD3D->CreateDevice(
        0,
        D3DDEVTYPE_HAL,
        NULL,
        D3DCREATE_HARDWARE_VERTEXPROCESSING,
        &d3dpp,
        &g_pd3dDevice)))
    {
        return E_FAIL;
    }

    FLOAT fAspect = g_bWidescreen ? (16.0f / 9.0f) : (4.0f / 3.0f);
    D3DXMatrixPerspectiveFovLH(&g_matProj, D3DX_PI / 4, fAspect, 1.0f, 200.0f);

    D3DXVECTOR3 vEyePt(0.0f, 0.0f, -7.0f);
    D3DXVECTOR3 vLookatPt(0.0f, 0.0f, 0.0f);
    D3DXVECTOR3 vUp(0.0f, 1.0f, 0.0f);
    D3DXMatrixLookAtLH(&g_matView, &vEyePt, &vLookatPt, &vUp);

    D3DXMatrixIdentity(&g_matWorld);

    return S_OK;
}

//-------------------------------------------------------------------------------------
// InitScene
//-------------------------------------------------------------------------------------
HRESULT InitScene() {
    // --- Compile vertex shader ---
    LPD3DXBUFFER pVSCode = NULL;
    LPD3DXBUFFER pVSError = NULL;
    HRESULT hr = D3DXCompileShader(g_strVertexShaderProgram, (UINT)strlen(g_strVertexShaderProgram),
                                   NULL, NULL, "main", "vs_2_0", 0, &pVSCode, &pVSError, NULL);
    if (FAILED(hr)) {
        if (pVSError) OutputDebugStringA((char*)pVSError->GetBufferPointer());
        return E_FAIL;
    }
    g_pd3dDevice->CreateVertexShader((DWORD*)pVSCode->GetBufferPointer(), &g_pVertexShader);

    // --- Compile pixel shader ---
    LPD3DXBUFFER pPSCode = NULL;
    LPD3DXBUFFER pPSError = NULL;
    hr = D3DXCompileShader(g_strPixelShaderProgram, (UINT)strlen(g_strPixelShaderProgram),
                            NULL, NULL, "main", "ps_2_0", 0, &pPSCode, &pPSError, NULL);
    if (FAILED(hr)) {
        if (pPSError) OutputDebugStringA((char*)pPSError->GetBufferPointer());
        return E_FAIL;
    }
    g_pd3dDevice->CreatePixelShader((DWORD*)pPSCode->GetBufferPointer(), &g_pPixelShader);

    // --- Vertex declaration ---
    D3DVERTEXELEMENT9 elems[] = {
        {0, 0, D3DDECLTYPE_FLOAT3, D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_POSITION, 0},
        {0, 12, D3DDECLTYPE_FLOAT2, D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_TEXCOORD, 0},
        D3DDECL_END()
    };
    g_pd3dDevice->CreateVertexDeclaration(elems, &g_pVertexDecl);

    // --- Cube vertices with UVs ---
    TEXVERTEX verts[] = {
        // Front
        {-1,-1,-1, 0,1}, {-1,1,-1,0,0}, {1,1,-1,1,0}, {1,-1,-1,1,1},
        // Back
        {1,-1,1, 0,1}, {1,1,1,0,0}, {-1,1,1,1,0}, {-1,-1,1,1,1},
        // Left
        {-1,-1,1,0,1}, {-1,1,1,0,0}, {-1,1,-1,1,0}, {-1,-1,-1,1,1},
        // Right
        {1,-1,-1,0,1}, {1,1,-1,0,0}, {1,1,1,1,0}, {1,-1,1,1,1},
        // Top
        {-1,1,-1,0,1}, {-1,1,1,0,0}, {1,1,1,1,0}, {1,1,-1,1,1},
        // Bottom
        {-1,-1,1,0,1}, {-1,-1,-1,0,0}, {1,-1,-1,1,0}, {1,-1,1,1,1}
    };

    WORD indices[] = {
        0,1,2, 0,2,3,       // Front
        4,5,6, 4,6,7,       // Back
        8,9,10, 8,10,11,    // Left
        12,13,14, 12,14,15, // Right
        16,17,18, 16,18,19, // Top
        20,21,22, 20,22,23  // Bottom
    };

    // --- Vertex buffer ---
    if (FAILED(g_pd3dDevice->CreateVertexBuffer(sizeof(verts), D3DUSAGE_WRITEONLY, 0, D3DPOOL_MANAGED, &g_pVB, NULL))) return E_FAIL;
    void* pData = NULL;
    g_pVB->Lock(0, sizeof(verts), &pData, 0);
    memcpy(pData, verts, sizeof(verts));
    g_pVB->Unlock();

    // --- Index buffer ---
    if (FAILED(g_pd3dDevice->CreateIndexBuffer(sizeof(indices), D3DUSAGE_WRITEONLY, D3DFMT_INDEX16, D3DPOOL_MANAGED, &g_pIB, NULL))) return E_FAIL;
    void* pIdxData = NULL;
    g_pIB->Lock(0, sizeof(indices), &pIdxData, 0);
    memcpy(pIdxData, indices, sizeof(indices));
    g_pIB->Unlock();

    // --- Load dirt.png from content folder ---
    hr = D3DXCreateTextureFromFileExA(
        g_pd3dDevice,
        "game:\\\\Content\\\\dirt.png",
        D3DX_DEFAULT,           // Width - use file's width
        D3DX_DEFAULT,           // Height - use file's height
        1,                      // MipLevels - no mipmaps
        0,                      // Usage
        D3DFMT_A8R8G8B8,        // Format - force 32-bit ARGB
        D3DPOOL_DEFAULT,        // Pool - use default for Xbox 360
        D3DX_FILTER_NONE,       // Filter - no filtering during load
        D3DX_FILTER_NONE,       // MipFilter - no mip filtering
        0,                      // ColorKey - 0 means no color key
        NULL,                   // pSrcInfo
        NULL,                   // pPalette
        &g_pTexture
    );

    if (FAILED(hr) || g_pTexture == NULL) {
        char buf[256];
        sprintf(buf, "Failed to load texture: game:\\\\Content\\\\dirt.png (HRESULT: 0x%08X)\\n", hr);
        OutputDebugStringA(buf);
        // Fallback: procedural dirt-colored texture
        g_pd3dDevice->CreateTexture(4, 4, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT, &g_pTexture, NULL);
        D3DLOCKED_RECT lr;
        g_pTexture->LockRect(0, &lr, NULL, 0);
        DWORD dirtColors[] = { 0xFF8B6914, 0xFF7A5C12, 0xFF9B7920, 0xFF6B4E10 };
        DWORD* pixels = (DWORD*)lr.pBits;
        for (int i = 0; i < 16; i++)
            pixels[i] = dirtColors[i % 4];
        g_pTexture->UnlockRect(0);
    }

    return S_OK;
}

//-------------------------------------------------------------------------------------
// Update
//-------------------------------------------------------------------------------------
void Update() {
    float fAngle = g_Time.fAppTime;
    D3DXMATRIX rotX, rotY;
    D3DXMatrixRotationX(&rotX, fAngle * 0.6f);
    D3DXMatrixRotationY(&rotY, fAngle);
    g_matWorld = rotX * rotY;
}

//-------------------------------------------------------------------------------------
// Render
//-------------------------------------------------------------------------------------
void Render() {
    g_pd3dDevice->Clear(0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, D3DCOLOR_XRGB(137, 207, 240), 1.0f, 0);
    g_pd3dDevice->SetVertexDeclaration(g_pVertexDecl);
    g_pd3dDevice->SetStreamSource(0, g_pVB, 0, sizeof(TEXVERTEX));
    g_pd3dDevice->SetIndices(g_pIB);
    g_pd3dDevice->SetVertexShader(g_pVertexShader);
    g_pd3dDevice->SetPixelShader(g_pPixelShader);

    // Bind texture
    g_pd3dDevice->SetTexture(0, g_pTexture);

    D3DXMATRIX matWVP = g_matWorld * g_matView * g_matProj;
    g_pd3dDevice->SetVertexShaderConstantF(0, (float*)&matWVP, 4);

    g_pd3dDevice->DrawIndexedPrimitive(D3DPT_TRIANGLELIST, 0, 0, 24, 0, 12);
    g_pd3dDevice->Present(NULL, NULL, NULL, NULL);
}

//-------------------------------------------------------------------------------------
// Main loop
//-------------------------------------------------------------------------------------
void __cdecl main() {
    if (FAILED(InitD3D())) return;
    if (FAILED(InitScene())) return;
    InitTime();
    for (;;) {
        UpdateTime();
        Update();
        Render();
    }
}
`;

const XUI_MAIN = `/**
 * Xbox 360 XUI Application Template
 * Initializes D3D and the XUI framework.
 */

#include "stdafx.h"
#include <xui.h>
#include <xuiapp.h>

class CMyApp : public CXuiModule
{
public:
    virtual HRESULT RegisterXuiClasses();
    virtual HRESULT UnregisterXuiClasses();
};

HRESULT CMyApp::RegisterXuiClasses()
{
    return S_OK;
}

HRESULT CMyApp::UnregisterXuiClasses()
{
    return S_OK;
}

CMyApp g_App;

void __cdecl main()
{
    // Initialize Direct3D
    IDirect3D9* pD3D = Direct3DCreate9( D3D_SDK_VERSION );

    D3DPRESENT_PARAMETERS d3dpp;
    ZeroMemory( &d3dpp, sizeof(d3dpp) );
    d3dpp.BackBufferWidth  = 1280;
    d3dpp.BackBufferHeight = 720;
    d3dpp.BackBufferFormat = D3DFMT_X8R8G8B8;
    d3dpp.SwapEffect       = D3DSWAPEFFECT_DISCARD;
    d3dpp.PresentationInterval = D3DPRESENT_INTERVAL_ONE;

    IDirect3DDevice9* pd3dDevice = NULL;
    pD3D->CreateDevice( 0, D3DDEVTYPE_HAL, NULL,
        D3DCREATE_HARDWARE_VERTEXPROCESSING, &d3dpp, &pd3dDevice );

    // Initialize XUI
    TypefaceDescriptor typeface = { L"Arial Unicode MS", 0 };
    XuiRenderInitShared( pd3dDevice, &d3dpp, &typeface );

    HXUIOBJ hScene = NULL;
    g_App.Init( XuiD3DXTextureLoader, NULL );
    g_App.LoadSkin( L"game:\\\\skin.xui" );
    g_App.LoadFirstScene( L"game:\\\\scene.xur", NULL, &hScene );

    // Main loop
    for( ;; )
    {
        pd3dDevice->Clear( 0, NULL, D3DCLEAR_TARGET,
            D3DCOLOR_XRGB( 0, 0, 0 ), 1.0f, 0 );

        pd3dDevice->BeginScene();
        g_App.RunFrame();
        XuiTimersRun();
        XuiRenderBegin( pd3dDevice, D3DCOLOR_ARGB( 255, 0, 0, 0 ) );

        D3DXMATRIX matIdentity;
        D3DXMatrixIdentity( &matIdentity );
        XuiRenderSetViewTransform( &matIdentity );
        XuiRenderSetWorld( &matIdentity );

        HXUIOBJ hRoot = g_App.GetRootObj();
        XuiRenderDCBegin( hRoot );
        XuiRenderDCEnd();
        XuiRenderEnd();

        pd3dDevice->EndScene();
        pd3dDevice->Present( NULL, NULL, NULL, NULL );
    }
}
`;

const XBLA_MAIN = `/**
 * XBLA Title Template
 * Xbox Live Arcade title with basic networking init.
 */

#include "stdafx.h"
#include <xonline.h>

// Title ID - replace with your assigned Title ID
#define TITLE_ID 0xFFFFFFFF

IDirect3D9*       g_pD3D       = NULL;
IDirect3DDevice9* g_pd3dDevice = NULL;

BOOL InitD3D()
{
    g_pD3D = Direct3DCreate9( D3D_SDK_VERSION );
    if( !g_pD3D ) return FALSE;

    D3DPRESENT_PARAMETERS d3dpp;
    ZeroMemory( &d3dpp, sizeof(d3dpp) );
    d3dpp.BackBufferWidth  = 1280;
    d3dpp.BackBufferHeight = 720;
    d3dpp.BackBufferFormat = D3DFMT_X8R8G8B8;
    d3dpp.SwapEffect       = D3DSWAPEFFECT_DISCARD;
    d3dpp.PresentationInterval = D3DPRESENT_INTERVAL_ONE;
    d3dpp.EnableAutoDepthStencil = TRUE;
    d3dpp.AutoDepthStencilFormat = D3DFMT_D24S8;

    return SUCCEEDED( g_pD3D->CreateDevice( 0, D3DDEVTYPE_HAL, NULL,
        D3DCREATE_HARDWARE_VERTEXPROCESSING, &d3dpp, &g_pd3dDevice ) );
}

BOOL InitNetworking()
{
    XNetStartupParams xnsp;
    ZeroMemory( &xnsp, sizeof(xnsp) );
    xnsp.cfgSizeOfStruct = sizeof(xnsp);

    if( XNetStartup( &xnsp ) != 0 ) return FALSE;

    WSADATA wsaData;
    WSAStartup( MAKEWORD(2,2), &wsaData );

    return TRUE;
}

void Render()
{
    g_pd3dDevice->Clear( 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER,
        D3DCOLOR_XRGB( 0, 0, 40 ), 1.0f, 0 );
    g_pd3dDevice->BeginScene();
    // Your rendering here
    g_pd3dDevice->EndScene();
    g_pd3dDevice->Present( NULL, NULL, NULL, NULL );
}

void __cdecl main()
{
    if( !InitD3D() ) return;
    InitNetworking();

    for( ;; )
    {
        Render();
    }

    WSACleanup();
    XNetCleanup();
    g_pd3dDevice->Release();
    g_pD3D->Release();
}
`;


export class ProjectManager {
    private currentProject: ProjectConfig | null = null;

    getCurrent(): ProjectConfig | null {
        return this.currentProject;
    }

    /**
     * Get available project templates.
     */
    getTemplates(): ProjectTemplate[] {
        return [
            {
                id: 'empty',
                name: 'Empty Project',
                description: 'A blank Xbox 360 project with precompiled header only.',
                icon: '📁',
                files: [
                    { path: 'src/stdafx.h', content: STDAFX_H },
                    { path: 'src/stdafx.cpp', content: STDAFX_CPP },
                ],
                config: {
                    type: 'executable', template: 'empty',
                    sourceFiles: ['src/stdafx.cpp'],
                    defines: [],
                },
            },
            {
                id: 'hello-world',
                name: 'Minecraft Spinning Block',
                description: 'Textured rotating cube with vertex/pixel shaders and D3D9.',
                icon: '🧱',
                files: [
                    { path: 'src/stdafx.h', content: STDAFX_H },
                    { path: 'src/stdafx.cpp', content: STDAFX_CPP },
                    { path: 'src/main.cpp', content: HELLO_MAIN },
                    { path: 'Content/README.txt', content: 'Place dirt.png (or any block texture) in this folder.\nThe demo will use a procedural fallback if no texture is found.\n' },
                ],
                config: {
                    type: 'executable', template: 'hello-world',
                    sourceFiles: ['src/stdafx.cpp', 'src/main.cpp'],
                    defines: ['_XBOX'],
                },
            },
            {
                id: 'xui-app',
                name: 'XUI Application',
                description: 'Xbox 360 app with XUI-based user interface.',
                icon: '🎨',
                files: [
                    { path: 'src/stdafx.h', content: STDAFX_H + '\n// XUI\n#include <xui.h>\n' },
                    { path: 'src/stdafx.cpp', content: STDAFX_CPP },
                    { path: 'src/main.cpp', content: XUI_MAIN },
                ],
                config: {
                    type: 'executable', template: 'xui-app',
                    sourceFiles: ['src/stdafx.cpp', 'src/main.cpp'],
                    defines: ['_XBOX'],
                    libraries: ['xuiruntime.lib', 'xuirender.lib'],
                },
            },
            {
                id: 'xbla',
                name: 'XBLA Title',
                description: 'Xbox Live Arcade title with networking and achievements setup.',
                icon: '🕹️',
                files: [
                    { path: 'src/stdafx.h', content: STDAFX_H + '\n// Networking\n#include <xonline.h>\n' },
                    { path: 'src/stdafx.cpp', content: STDAFX_CPP },
                    { path: 'src/main.cpp', content: XBLA_MAIN },
                ],
                config: {
                    type: 'executable', template: 'xbla',
                    sourceFiles: ['src/stdafx.cpp', 'src/main.cpp'],
                    defines: ['_XBOX', 'XBLA_TITLE'],
                    libraries: ['xnet.lib', 'xonline.lib'],
                },
            },
            {
                id: 'dll',
                name: 'Dynamic Library (.xex)',
                description: 'Xbox 360 dynamic link library with exported functions.',
                icon: '🔗',
                files: [
                    { path: 'src/stdafx.h', content: STDAFX_H },
                    { path: 'src/stdafx.cpp', content: STDAFX_CPP },
                    { path: 'src/dllmain.cpp', content:
`#include "stdafx.h"

// ── DLL Export Macros ──
#ifdef BUILDING_DLL
#define DLL_EXPORT __declspec(dllexport)
#else
#define DLL_EXPORT __declspec(dllimport)
#endif

// ── XNotifyQueueUI (ordinal 656 from xam.xex — not in any public header) ──
typedef VOID (WINAPI *XNotifyQueueUI_t)(DWORD dwType, DWORD dwUserIndex,
                                        DWORD dwPriority, LPCWSTR pwszText,
                                        ULONGLONG qwParam);
static XNotifyQueueUI_t g_XNotifyQueueUI = NULL;

static void InitXNotify()
{
    if (g_XNotifyQueueUI != NULL) return;
    HMODULE hXam = GetModuleHandle("xam.xex");
    if (hXam)
        g_XNotifyQueueUI = (XNotifyQueueUI_t)GetProcAddress(hXam, (LPCSTR)656);
}

static void ShowNotification(const WCHAR* text)
{
    if (g_XNotifyQueueUI)
        g_XNotifyQueueUI(0, 0, 2, text, 0);
}

// ── DLL Entry Point ──
BOOL APIENTRY DllMain(HANDLE hModule, DWORD dwReason, LPVOID lpReserved)
{
    switch (dwReason) {
    case DLL_PROCESS_ATTACH:
        InitXNotify();
        ShowNotification(L"Hello Xbox! This is from NexiaIDE!");
        break;
    case DLL_PROCESS_DETACH:
        break;
    }
    return TRUE;
}

// ── Exported Functions ──
extern "C" {

DLL_EXPORT int MyLibraryInit(void)
{
    InitXNotify();
    ShowNotification(L"NexiaIDE DLL initialized!");
    return 0; // S_OK
}

DLL_EXPORT void MyLibraryShutdown(void)
{
    // Clean up resources
}

} // extern "C"
` },
                ],
                config: {
                    type: 'dll' as any, template: 'empty',
                    sourceFiles: ['src/stdafx.cpp', 'src/dllmain.cpp'],
                    defines: ['_XBOX', 'BUILDING_DLL'],
                    libraries: ['xam.lib'],
                },
            },
            {
                id: 'static-lib',
                name: 'Static Library (.lib)',
                description: 'Xbox 360 static library for reusable code modules.',
                icon: '📦',
                files: [
                    { path: 'src/stdafx.h', content: STDAFX_H },
                    { path: 'src/stdafx.cpp', content: STDAFX_CPP },
                    { path: 'include/mylib.h', content:
`#pragma once
// ── MyLib Public Header ──
// Include this header in projects that use this library.

#ifdef __cplusplus
extern "C" {
#endif

int  MyLib_Init(void);
void MyLib_Shutdown(void);
int  MyLib_DoWork(const char* input, char* output, int outputSize);

#ifdef __cplusplus
}
#endif
` },
                    { path: 'src/mylib.cpp', content:
`#include "stdafx.h"
#include "../include/mylib.h"
#include <string.h>

int MyLib_Init(void)
{
    // Initialize library state
    return 0;
}

void MyLib_Shutdown(void)
{
    // Clean up library state
}

int MyLib_DoWork(const char* input, char* output, int outputSize)
{
    if (!input || !output || outputSize <= 0) return -1;

    // Example: copy input to output (replace with real logic)
    strncpy(output, input, outputSize - 1);
    output[outputSize - 1] = '\\0';
    return 0;
}
` },
                ],
                config: {
                    type: 'library' as any, template: 'empty',
                    sourceFiles: ['src/stdafx.cpp', 'src/mylib.cpp'],
                    defines: ['_XBOX'],
                    includeDirectories: ['include'],
                },
            },
        ];
    }

    /**
     * Create a new project from a template.
     */
    async create(name: string, directory: string, templateId: string): Promise<ProjectConfig> {
        const template = this.getTemplates().find(t => t.id === templateId);
        if (!template) throw new Error(`Template '${templateId}' not found`);

        const projectDir = path.join(directory, name);

        // Create project directory structure
        fs.mkdirSync(projectDir, { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'include'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'assets'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'out'), { recursive: true });

        // Write template files
        for (const file of template.files) {
            const filePath = path.join(projectDir, file.path);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, file.content, 'utf-8');
        }

        // Create project config
        const config: ProjectConfig = {
            name,
            path: projectDir,
            type: template.config.type || 'executable',
            template: template.config.template || 'empty',
            sourceFiles: template.config.sourceFiles || [],
            includeDirectories: ['include', 'src'],
            libraryDirectories: [],
            libraries: template.config.libraries || [],
            defines: template.config.defines || [],
            configuration: 'Debug',
            pchHeader: 'stdafx.h',
        };

        // Save project file
        fs.writeFileSync(
            path.join(projectDir, PROJECT_FILE),
            JSON.stringify(config, null, 2),
            'utf-8'
        );

        this.currentProject = config;
        return config;
    }

    /**
     * Open an existing project.
     */
    async open(projectDir: string): Promise<ProjectConfig> {
        const configPath = path.join(projectDir, PROJECT_FILE);

        if (!fs.existsSync(configPath)) {
            throw new Error(`No ${PROJECT_FILE} found in ${projectDir}`);
        }

        const raw = fs.readFileSync(configPath, 'utf-8');
        const config: ProjectConfig = JSON.parse(raw);
        config.path = projectDir;

        this.currentProject = config;
        return config;
    }

    /**
     * Save the current project configuration.
     */
    async save(config?: ProjectConfig): Promise<void> {
        const project = config || this.currentProject;
        if (!project) throw new Error('No project open');

        fs.writeFileSync(
            path.join(project.path, PROJECT_FILE),
            JSON.stringify(project, null, 2),
            'utf-8'
        );

        this.currentProject = project;
    }

    /**
     * Get the file tree for the current project.
     */
    getFileTree(dirPath?: string): FileNode[] {
        const dir = dirPath || this.currentProject?.path;
        if (!dir || !fs.existsSync(dir)) return [];

        return this.readDirectory(dir);
    }

    private readDirectory(dirPath: string): FileNode[] {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const nodes: FileNode[] = [];

        // nexia.json is the project's own config: the IDE edits it through Project
        // Properties, so showing it in the tree just invites hand-editing the file
        // the IDE is actively writing. It stays on disk — only the tree hides it.
        const ignored = new Set(['node_modules', '.git', 'out', '.vs', '__pycache__', PROJECT_FILE]);

        for (const entry of entries) {
            if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
            if (ignored.has(entry.name)) continue;

            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
                nodes.push({
                    name: entry.name,
                    path: fullPath,
                    isDirectory: true,
                    children: this.readDirectory(fullPath),
                });
            } else {
                nodes.push({
                    name: entry.name,
                    path: fullPath,
                    isDirectory: false,
                    extension: path.extname(entry.name).toLowerCase(),
                });
            }
        }

        return nodes.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
        });
    }
}
