/**
 * Project Manager
 * Handles project creation from templates, loading, and saving.
 */

import { logCore } from './coreLog';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { ProjectConfig, ProjectTemplate, FileNode } from '../shared/types';

const PROJECT_FILE = 'nexia.json';

// The __PROJECT__ / __PROJECT_UPPER__ / __PROJECT_SAFE__ substitution and the
// CreateSafeName / safeFileName rules that drove it live in core/project.c now,
// proven by names-parity.js and create-parity.js. create() spawns nexia-core; the
// TypeScript that did this by hand is in _ts-backup/projectManager.ts.bak.

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

const XUI_MEDIA_README = `XUI content
===========

scene.xui  The scene: two buttons and a text element. Its ClassOverride
           property is "MyMainScene", which must keep matching the name in
           XUI_IMPLEMENT_CLASS in the .cpp — if they drift apart the framework
           builds a plain scene instead and your handlers never run.

skin.xui   Visual styles the scene's controls refer to.

xarialuni.ttf
           The default typeface. Text renders as nothing without it.

All three were copied from your Xbox 360 SDK when this project was created
(Source\\Samples\\media\\xui). Edit them with XuiTool.exe from the SDK's
bin\\win32 folder.

Building the project compiles every .xui here into a binary .xur and packs
them into media\\<Project>.xzp next to the XEX, and copies the font beside it.
Both are loaded at runtime through file://game:/media/ locators.
`;

/**
 * The DLL template's header — the wizard's root.h, DLL_APP branch.
 * Sits next to the .cpp, which includes it by name, exactly as VS lays it out.
 */
const DLL_HEADER = `// The following ifdef block is the standard way of creating macros which make exporting 
// from a DLL simpler. All files within this DLL are compiled with the __PROJECT_UPPER___EXPORTS
// symbol defined on the command line. this symbol should not be defined on any project
// that uses this DLL. This way any other project whose source files include this file see 
// __PROJECT_UPPER___API functions as being imported from a DLL, whereas this DLL sees symbols
// defined with this macro as being exported.
#ifdef __PROJECT_UPPER___EXPORTS
#define __PROJECT_UPPER___API __declspec(dllexport)
#else
#define __PROJECT_UPPER___API __declspec(dllimport)
#endif

__PROJECT_UPPER___API int fn__PROJECT_SAFE__(void);
`;

// ── Template Source Files ──

/**
 * The Xbox 360 Application template — the XDK AppWizard's own output.
 *
 * Not written by hand. This is Xbox360Wiz root.cpp with its XBOX_APP branch
 * expanded and PROJECT_NAME substituted, verified byte-for-byte against a
 * project the real wizard generated.
 *
 * What was here before was invented: an empty main() with a Sleep loop, on the
 * assumption that "Empty Project" should mean an empty program. The XDK has no
 * such template. Its wizard has three modes — XBOX_APP, DLL_APP and LIB_APP —
 * and the application one gives you this: a spinning vertex-coloured triangle
 * showing D3D init, shader compilation, a vertex buffer and a frame loop.
 */
