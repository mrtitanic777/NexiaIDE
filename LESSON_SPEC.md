# `.lesson` Package Specification — v2

> The `.lesson` package is the **single source of truth** for a cinematic lesson.
> The engine is a dumb executor. It reads and renders. No defaults, no fallbacks, no opinions.
> If the lesson doesn't look right, it's the package's fault, not the engine's.

## Package Structure

A `.lesson` package is a **directory** (zipped as `.lesson` for distribution):

```
initd3d.lesson/
├── lesson.json              # Manifest — everything the engine needs
├── thumbnail.png            # Preview image (shown in lesson browser)
├── assets/                  # Audio, images, supplementary files
│   ├── narration-includes.mp3
│   ├── narration-device.mp3
│   └── logo.png
└── visualizers/             # Canvas rendering code (sandboxed JS)
    ├── blocks.js            # Block-level visualizer functions
    └── tokens.js            # Token-level visualizer functions
```

## `lesson.json` — Full Schema

```jsonc
{
  // ─── FORMAT IDENTIFIER ───
  "format": "nexia-lesson-v2",

  // ─── METADATA ───
  "meta": {
    "id": "initd3d",                          // Unique identifier
    "title": "Xbox 360 Direct3D Initialization",
    "author": "Nexia IDE",
    "version": "1.0.0",
    "description": "Learn how to initialize Direct3D on the Xbox 360.",
    "difficulty": "beginner",                  // beginner | intermediate | advanced
    "duration": 8,                             // Estimated minutes
    "prerequisites": [],                       // Lesson IDs that should be completed first
    "tags": ["xbox360", "d3d", "graphics"],
    "thumbnail": "thumbnail.png",              // Relative path within package
    "created": "2025-03-05T00:00:00Z",
    "updated": "2025-03-05T00:00:00Z"
  },

  // ─── SYNTAX HIGHLIGHTING ───
  // The package defines ALL syntax rules. The engine has no built-in language knowledge.
  "syntax": {
    "keywords": ["void", "return", "if", "else", "for", "while", "struct", "const",
                 "static", "true", "false", "nullptr", "TRUE", "FALSE"],
    "types": ["int", "float", "double", "char", "bool", "HRESULT", "DWORD",
              "IDirect3D9", "IDirect3DDevice9", "D3DPRESENT_PARAMETERS"],
    "directives": ["#include", "#define"],
    "semantics": ["POSITION", "TEXCOORD0", "COLOR", "SV_POSITION"],
    "macroPrefixes": ["D3D", "SCREEN", "E_"],
    "lineComment": "//",
    "stringDelim": "\"",
    "colors": {
      "keyword":   "#c678dd",
      "type":      "#61afef",
      "function":  "#56d4f5",
      "directive": "#e06c75",
      "string":    "#98c379",
      "number":    "#d19a66",
      "comment":   "#5c6370",
      "macro":     "#e5c07b",
      "semantic":  "#e5c07b",
      "text":      "#c8c8d0"
    }
  },

  // ─── ERASE PHASE ───
  // What the "old code" looks like before the cinematic replaces it.
  // If null/empty, the erase phase is skipped entirely.
  "erasePhase": {
    "lines": [
      "// TODO: Initialize Direct3D",
      "// Setup D3D device here...",
      ""
    ],
    "timing": {
      "lineAppearDelay": 80,       // ms between each old line appearing
      "swipePause": 500,           // ms before the swipe-away effect
      "removePause": 120,          // ms between each line being removed
      "settlePause": 400           // ms after all lines removed before typing starts
    }
  },

  // ─── CODE BLOCKS ───
  // The actual code content. Each block is a logical section.
  // Blocks are rendered in order. The engine types each line character by character.
  "blocks": [
    {
      "id": "includes",
      "section": "Includes & Headers",        // Section divider text (null = no divider)
      "lines": [
        {
          "text": "#include <xtl.h>",
          "confidence": 0.95,                 // 0-1, low = thinking dots before typing
          "type": "dir",                      // Token flash type: fn|ty|se|dir|vr|null
          "blockEnd": false                   // Triggers block-complete sound
        },
        {
          "text": "#include <xgraphics.h>",
          "confidence": 0.9,
          "type": "dir",
          "blockEnd": true
        }
      ]
    }
    // ... more blocks
  ],

  // ─── OVERLAY ───
  // ALL teaching content, keyed by block ID.
  // Completely separate from the code — this is the "lesson" layer on top.
  "overlay": {
    // Explanation panels shown after a block finishes typing
    "explanations": {
      "includes": {
        "label": "Xbox Headers",
        "type": "concept",                    // concept|api|pattern|warn — determines dot color
        "description": "<p>These headers provide the Xbox 360 API surface...</p>",
        "narration": "assets/narration-includes.mp3"    // Optional audio file
      }
    },

    // Arrows connecting related code sections
    "connections": {
      "includes": [
        {
          "src": [0, 1],                      // Source line indices (within block)
          "dst": [5, 6],                      // Destination line indices (global)
          "label": "used by →",
          "description": "These headers provide the types used in the device creation block."
        }
      ]
    },

    // Token-by-token explanations within a block
    "tokens": {
      "includes": [
        {
          "line": 0,                          // Line offset within this block
          "tokens": [
            {
              "text": "xtl.h",
              "description": "The master Xbox 360 header. Replaces windows.h on Xbox."
            },
            {
              "text": "#include",
              "description": "C++ preprocessor directive — inserts the contents of another file."
            }
          ]
        }
      ]
    },

    // Canvas visualizers per block
    "visualizers": {
      "includes": {
        "source": "visualizers/blocks.js",    // JS file in the package
        "function": "renderIncludes",         // Exported function name
        "animated": false,                    // true = re-renders every frame via RAF
        "controls": [                         // Interactive sliders/checkboxes
          {
            "key": "showBytes",
            "label": "Show Byte Sizes",
            "type": "checkbox",
            "default": false
          },
          {
            "key": "zoom",
            "label": "Zoom",
            "type": "range",
            "min": 1,
            "max": 4,
            "default": 1
          }
        ]
      }
    },

    // Canvas visualizers per token text
    "tokenVisualizers": {
      "xtl.h": {
        "source": "visualizers/tokens.js",
        "function": "renderXtlHeader"
      }
    }
  },

  // ─── LAYOUT ───
  // Exact pixel positions for everything. The engine places elements HERE, period.
  // If a block has no layout entry, the engine does NOT render its spotlight/panel.
  "layout": {
    "canvas": { "width": 900, "height": 600 },

    "blocks": {
      "includes": {
        "spotlight": { "x": 54, "y": 12, "width": 380, "height": 56 },
        "panel":     { "x": 500, "y": 10, "width": 360, "height": 280 }
      }
    },

    "tokens": {
      "includes": [
        {
          "spotlight": { "x": 70, "y": 14, "width": 80, "height": 22 },
          "panel":     { "x": 500, "y": 14, "width": 300, "height": 160 }
        }
      ]
    },

    "connections": {
      "includes": [
        {
          "srcSpotlight": { "x": 54, "y": 12, "width": 380, "height": 56 },
          "dstSpotlight": { "x": 54, "y": 140, "width": 380, "height": 80 }
        }
      ]
    }
  },

  // ─── TIMING ───
  // All animation timing values. The engine uses ONLY these numbers.
  "timing": {
    "typing": {
      "charDelayBase": 22,         // ms base delay per character
      "charDelayJitter": 14,       // ms random jitter added to base
      "spaceDelay": 10,            // ms delay for space/tab characters
      "punctDelay": 30,            // ms delay for punctuation: {}();,
      "punctChars": "{}();,",      // Which characters count as punctuation
      "lowConfidenceMultiplier": 1.4,  // Typing speed multiplier when confidence < threshold
      "lowConfidenceThreshold": 0.8    // Confidence below this triggers slow typing
    },
    "pauses": {
      "interLine": 80,             // ms between lines within a block
      "emptyLine": 40,             // ms for blank lines
      "thinkDotsLong": 800,        // ms for thinking dots (low confidence)
      "thinkDotsShort": 500,       // ms for thinking dots (medium confidence)
      "thinkDotsThreshold": 0.75,  // Confidence below this = long dots
      "sectionDivider": 600,       // ms after section divider appears
      "blockGap": 300,             // ms between blocks
      "autoAdvance": 30000         // ms before auto-advancing explanation panel
    },
    "animations": {
      "scrollReset": 3000,         // ms after user scroll before auto-scroll resumes
      "arrowScrollPause": 500,     // ms pause before scrolling to arrow target
      "arrowSourcePause": 1000,    // ms showing source before drawing arrow
      "arrowDualPause": 600,       // ms showing both spots before arrow appears
      "arrowFade": 300,            // ms arrow fade in/out duration
      "arrowHold": 5000,           // ms arrow stays visible
      "explainEntry": 500,         // ms delay before explanation panel appears
      "tokenStep": 200,            // ms between token explanations
      "tokenScroll": 300           // ms scroll animation to token
    }
  },

  // ─── AUDIO ───
  // Sound synthesis parameters. The engine generates sounds from these values.
  "audio": {
    "keystroke": {
      "frequency": 1100,
      "duration": 0.035,
      "volume": 0.012,
      "pitchVariation": 0.6        // Random pitch range (0.7 + random * this)
    },
    "blockComplete": {
      "frequency": 480,
      "duration": 0.18,
      "volume": 0.025
    },
    "linkChime": {
      "frequencies": [420, 530, 640],
      "duration": 0.12,
      "volume": 0.018,
      "stagger": 0.04              // Delay between each frequency
    }
  },

  // ─── STYLE ───
  // Visual appearance of the cinematic engine. Colors, borders, glows, fonts.
  // The engine applies these directly — no hardcoded colors.
  "style": {
    "background": "#0d0d0f",
    "editorBackground": "#13131a",
    "editorBorder": "#1e1e28",
    "editorBorderRadius": 12,
    "gutterBackground": "#0f0f14",
    "gutterTextColor": "#555566",
    "gutterWidth": 52,
    "codePadding": 14,
    "fontFamily": "'JetBrains Mono', monospace",
    "fontSize": 13,
    "lineHeight": 22,

    "spotlight": {
      "borderColor": "#4ec9b0",
      "borderWidth": 2,
      "borderRadius": 10,
      "glowColor": "rgba(78,201,176,0.3)",
      "glowSize": 16
    },
    "vignette": {
      "color": "rgba(0,0,0,0.78)",
      "enabled": true
    },
    "cursor": {
      "color": "#6fffe9",
      "glowColor": "#4ec9b0",
      "width": 2,
      "blinkSpeed": 0.7
    },
    "activeLine": {
      "background": "rgba(97,175,239,0.12)",
      "borderColor": "#61afef",
      "borderWidth": 3
    },
    "sectionDivider": {
      "textColor": "#4ec9b0",
      "lineGradientStart": "#4ec9b0",
      "lineGradientEnd": "transparent"
    },
    "explanationPanel": {
      "background": "rgba(10,10,16,0.94)",
      "borderColor": "rgba(78,201,176,0.15)",
      "borderRadius": 18,
      "shadowColor": "rgba(0,0,0,0.7)",
      "backdropBlur": 20,
      "labelColors": {
        "concept": "#5c6370",
        "api":     "#56d4f5",
        "pattern": "#61afef",
        "warn":    "#e06c75",
        "var":     "#e5c07b"
      }
    },
    "tokenHighlight": {
      "background": "rgba(86,212,245,0.25)",
      "glowColor": "rgba(86,212,245,0.3)",
      "borderRadius": 3,
      "pulseAnimation": true
    },
    "miniExplanation": {
      "background": "rgba(10,10,16,0.95)",
      "borderColor": "rgba(86,212,245,0.2)",
      "borderRadius": 12,
      "backdropBlur": 16
    },
    "arrows": {
      "strokeColor": "rgba(255,255,255,0.75)",
      "strokeWidth": 2.5,
      "dotRadius": 5,
      "labelFont": "'Outfit', sans-serif",
      "labelSize": 11,
      "labelColor": "rgba(255,255,255,0.9)"
    },
    "progressBar": {
      "trackColor": "#1e1e28",
      "fillColor": "#4ec9b0",
      "height": 3
    }
  }
}
```

