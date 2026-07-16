/*
 * emulator.h — the parts of the Nexia 360 emulator's plumbing that are Windows
 * rather than JavaScript. emulator.c says what stayed in TypeScript, and why.
 */
#ifndef NEXIA_EMULATOR_H
#define NEXIA_EMULATOR_H

#include "nexia.h"

/*
 *   nexia-core emulator pids <exe-name>
 *   nexia-core emulator gdb [--gdb-path P]
 *   nexia-core emulator configured <path>
 *   nexia-core emulator break <pid>
 */
int nx_cmd_emulator(int argc, wchar_t **argv);

#endif
