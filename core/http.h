/*
 * http.h — the HTTPS GET described in http.c.
 */
#ifndef NEXIA_HTTP_H
#define NEXIA_HTTP_H

#include <wchar.h>
#include <stddef.h>

typedef struct {
    long   status;      /* HTTP status code, valid when the call returned 1 */
    char  *body;        /* NUL-terminated, UTF-8 as the server sent it; free via nx_http_free */
    size_t len;
    wchar_t err[256];   /* set when the call returned 0 */
} nx_http_resp;

/* GET url with optional "Name: value" headers. 1 = a response arrived (any
 * status); 0 = transport failure, err set. */
int  nx_http_get(const wchar_t *url, const wchar_t **headers, int nheaders, nx_http_resp *out);
void nx_http_free(nx_http_resp *r);

#endif
