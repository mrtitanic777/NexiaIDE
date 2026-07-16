/*
 * buildsystem.h — the compiler driver's command line.
 *
 * A port of src/main/buildSystem.ts. One entry point, because main.c wires the
 * CLI and this module owns everything behind it:
 *
 *   nexia-core build args  <project.json> <Configuration>
 *       Print the argv it WOULD run — cl.exe per source, then link.exe or
 *       lib.exe. Nothing is spawned. This is the whole point: the flags are the
 *       product, and printing them is what makes them testable on a machine
 *       that cannot run a build, against the TypeScript that still ships.
 *
 *   nexia-core build parse <toolOutputFile>
 *       MSVC/LINK diagnostics in, {file,line,column,message,severity} out.
 *
 * argv arrives AFTER "build".
 */
#ifndef NEXIA_BUILDSYSTEM_H
#define NEXIA_BUILDSYSTEM_H

#include <wchar.h>

int nx_cmd_build(int argc, wchar_t **argv);

#endif
