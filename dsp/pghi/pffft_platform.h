/* Supplies PFFFT's C library declarations for the freestanding Wasm build. */
#ifndef PGHI_PFFFT_PLATFORM_H
#define PGHI_PFFFT_PLATFORM_H

#include <stddef.h>
#include <stdint.h>

/* PFFFT's upstream diagnostics are discarded by the Wasm linker. */
typedef struct PghiPffftFile FILE;
extern FILE *stderr;
int fprintf(FILE *stream, const char *format, ...);
int printf(const char *format, ...);

float cosf(float angle);
double fabs(double value);
float sinf(float angle);

/* Uses the fixed arena selected by FftCore::init. */
void *pghi_pffft_allocate(size_t bytes);

/* PFFFT uses libc spellings. The arena is reclaimed as a unit at setup. */
#define malloc(bytes) pghi_pffft_allocate((bytes))
#define free(pointer) ((void)(pointer))
#define memcpy(destination, source, bytes) __builtin_memcpy((destination), (source), (bytes))
#define assert(condition) ((void)0)

#endif
