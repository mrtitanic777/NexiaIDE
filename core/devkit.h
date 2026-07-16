/*
 * devkit.h — the Xbox 360 devkit client.
 *
 * Everything the IDE asks of a console over XBDM. The interface is one command
 * function because that is all main.c needs: the devkit has no state worth
 * keeping between runs — the TypeScript's connectedIp and console list lived for
 * as long as the window did, and a process that answers one question does not
 * get to remember the answer.
 */
#ifndef NEXIA_DEVKIT_H
#define NEXIA_DEVKIT_H

/*
 * Before nexia.h, which pulls in windows.h. windows.h includes the original
 * 1991 winsock.h unless something has already claimed _WINSOCKAPI_, and the two
 * headers define the same symbols incompatibly. Including winsock2.h first is
 * the documented way out.
 */
#include <winsock2.h>
#include <ws2tcpip.h>
#include "nexia.h"

/* XBDM listens here on every devkit; neither is configurable in the IDE. */
#define NX_XBDM_PORT    730
#define NX_XBDM_TIMEOUT 5000

/* Args after "devkit". Prints one JSON object; 0 ok, 1 failed, 2 bad usage. */
int nx_cmd_devkit(int argc, wchar_t **argv);

#endif
