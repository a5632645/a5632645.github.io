# PFFFT

Single-precision FFT sources from [marton78/pffft](https://github.com/marton78/pffft/tree/bffd965c3b07acff8c222ce17f573a2343fd4aad) at commit `bffd965c3b07acff8c222ce17f573a2343fd4aad`.
See [LICENSE.txt](LICENSE.txt) for the upstream license included with the Wasm distribution.

The `PGHI_FREESTANDING` include guards in `pffft.c` and `simd/pf_float.h` let the standalone Wasm build use the fixed plan arena and local math functions.