## Visualizer JS Files

Visualizer files are standard JavaScript modules in the `visualizers/` folder.
Each exports named functions that the engine calls with a canvas context:

```javascript
// visualizers/blocks.js

// Called by the engine when the "includes" block explanation is shown.
// ctx: CanvasRenderingContext2D
// w, h: canvas dimensions
// vals: { showBytes: boolean, zoom: number } — from controls
function renderIncludes(ctx, w, h, vals) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0e0e14';
    ctx.fillRect(0, 0, w, h);
    // ... draw whatever you want
}

// Export all block visualizers
exports.renderIncludes = renderIncludes;
```

```javascript
// visualizers/tokens.js

function renderXtlHeader(ctx, w, h) {
    // ... draw token visualization
}

exports.renderXtlHeader = renderXtlHeader;
```

## Engine Contract

The engine:
1. Reads `lesson.json` — this is the ONLY input
2. Loads visualizer JS files from `visualizers/` via sandboxed `new Function()`
3. Loads audio assets from `assets/` as needed
4. Renders EXACTLY what the package says — positions, colors, timing, everything
5. Has NO defaults — if a field is missing, that feature is skipped (not substituted)
6. Has NO opinions about layout, color, timing, or anything else

If the lesson looks wrong, fix the package. Not the engine.
```