const XBOX_APP_MAIN = `// __PROJECT__.cpp : Defines the entry point for the application.
//

#include "stdafx.h"

//-------------------------------------------------------------------------------------
// Vertex shader
// We use the register semantic here to directly define the input register
// matWVP.  Conversely, we could let the HLSL compiler decide and check the
// constant table.
//-------------------------------------------------------------------------------------
const char* g_strVertexShaderProgram = 
" float4x4 matWVP : register(c0);              "  
"                                              "  
" struct VS_IN                                 "  
" {                                            " 
"     float4 ObjPos   : POSITION;              "  // Object space position 
"     float4 Color    : COLOR;                 "  // Vertex color                 
" };                                           " 
"                                              " 
" struct VS_OUT                                " 
" {                                            " 
"     float4 ProjPos  : POSITION;              "  // Projected space position 
"     float4 Color    : COLOR;                 "  
" };                                           "  
"                                              "  
" VS_OUT main( VS_IN In )                      "  
" {                                            "  
"     VS_OUT Out;                              "  
"     Out.ProjPos = mul( matWVP, In.ObjPos );  "  // Transform vertex into
"     Out.Color = In.Color;                    "  // Projected space and 
"     return Out;                              "  // Transfer color
" }                                            ";

//-------------------------------------------------------------------------------------
// Pixel shader
//-------------------------------------------------------------------------------------
const char* g_strPixelShaderProgram = 
" struct PS_IN                                 "
" {                                            "
"     float4 Color : COLOR;                    "  // Interpolated color from                      
" };                                           "  // the vertex shader
"                                              "  
" float4 main( PS_IN In ) : COLOR              "  
" {                                            "  
"     return In.Color;                         "  // Output color
" }                                            "; 

//-------------------------------------------------------------------------------------
// Structure to hold vertex data.
//-------------------------------------------------------------------------------------
struct COLORVERTEX
{
    float       Position[3];
    DWORD       Color;
};

//-------------------------------------------------------------------------------------
// Time             Since fAppTime is a float, we need to keep the quadword app time 
//                  as a LARGE_INTEGER so that we don't lose precision after running
//                  for a long time.
//-------------------------------------------------------------------------------------
struct TimeInfo
{    
    LARGE_INTEGER qwTime;    
    LARGE_INTEGER qwAppTime;   

    float fAppTime;    
    float fElapsedTime;    

    float fSecsPerTick;    
};

//-------------------------------------------------------------------------------------
// Global variables
//-------------------------------------------------------------------------------------
D3DDevice*             g_pd3dDevice;    // Our rendering device
D3DVertexBuffer*       g_pVB;           // Buffer to hold vertices
D3DVertexDeclaration*  g_pVertexDecl;   // Vertex format decl
D3DVertexShader*       g_pVertexShader; // Vertex Shader
D3DPixelShader*        g_pPixelShader;  // Pixel Shader

XMMATRIX g_matWorld;
XMMATRIX g_matProj;
XMMATRIX g_matView;

TimeInfo g_Time;

BOOL g_bWidescreen = TRUE;

//-------------------------------------------------------------------------------------
// Name: InitTime()
// Desc: Initializes the timer variables
//-------------------------------------------------------------------------------------
void InitTime()
{    

    // Get the frequency of the timer
    LARGE_INTEGER qwTicksPerSec;
    QueryPerformanceFrequency( &qwTicksPerSec );
    g_Time.fSecsPerTick = 1.0f / (float)qwTicksPerSec.QuadPart;

    // Save the start time
    QueryPerformanceCounter( &g_Time.qwTime );
    
    // Zero out the elapsed and total time
    g_Time.qwAppTime.QuadPart = 0;
    g_Time.fAppTime = 0.0f; 
    g_Time.fElapsedTime = 0.0f;    
}


//-------------------------------------------------------------------------------------
// Name: InitD3D()
// Desc: Initializes Direct3D
//-------------------------------------------------------------------------------------
HRESULT InitD3D()
{
    // Create the D3D object.
    Direct3D* pD3D = Direct3DCreate9( D3D_SDK_VERSION );
    if( !pD3D )
        return E_FAIL;

    // Set up the structure used to create the D3DDevice.
    D3DPRESENT_PARAMETERS d3dpp; 
    ZeroMemory( &d3dpp, sizeof(d3dpp) );
    XVIDEO_MODE VideoMode;
    XGetVideoMode( &VideoMode );
    g_bWidescreen = VideoMode.fIsWideScreen;
    d3dpp.BackBufferWidth        = min( VideoMode.dwDisplayWidth, 1280 );
    d3dpp.BackBufferHeight       = min( VideoMode.dwDisplayHeight, 720 );
    d3dpp.BackBufferFormat       = D3DFMT_X8R8G8B8;
    d3dpp.BackBufferCount        = 1;
    d3dpp.EnableAutoDepthStencil = TRUE;
    d3dpp.AutoDepthStencilFormat = D3DFMT_D24S8;
    d3dpp.SwapEffect             = D3DSWAPEFFECT_DISCARD;
    d3dpp.PresentationInterval   = D3DPRESENT_INTERVAL_ONE;

    // Create the Direct3D device.
    if( FAILED( pD3D->CreateDevice( 0, D3DDEVTYPE_HAL, NULL,
                                    D3DCREATE_HARDWARE_VERTEXPROCESSING,
                                    &d3dpp, &g_pd3dDevice ) ) )
        return E_FAIL;

    return S_OK;
}


//-------------------------------------------------------------------------------------
// Name: InitScene()
// Desc: Creates the scene.  First we compile our shaders. For the final version
//       of a game, you should store the shaders in binary form; don't call 
//       D3DXCompileShader at runtime. Next, we declare the format of our 
//       vertices, and then create a vertex buffer. The vertex buffer is basically
//       just a chunk of memory that holds vertices. After creating it, we must 
//       Lock()/Unlock() it to fill it. Finally, we set up our world, projection,
//       and view matrices.
//-------------------------------------------------------------------------------------
HRESULT InitScene()
{
    // Compile vertex shader.
    ID3DXBuffer* pVertexShaderCode;
    ID3DXBuffer* pVertexErrorMsg;
    HRESULT hr = D3DXCompileShader( g_strVertexShaderProgram, 
                                    (UINT)strlen( g_strVertexShaderProgram ),
                                    NULL, 
                                    NULL, 
                                    "main", 
                                    "vs_2_0", 
                                    0, 
                                    &pVertexShaderCode, 
                                    &pVertexErrorMsg, 
                                    NULL );
    if( FAILED(hr) )
    {
        if( pVertexErrorMsg )
            OutputDebugString( (char*)pVertexErrorMsg->GetBufferPointer() );
        return E_FAIL;
    }    

    // Create vertex shader.
    g_pd3dDevice->CreateVertexShader( (DWORD*)pVertexShaderCode->GetBufferPointer(), 
                                      &g_pVertexShader );

    // Compile pixel shader.
    ID3DXBuffer* pPixelShaderCode;
    ID3DXBuffer* pPixelErrorMsg;
    hr = D3DXCompileShader( g_strPixelShaderProgram, 
                            (UINT)strlen( g_strPixelShaderProgram ),
                            NULL, 
                            NULL, 
                            "main", 
                            "ps_2_0", 
                            0, 
                            &pPixelShaderCode, 
                            &pPixelErrorMsg,
                            NULL );
    if( FAILED(hr) )
    {
        if( pPixelErrorMsg )
            OutputDebugString( (char*)pPixelErrorMsg->GetBufferPointer() );
        return E_FAIL;
    }

    // Create pixel shader.
    g_pd3dDevice->CreatePixelShader( (DWORD*)pPixelShaderCode->GetBufferPointer(), 
                                     &g_pPixelShader );
    
    // Define the vertex elements and
    // Create a vertex declaration from the element descriptions.
    D3DVERTEXELEMENT9 VertexElements[3] =
    {
        { 0,  0, D3DDECLTYPE_FLOAT3, D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_POSITION, 0 },
        { 0, 12, D3DDECLTYPE_D3DCOLOR, D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_COLOR, 0 },
        D3DDECL_END()
    };
    g_pd3dDevice->CreateVertexDeclaration( VertexElements, &g_pVertexDecl );

    // Create the vertex buffer. Here we are allocating enough memory
    // (from the default pool) to hold all our 3 custom vertices. 
    if( FAILED( g_pd3dDevice->CreateVertexBuffer( 3*sizeof(COLORVERTEX),
                                                  D3DUSAGE_WRITEONLY, 
                                                  NULL,
                                                  D3DPOOL_MANAGED, 
                                                  &g_pVB, 
                                                  NULL ) ) )
        return E_FAIL;

    // Now we fill the vertex buffer. To do this, we need to Lock() the VB to
    // gain access to the vertices. This mechanism is required because the
    // vertex buffer may still be in use by the GPU. This can happen if the
    // CPU gets ahead of the GPU. The GPU could still be rendering the previous
    // frame.
    COLORVERTEX g_Vertices[] =
    {
        {  0.0f, -1.1547f, 0.0f, 0xffff0000 }, // x, y, z, color
        { -1.0f,  0.5777f, 0.0f, 0xff00ff00 },
        {  1.0f,  0.5777f, 0.0f, 0xffffff00 },
    };

    COLORVERTEX* pVertices;
    if( FAILED( g_pVB->Lock( 0, 0, (void**)&pVertices, 0 ) ) )
        return E_FAIL;
    memcpy( pVertices, g_Vertices, 3*sizeof(COLORVERTEX) );
    g_pVB->Unlock();

    // Initialize the world matrix
    g_matWorld = XMMatrixIdentity();

    // Initialize the projection matrix
    FLOAT fAspect = ( g_bWidescreen ) ? (16.0f / 9.0f) : (4.0f / 3.0f); 
    g_matProj = XMMatrixPerspectiveFovLH( XM_PIDIV4, fAspect, 1.0f, 200.0f );

    // Initialize the view matrix
    XMVECTOR vEyePt    = { 0.0f, 0.0f,-7.0f, 0.0f };
    XMVECTOR vLookatPt = { 0.0f, 0.0f, 0.0f, 0.0f };
    XMVECTOR vUp       = { 0.0f, 1.0f, 0.0f, 0.0f };
    g_matView = XMMatrixLookAtLH( vEyePt, vLookatPt, vUp );

    return S_OK;
}


//-------------------------------------------------------------------------------------
// Name: UpdateTime()
// Desc: Updates the elapsed time since our last frame.
//-------------------------------------------------------------------------------------
void UpdateTime()
{
    LARGE_INTEGER qwNewTime;
    LARGE_INTEGER qwDeltaTime;
    
    QueryPerformanceCounter( &qwNewTime );    
    qwDeltaTime.QuadPart = qwNewTime.QuadPart - g_Time.qwTime.QuadPart;

    g_Time.qwAppTime.QuadPart += qwDeltaTime.QuadPart;    
    g_Time.qwTime.QuadPart     = qwNewTime.QuadPart;
    
    g_Time.fElapsedTime      = g_Time.fSecsPerTick * ((FLOAT)(qwDeltaTime.QuadPart));
    g_Time.fAppTime          = g_Time.fSecsPerTick * ((FLOAT)(g_Time.qwAppTime.QuadPart));    
}


//-------------------------------------------------------------------------------------
// Name: Update()
// Desc: Updates the world for the next frame
//-------------------------------------------------------------------------------------
void Update()
{
    // Set the world matrix
    float fAngle = fmodf( -g_Time.fAppTime, XM_2PI );
    static const XMVECTOR vAxisZ = { 0, 0, 1.0f, 0 };
    g_matWorld = XMMatrixRotationAxis( vAxisZ, fAngle );
}


//-------------------------------------------------------------------------------------
// Name: Render()
// Desc: Draws the scene
//-------------------------------------------------------------------------------------
void Render()
{
    // Clear the backbuffer to a blue color
    g_pd3dDevice->Clear( 0L, NULL, D3DCLEAR_TARGET|D3DCLEAR_ZBUFFER|D3DCLEAR_STENCIL, 
                         D3DCOLOR_XRGB(0,0,255), 1.0f, 0L );

    // Draw the triangles in the vertex buffer. This is broken into a few steps:
    
    // We are passing the vertices down a "stream", so first we need
    // to specify the source of that stream, which is our vertex buffer. 
    // Then we need to let D3D know what vertex and pixel shaders to use. 
    g_pd3dDevice->SetVertexDeclaration( g_pVertexDecl );
    g_pd3dDevice->SetStreamSource( 0, g_pVB, 0, sizeof(COLORVERTEX) );
    g_pd3dDevice->SetVertexShader( g_pVertexShader );
    g_pd3dDevice->SetPixelShader( g_pPixelShader );
   
    // Build the world-view-projection matrix and pass it into the vertex shader
    XMMATRIX matWVP = g_matWorld * g_matView * g_matProj;
    g_pd3dDevice->SetVertexShaderConstantF( 0, (FLOAT*)&matWVP, 4 );

    // Draw the vertices in the vertex buffer
    g_pd3dDevice->DrawPrimitive( D3DPT_TRIANGLELIST, 0, 1 );

    // Present the backbuffer contents to the display
    g_pd3dDevice->Present( NULL, NULL, NULL, NULL );
}


//-------------------------------------------------------------------------------------
// Name: main()
// Desc: The application's entry point
//-------------------------------------------------------------------------------------
void __cdecl main()
{
    // Initialize Direct3D
    if( FAILED( InitD3D() ) )
        return;

    // Initialize the vertex buffer
    if( FAILED( InitScene() ) )
        return;

    InitTime();

    for(;;) // loop forever
    {
        // What time is it?
        UpdateTime();
        // Update the world
        Update();   
        // Render the scene
        Render();
    }
}
`;

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
// Missing-texture fill: a magenta face with a black border, per texel. Magenta
// is the classic "texture missing" signal; the black border frames every face so
// the cube's edges read as solid black bars where faces meet, instead of a flat
// magenta blob with no visible structure.
//
// Used with D3DXFillTexture so the Xbox 360's tiled/swizzled texture memory is
// written correctly — a manual LockRect fills the linear staging in the wrong
// order and the tiling shows through as coloured stripes. pTexCoord is the 0..1
// position across the face; output is RGBA.
//-------------------------------------------------------------------------------------
static VOID WINAPI FillFallbackTexture(D3DXVECTOR4* pOut, const D3DXVECTOR2* pTexCoord,
                                       const D3DXVECTOR2* pTexelSize, LPVOID pData) {
    (void)pTexelSize; (void)pData;
    const float border = 0.10f; // black frame width, as a fraction of the face
    if (pTexCoord->x < border || pTexCoord->x > 1.0f - border ||
        pTexCoord->y < border || pTexCoord->y > 1.0f - border) {
        *pOut = D3DXVECTOR4(0.0f, 0.0f, 0.0f, 1.0f); // black edge bar
    } else {
        *pOut = D3DXVECTOR4(1.0f, 0.0f, 1.0f, 1.0f); // magenta face
    }
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
        sprintf(buf, "Texture not found: game:\\\\Content\\\\dirt.png (HRESULT: 0x%08X). Using magenta fallback.\\n", hr);
        OutputDebugStringA(buf);
        // Fallback: a solid magenta texture — the classic "missing texture"
        // signal, so a build with no dirt.png in Content\\ is obvious on screen
        // instead of silently wrong. Filled via D3DXFillTexture, which writes
        // through the Xbox 360's texture tiling correctly; a manual LockRect
        // fills the linear staging in the wrong order and the tiling leaks
        // through as coloured stripes. Guarded so a failed create is just an
        // untextured (not crashing) cube.
        // 64x64 (not 4x4) so the black border is a clean thin frame rather than
        // a quarter of the face.
        g_pTexture = NULL;
        if (SUCCEEDED(g_pd3dDevice->CreateTexture(64, 64, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT, &g_pTexture, NULL)) && g_pTexture) {
            D3DXFillTexture(g_pTexture, FillFallbackTexture, NULL);
        }
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

/**
 * The XUI template's entry point.
 *
 * Modelled directly on the XDK's own XuiTutorial sample
 * (Source\Samples\ui\XuiTutorial), because the version this replaces was
 * invented. It called XuiRenderInitShared with a TypefaceDescriptor where a
 * texture loader goes, passed a D3DDevice* where an HXUIDC belongs, and called
 * XuiRenderSetWorld, which does not exist at all. It had never once compiled.
 *
 * The real framework does not want a hand-written render loop: CXuiModule::Run
 * owns the frame — timers, input, render, present — and the application only
 * supplies scene classes and a message map.
 *
 * No ATG::MediaLocator, unlike the sample. That class exists to scan the
 * archive at runtime for the prefix xuipkg baked into it, which is only
 * necessary because the sample packs its scenes with '..\..\media\xui\' paths.
 * Nexia runs xuipkg from the project's Media folder, so entries are named
 * 'xui\scene.xur' and the locators below are constants.
 *
 * Backslashes are not a style choice: xuipkg rejects forward-slash inputs
 * outright ("file(s) not found"), so the paths it stores always use them.
 */
const XUI_MAIN = `/**
 * __PROJECT__.cpp — XUI application entry point.
 */

#include "stdafx.h"
#include <xui.h>
#include <xuiapp.h>

//--------------------------------------------------------------------------------------
// Where the scenes live at runtime.
//
// The build packs the project's Media xui folder into media/__PROJECT__.xzp
// beside the XEX, keeping the "xui" prefix on each entry. '#' separates the
// archive from the path within it. The separator inside the archive is a
// backslash because xuipkg refuses forward-slash inputs.
//--------------------------------------------------------------------------------------
#define SCENE_PACKAGE  L"file://game:/media/__PROJECT__.xzp"
#define SKIN_LOCATOR   SCENE_PACKAGE L"#xui\\\\skin.xur"
#define SCENE_PATH     SCENE_PACKAGE L"#xui\\\\"
#define FONT_LOCATOR   L"file://game:/media/xarialuni.ttf"

//--------------------------------------------------------------------------------------
// Scene class.
//
// The name in XUI_IMPLEMENT_CLASS must match the ClassOverride property on the
// scene in scene.xui. If they disagree the framework quietly builds a plain
// scene instead and none of the handlers below ever run.
//--------------------------------------------------------------------------------------
class CMyMainScene : public CXuiSceneImpl
{
protected:
    CXuiControl     m_button1;
    CXuiControl     m_button2;
    CXuiTextElement m_text1;

    XUI_BEGIN_MSG_MAP()
        XUI_ON_XM_INIT( OnInit )
        XUI_ON_XM_NOTIFY_PRESS( OnNotifyPress )
    XUI_END_MSG_MAP()

    // Look the controls up once, by the Id each is given in scene.xui.
    HRESULT OnInit( XUIMessageInit* pInitData, BOOL& bHandled )
    {
        GetChildById( L"XuiButton1", &m_button1 );
        GetChildById( L"XuiButton2", &m_button2 );
        GetChildById( L"XuiText1", &m_text1 );
        return S_OK;
    }

    HRESULT OnNotifyPress( HXUIOBJ hObjPressed, BOOL& bHandled )
    {
        if( hObjPressed == m_button1 )
            m_text1.SetText( L"One" );
        else if( hObjPressed == m_button2 )
            m_text1.SetText( L"Two" );
        else
            return S_OK;

        bHandled = TRUE;
        return S_OK;
    }

public:
    XUI_IMPLEMENT_CLASS( CMyMainScene, L"MyMainScene", XUI_CLASS_SCENE )
};

//--------------------------------------------------------------------------------------
// Application host. Registers scene classes; CXuiModule does everything else.
//--------------------------------------------------------------------------------------
class CMyApp : public CXuiModule
{
protected:
    virtual HRESULT RegisterXuiClasses()
    {
        return CMyMainScene::Register();
    }

    virtual HRESULT UnregisterXuiClasses()
    {
        CMyMainScene::Unregister();
        return S_OK;
    }
};

//--------------------------------------------------------------------------------------
// Entry point.
//--------------------------------------------------------------------------------------
VOID __cdecl main()
{
    CMyApp app;

    // Init creates the D3D device and the XUI render context. Do not create a
    // device before this — CXuiModule owns it.
    HRESULT hr = app.Init( XuiD3DXTextureLoader );
    if( FAILED( hr ) )
    {
        OutputDebugString( "XUI: Init failed.\\n" );
        return;
    }

    // Without a registered typeface, text renders as nothing at all.
    hr = app.RegisterDefaultTypeface( L"Arial Unicode MS", FONT_LOCATOR );
    if( FAILED( hr ) )
    {
        OutputDebugString( "XUI: could not register the default typeface.\\n" );
        app.Uninit();
        return;
    }

    // Skin first: it defines the visuals the scene's controls refer to.
    hr = app.LoadSkin( SKIN_LOCATOR );
    if( FAILED( hr ) )
    {
        OutputDebugString( "XUI: could not load skin.xur.\\n" );
        app.Uninit();
        return;
    }

    hr = app.LoadFirstScene( SCENE_PATH, L"scene.xur", NULL );
    if( FAILED( hr ) )
    {
        OutputDebugString( "XUI: could not load scene.xur.\\n" );
        app.Uninit();
        return;
    }

    // Owns the frame loop; returns when the application exits.
    app.Run();

    app.Uninit();
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

    /**
     * Optional, and only used to resolve a template's sdkFiles. Passing it is
     * what lets the XUI template copy its scene, skin and font out of the
     * user's install; without it, templates that declare sdkFiles refuse to be
     * created rather than producing a project that cannot build.
     */
    constructor(private toolchain?: { getPaths(): { root: string } | null }) {}

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
                // "Xbox 360 Application", which is what the XDK's own wizard
                // calls this and what it actually is. It was "Empty Project",
                // which promised something the XDK has no template for and set
                // the expectation that the file would be blank.
                name: 'Xbox 360 Application',
                description: 'The XDK wizard\'s starting point: a spinning triangle, D3D set up and running.',
                icon: '📁',
                files: [
                    { path: 'src/stdafx.h', content: STDAFX_H },
                    { path: 'src/stdafx.cpp', content: STDAFX_CPP },
                    { path: 'src/__PROJECT__.cpp', content: XBOX_APP_MAIN },
                ],
                config: {
                    type: 'executable', template: 'empty',
                    sourceFiles: ['src/stdafx.cpp', 'src/__PROJECT__.cpp'],
                    defines: ['_XBOX'],
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
                    { path: 'src/__PROJECT__.cpp', content: HELLO_MAIN },
                    { path: 'Content/README.txt', content: 'Place dirt.png (or any block texture) in this folder.\nThe demo will use a procedural fallback if no texture is found.\n' },
                ],
                config: {
                    type: 'executable', template: 'hello-world',
                    sourceFiles: ['src/stdafx.cpp', 'src/__PROJECT__.cpp'],
                    defines: ['_XBOX'],
                },
            },
            {
                id: 'xui-app',
                name: 'XUI Application',
                description: 'Buttons and text driven by a XUI scene, packaged for the console.',
                icon: '🎨',
                files: [
                    { path: 'src/stdafx.h', content: STDAFX_H + '\n// XUI\n#include <xui.h>\n#include <xuiapp.h>\n' },
                    { path: 'src/stdafx.cpp', content: STDAFX_CPP },
                    { path: 'src/__PROJECT__.cpp', content: XUI_MAIN },
                    { path: 'Media/xui/README.txt', content: XUI_MEDIA_README },
                ],
                // The scene, its skin and the font come from the user's own XDK.
                // The skin is 424 KB of generated XML and the font is 6.6 MB;
                // neither belongs in this repo, and both are already present on
                // any machine that can build for the Xbox 360.
                sdkFiles: [
                    { from: 'Source/Samples/media/xui/simple_scene.xui', to: 'Media/xui/scene.xui' },
                    { from: 'Source/Samples/media/xui/simple_scene_skin.xui', to: 'Media/xui/skin.xui' },
                    { from: 'Source/Samples/media/xui/xarialuni.ttf', to: 'Media/xui/xarialuni.ttf' },
                ],
                config: {
                    type: 'executable', template: 'xui-app',
                    sourceFiles: ['src/stdafx.cpp', 'src/__PROJECT__.cpp'],
                    defines: ['_XBOX'],
                    // XUI's libraries are per-configuration, and the flat list
                    // that was here named xuiruntime.lib, which does not exist
                    // in the XDK under any configuration — the runtime is
                    // xuirun.lib. Every name below was checked against lib\xbox.
                    // The base libraries (d3d9, xapilib, …) come from the build
                    // system's own per-configuration table, so only the
                    // XUI-specific ones are listed.
                    configurations: {
                        Debug:        { libraries: ['xuirund.lib', 'xuirenderd.lib', 'xmediad2.lib'] },
                        Profile:      { libraries: ['xuirun.lib', 'xuirender.lib', 'xmedia2.lib'] },
                        Release:      { libraries: ['xuirun.lib', 'xuirender.lib', 'xmedia2.lib'] },
                        Release_LTCG: { libraries: ['xuirunltcg.lib', 'xuirenderltcg.lib', 'xmedia2.lib'] },
                    },
                    // Compiled by xuipkg at build time into <OutDir>\media.
                    xuiContent: {
                        package: '__PROJECT__.xzp',
                        scenes: ['xui\\scene.xui', 'xui\\skin.xui'],
                        copy: ['xui\\xarialuni.ttf'],
                    },
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
                    { path: 'src/__PROJECT__.cpp', content: XBLA_MAIN },
                ],
                config: {
                    type: 'executable', template: 'xbla',
                    sourceFiles: ['src/stdafx.cpp', 'src/__PROJECT__.cpp'],
                    defines: ['_XBOX', 'XBLA_TITLE'],
                    libraries: ['xnet.lib', 'xonline.lib'],
                },
            },
            {
                id: 'dll',
                name: 'Dynamic Library (.xex)',
                description: 'The XDK wizard\'s DLL: an entry point and one exported function.',
                icon: '🔗',
                files: [
                    { path: 'src/stdafx.h', content: STDAFX_H },
                    { path: 'src/stdafx.cpp', content: STDAFX_CPP },
                    // The header goes beside the .cpp, which includes it by
                    // name — the layout Templates.inf gives a DLL_APP project.
                    { path: 'src/__PROJECT__.h', content: DLL_HEADER },
                    { path: 'src/__PROJECT__.cpp', content:
`// __PROJECT__.cpp : Defines the entry point for the DLL application.
//

#include "stdafx.h"
#include "__PROJECT__.h"

BOOL APIENTRY DllMain( HANDLE hModule, 
                       DWORD  ul_reason_for_call, 
                       LPVOID lpReserved
                     )
{
    return TRUE;
}

// This is an example of an exported function.
__PROJECT_UPPER___API int fn__PROJECT_SAFE__(void)
{
	return 42;
}
` },
                ],
                config: {
                    type: 'dll', template: 'dll',
                    sourceFiles: ['src/stdafx.cpp', 'src/__PROJECT__.cpp'],
                    // <PROJECT>_EXPORTS, not BUILDING_DLL. The wizard's header
                    // keys its export macro off this exact name, and it is
                    // per-project on purpose: a title that links two DLLs would
                    // otherwise define one shared symbol and flip both headers
                    // to dllexport, in a project that exports neither.
                    defines: ['_XBOX', '__PROJECT_UPPER___EXPORTS'],
                    // No xam.lib. There is no such import library in the XDK —
                    // linking one made every DLL project fail with LNK1181
                    // before a line of user code was written.
                    libraries: [],
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
                    { path: 'include/__PROJECT__.h', content:
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
                    { path: 'src/__PROJECT__.cpp', content:
`#include "stdafx.h"
#include "../include/__PROJECT__.h"
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
                    type: 'library', template: 'static-lib',
                    sourceFiles: ['src/stdafx.cpp', 'src/__PROJECT__.cpp'],
                    defines: ['_XBOX'],
                    includeDirectories: ['include'],
                },
            },
        ];
    }

    /**
     * Run a nexia-core `project` command and return its parsed JSON.
     *
     * nexia-core reports a refusal as {ok:false,error} on stdout and exits
     * non-zero, so the error arrives where execFileSync throws — the stdout on
     * the thrown error is the answer, not noise. A genuinely broken spawn (the
     * binary missing) has no stdout, and that rethrows.
     */
    private core(args: string[]): any {
        const exe = path.join(__dirname, '..', 'nexia-core.exe');
        const t0 = Date.now();
        let out: string;
        try {
            out = execFileSync(exe, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
        } catch (err: any) {
            out = err?.stdout?.toString() || '';
            logCore(args, t0, err);
            if (!out) throw err;
        }
        logCore(args, t0, undefined, out);
        const res = JSON.parse(out);
        if (!res.ok) throw new Error(res.error || 'nexia-core refused the request');
        return res;
    }

    /**
     * Create a new project from a template.
     *
     * The whole of this — the template table, the token substitution, the
     * sdkFiles copy out of the user's XDK, refusing a non-empty folder, and
     * writing nexia.json — is core/project.c now, proven byte-identical by
     * create-parity.js. What was ~145 lines of TypeScript is the spawn below;
     * the old body is in _ts-backup/projectManager.ts.bak, and the C's message
     * for a missing SDK asset or an occupied directory is the same string this
     * used to throw.
     */
    async create(name: string, directory: string, templateId: string): Promise<ProjectConfig> {
        const args = ['project', 'create', name, directory, templateId];
        const sdk = this.toolchain?.getPaths();
        if (sdk?.root) args.push('--sdk', sdk.root);
        const res = this.core(args);
        // open() reads the nexia.json the C just wrote, sets currentProject and
        // returns the config — so create composes from open rather than parsing
        // the file a second way.
        return this.open(res.path);
    }

    /**
     * Open an existing project.
     *
     * core/project.c reads the nexia.json, overrides `path` with where the
     * project was actually found (so a moved project still opens) and hands back
     * the whole config — every field, including the ones Project Properties and
     * the VS importer stored that nothing here names. The missing-file message is
     * the same string this used to throw. Proven by create-parity.js.
     */
    async open(projectDir: string): Promise<ProjectConfig> {
        const config: ProjectConfig = this.core(['project', 'open', projectDir]).project;
        this.currentProject = config;
        return config;
    }

    /**
     * Save the current project configuration.
     *
     * Left as JSON.stringify deliberately, not routed through `nexia-core project
     * save`. The C writer (jv_write) is proven byte-identical to this exact call,
     * so it would produce the same nexia.json — but only after this serialised
     * the object to a temp file for the C to read and rewrite, two serialisations
     * for one result. The C save earns its place when the config lives in C
     * rather than in this process; while a JS object holds it, this is the same
     * bytes with none of the round trip.
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
        if (!dir) return [];
        // nexia-core walks it with FindFirstFile and sorts with CompareStringW,
        // which is what localeCompare did here — "Ä" beside "A", not after "Z".
        //
        // This costs a process spawn the in-process scan did not: ~35 ms more on
        // a 4,835-node tree, which is a third of a blink and larger than any real
        // project. Not perceptible, and not a reason to keep a second
        // implementation of the ignore rules and the sort alive in another
        // language.
        try {
            const core = path.join(__dirname, '..', 'nexia-core.exe');
            const res = JSON.parse(execFileSync(core, ['project', 'tree', dir],
                { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 }));
            return res.tree || [];
        } catch {
            // An unreadable or absent directory is an empty tree, as before: the
            // IDE asks for one before a project is open.
            return [];
        }
    }


}
