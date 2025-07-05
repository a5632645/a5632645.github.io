#include "q15_biquad.h"
#include <math.h>
#include <string.h>

static void Q15Process(const struct Q15Coeff* coeff, struct Q15State* state, int16_t* x, size_t len) {
    quan_t xlatch1 = state->xlatch1;
    quan_t xlatch2 = state->xlatch2;
    quan_t ylatch1 = state->ylatch1;
    quan_t ylatch2 = state->ylatch2;
    acc_t acc = state->quantization;

    for (size_t i = 0; i < len; ++i) {
        quan_t qx = x[i] << 16;
        // 如果要确保正确性，则改成int64_t
        // 性能则使用int32_t
        acc += ((acc_t)coeff->b0 * (acc_t)qx);
        acc += ((acc_t)coeff->b1 * (acc_t)xlatch1);
        acc += ((acc_t)coeff->b2 * (acc_t)xlatch2);
        acc -= ((acc_t)coeff->a1 * (acc_t)ylatch1);
        acc -= ((acc_t)coeff->a2 * (acc_t)ylatch2);
        /*acc_t sum = quantization
            + (acc_t)(coeff->b0 * qx) + (acc_t)(coeff->b1 * xlatch1) + (acc_t)(coeff->b2 * xlatch2)
            - (acc_t)(coeff->a1 * ylatch1) - (acc_t)(coeff->a2 * ylatch2);*/
        //quantization = sum & coeff->mask;

        // 可改为处理器的饱和指令
        acc_t res = acc >> coeff->shift;
        acc &= coeff->mask;
        if (res > 2147483647) res = 2147483647;
        else if (res < -2147483648ll) res = -2147483648ll;

        xlatch2 = xlatch1;
        xlatch1 = qx;
        ylatch2 = ylatch1;
        ylatch1 = res;
        int16_t yout = (int16_t)(res >> 16);
        x[i] = yout;
    }

    state->xlatch1 = xlatch1;
    state->xlatch2 = xlatch2;
    state->ylatch1 = ylatch1;
    state->ylatch2 = ylatch2;
    state->quantization = acc;
}

static void Q15ResetState(struct Q15State* state) {
    state->quantization = 0;
    state->xlatch1 = 0;
    state->xlatch2 = 0;
    state->ylatch1 = 0;
    state->ylatch2 = 0;
}

static int8_t Q15Covert(struct Q15Coeff* coeff, float b0, float b1, float b2, float a1, float a2) {
    float maxb = 0.0f;
    int8_t diff_shift = 0;
    if (fabsf(b0) > maxb) {
        maxb = fabsf(b0);
    }
    if (fabsf(b1) > maxb) {
        maxb = fabsf(b1);
    }
    if (fabsf(b2) > maxb) {
        maxb = fabsf(b2);
    }
    if (fabsf(a1) > maxb) {
        maxb = fabsf(a1);
    }
    if (fabsf(a2) > maxb) {
        maxb = fabsf(a2);
    }
    int xshift = 0;
    while (maxb >= 1.0f) {
        maxb /= 2.0f;
        xshift++;
    }

    if ((31 - xshift) != coeff->shift) {
        diff_shift = 1;
    }

    coeff->shift = 31 - xshift;
    coeff->b0 = (quan_t)((int64_t)(b0 * 2147483648ll) >> xshift);
    coeff->b1 = (quan_t)((int64_t)(b1 * 2147483648ll) >> xshift);
    coeff->b2 = (quan_t)((int64_t)(b2 * 2147483648ll) >> xshift);
    coeff->a1 = (quan_t)((int64_t)(a1 * 2147483648ll) >> xshift);
    coeff->a2 = (quan_t)((int64_t)(a2 * 2147483648ll) >> xshift);
    coeff->mask = (1ull << (31 - xshift)) - 1;

    return diff_shift;
}

// --------------------------------------------------------------------------------
// public
// --------------------------------------------------------------------------------
void Q15Biquad_Init(struct Q15Biquad* biquad) {
    Q15ResetState(&biquad->left);
    Q15ResetState(&biquad->right);
    biquad->coeff.a1 = 0;
    biquad->coeff.a2 = 0;
    biquad->coeff.b0 = 0;
    biquad->coeff.b1 = 0;
    biquad->coeff.b2 = 0;
    biquad->coeff.mask = 0;
    biquad->coeff.shift = 0;
}

void Q15Biquad_Process(struct Q15Biquad* biquad, int16_t* left, int16_t* right, size_t length) {
    Q15Process(&biquad->coeff, &biquad->left, left, length);
    Q15Process(&biquad->coeff, &biquad->right, right, length);
}

void Q15Biquad_Convert(struct Q15Biquad* biquad, float b0, float b1, float b2, float a1, float a2) {
    int8_t diff_shift = Q15Covert(&biquad->coeff, b0, b1, b2, a1, a2);
    if (diff_shift == 1) {
        biquad->left.quantization = 0;
        biquad->right.quantization = 0;
    }
}
