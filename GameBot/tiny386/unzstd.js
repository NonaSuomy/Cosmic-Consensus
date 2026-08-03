'use strict';

// zstd decompressor for the .img.zst disk images named in the .ini files.
//
// Same entry point as upstream -- get_unzstd(cb) hands back an
// unzstd(ArrayBuffer) -> ArrayBuffer -- with two changes:
//
//  1. The heap grows to fit the image instead of being fixed at 2048 pages
//     (128 MB). That ceiling silently capped the usable image size: a 100 MB
//     image fitted, 200 MB threw "memory access out of bounds" part-way
//     through the decode, and win95_d_drive_cc.img is 500 MB.
//  2. The byte-at-a-time copy loops are TypedArray.set / subarray, which for a
//     500 MB image is the difference between a moment and a visible stall.
//
// memory.grow() DETACHES the existing ArrayBuffer, so every view has to be
// rebuilt afterwards -- that is what mem8() re-reading .buffer each time is
// for. Holding a stale Uint8Array across a grow is the classic way to get a
// silently empty result here.
function get_unzstd(cont)
{
    const imports = {
        env: {}
    };

    const fetchopt = { cache: 'default' };
    const PAGE = 65536;
    // Slack for zstd's own working allocations (window buffers, tables) on top
    // of the source and destination blocks we ask for explicitly.
    const HEAP_SLACK = 32 * 1024 * 1024;

    fetch('unzstd.wasm', fetchopt)
        .then(response => {
            if (!response.ok)
                throw new Error('unzstd.wasm: HTTP ' + response.status);
            return response.arrayBuffer();
        })
        .then(bytes => WebAssembly.compile(bytes))
        .then(module => new WebAssembly.Instance(module, imports))
        .then(instance => {
            const memory = instance.exports.memory;

            // Never cached: valid only until the next grow().
            const mem8 = () => new Uint8Array(memory.buffer);

            // Grow so that [0, end) is addressable.
            //
            // Keyed on the END ADDRESS, not on a byte count: this allocator
            // bumps a pointer and hands back offsets ABOVE the current heap,
            // expecting the embedder to grow -- which is why upstream pre-grew
            // a fixed 2048 pages. Growing by "size needed" instead looks right
            // and works once, then fails on the second image, when malloc
            // returns a pointer already past the end. That is the RangeError.
            function ensureHeapTo(end) {
                const want = end + HEAP_SLACK;
                const have = memory.buffer.byteLength;
                if (want <= have) return;
                const pages = Math.ceil((want - have) / PAGE);
                try {
                    memory.grow(pages);
                } catch (e) {
                    throw new Error(
                        'unzstd: cannot grow heap to ' +
                        Math.ceil(want / 1048576) + ' MB (' + e.message + ')');
                }
            }

            function unzstd(abuf) {
                const buf = new Uint8Array(abuf);

                const srcptr = instance.exports.malloc(buf.length);
                if (!srcptr) throw new Error('unzstd: malloc failed for source');
                ensureHeapTo(srcptr + buf.length);
                mem8().set(buf, srcptr);

                const dstlen = Number(
                    instance.exports.ZSTD_decompressBound(srcptr, buf.length));
                if (!(dstlen > 0))
                    throw new Error('unzstd: not a valid zstd frame');

                const dstptr = instance.exports.malloc(dstlen);
                if (!dstptr)
                    throw new Error('unzstd: malloc failed for ' +
                                    Math.ceil(dstlen / 1048576) + ' MB output');
                // Contents survive a grow, so srcptr stays valid across this.
                ensureHeapTo(dstptr + dstlen);

                const dstlen2 = instance.exports.ZSTD_decompress(
                    dstptr, dstlen, srcptr, buf.length);
                if (!(dstlen2 > 0))
                    throw new Error('unzstd: decompression failed');

                const out = new Uint8Array(dstlen2);
                out.set(mem8().subarray(dstptr, dstptr + dstlen2));

                // Hand the blocks back so several images in a row reuse the
                // same heap rather than each extending it.
                if (instance.exports.free) {
                    instance.exports.free(dstptr);
                    instance.exports.free(srcptr);
                }
                return out.buffer;
            }
            cont(unzstd);
        })
        .catch(err => {
            console.error('[unzstd] ' + err.message);
            throw err;
        });
}
