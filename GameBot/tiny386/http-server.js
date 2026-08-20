'use strict';

// Shared HTTP helpers for every browser-hosted game profile.  The game files
// provide their own routes, while this file owns the legacy-client details:
// path normalization, traversal-safe static files, MIME types, and explicit
// Content-Length headers.
(function () {
    const MIME = {
        '.ini': 'text/plain', '.html': 'text/html', '.htm': 'text/html',
        '.txt': 'text/plain', '.css': 'text/css', '.js': 'application/javascript',
        '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
        '.gif': 'image/gif', '.srf': 'application/octet-stream',
    };

    function normalizePath(path) {
        let value = String(path || '/').replace(/\\/g, '/');
        // Some Win95 clients emit //route/... after concatenating a host
        // prefix and a path.  Collapse only leading slashes; preserve the
        // rest of the URL exactly as sent.
        value = '/' + value.replace(/^\/+/, '');
        return value || '/';
    }

    function safeRelativePath(urlPath) {
        const parts = normalizePath(urlPath).split('/');
        const out = [];
        for (const part of parts) {
            if (part === '' || part === '.') continue;
            if (part === '..') {
                if (out.length === 0) return null;
                out.pop();
            } else {
                out.push(part);
            }
        }
        return out.join('/');
    }

    function mimeFor(path) {
        const dot = String(path).lastIndexOf('.');
        const ext = dot === -1 ? '' : String(path).slice(dot).toLowerCase();
        return MIME[ext] || 'application/octet-stream';
    }

    function sizedResponse(body, status = 200, headers = {}) {
        const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
        const length = bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.length;
        return new Response(bytes, {
            status,
            headers: { ...headers, 'Content-Length': String(length) },
        });
    }

    function textResponse(body, status = 200, contentType = 'text/plain') {
        return sizedResponse(body, status, { 'Content-Type': contentType });
    }

    function makeStaticReader(staticRoot, adsRoot = null) {
        async function tryStatic(urlPath) {
            const safe = safeRelativePath(urlPath);
            if (safe === null) return null;
            const fileUrl = staticRoot.replace(/\/$/, '') + '/' + safe;
            let resp;
            try { resp = await fetch(fileUrl, { cache: 'no-store' }); }
            catch (e) { return null; }
            if (!resp.ok) return null;
            const data = await resp.arrayBuffer();
            console.log(`[http] Static: ${normalizePath(urlPath)} -> ${fileUrl} (${data.byteLength} bytes)`);
            return sizedResponse(data, 200, { 'Content-Type': mimeFor(fileUrl) });
        }

        async function tryAdFile(urlPath) {
            if (!adsRoot) return null;
            const filename = normalizePath(urlPath).split('/').filter(Boolean).pop();
            if (!filename) return null;
            const fileUrl = adsRoot.replace(/\/$/, '') + '/' + filename;
            let resp;
            try { resp = await fetch(fileUrl, { cache: 'no-store' }); }
            catch (e) { return null; }
            if (!resp.ok) return null;
            const data = await resp.arrayBuffer();
            console.log(`[http] Ad file: ${normalizePath(urlPath)} -> ${fileUrl} (${data.byteLength} bytes)`);
            return sizedResponse(data, 200, { 'Content-Type': mimeFor(fileUrl) });
        }

        return { tryStatic, tryAdFile };
    }

    window.sharedHttpServer = {
        normalizePath,
        safeRelativePath,
        mimeFor,
        sizedResponse,
        textResponse,
        makeStaticReader,
    };
})();
