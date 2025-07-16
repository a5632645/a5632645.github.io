#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef int64_t acc_t;
typedef int32_t quan_t;
#define QUAN_FRACTION_BITS 30

struct Q15Coeff {
    quan_t b0;
    quan_t b1;
    quan_t b2;
    quan_t a1;
    quan_t a2;
    acc_t mask;
    int shift;
};

struct Q15State {
    quan_t xlatch1;
    quan_t xlatch2;
    quan_t ylatch1;
    quan_t ylatch2;
    acc_t quantization;
};

struct Q15Biquad {
    struct Q15Coeff coeff;
    struct Q15State left;
    struct Q15State right;
};

void Q15Biquad_Init(struct Q15Biquad* biquad);
void Q15Biquad_Process(struct Q15Biquad* biquad, int16_t* left, int16_t* right, size_t length);
void Q15Biquad_Convert(struct Q15Biquad* biquad, float b0, float b1, float b2, float a1, float a2);

#ifdef __cplusplus
}
#endif
