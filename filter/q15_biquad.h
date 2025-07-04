#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct Q15Coeff {
    int16_t b0;
    int16_t b1;
    int16_t b2;
    int16_t a1;
    int16_t a2;
    int32_t mask;
    int shift;
};

struct Q15State {
    int16_t xlatch1;
    int16_t xlatch2;
    int16_t ylatch1;
    int16_t ylatch2;
    int32_t quantization;
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
