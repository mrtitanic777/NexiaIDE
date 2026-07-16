/*
 * extensions.h — where extensions live on disk, and moving them around.
 * extensions.c says what stayed in TypeScript, and why.
 */
#ifndef NEXIA_EXTENSIONS_H
#define NEXIA_EXTENSIONS_H

#include "nexia.h"

/*
 *   nexia-core extensions dir [--home P]
 *   nexia-core extensions list [--home P]
 *   nexia-core extensions install <folder> <id> [--home P]
 *   nexia-core extensions uninstall <id> [--home P]
 *   nexia-core extensions template <name> <type> [--home P]
 *   nexia-core extensions open [--home P]
 *
 * --home stands in for os.homedir(). The IDE never passes it; the parity test
 * always does, because a test that installs into the real ~/.nexia-ide is not
 * one anybody can run twice.
 */
int nx_cmd_extensions(int argc, wchar_t **argv);

#endif
