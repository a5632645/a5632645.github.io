// pghi_shifter.cpp — 实时 PGHI 移调器（WebAssembly 版）
//
// 从 qwqdsp/playing/playing.cpp 的 RealtimePitchShifter 移植，
// 并带上浏览器版的新特性：HOP/窗函数运行时参数化、统一冷却时间（毫秒）、
// 3 种瞬态检测（None / SuperFlux / DSPark）、900 列波形包络显示。
//
// 编译（clang wasm32，无需 emscripten / libc）：
//   clang++ --target=wasm32 -msimd128 -O3 -std=c++17 -nostdlib -fno-exceptions -fno-rtti \
//     -Wl,--no-entry -Wl,--initial-memory=33554432 \
//     -Wl,--export=init -Wl,--export=process ... \
//     pghi_shifter.cpp -o pghi_shifter.wasm
//
// 内存布局：固定最大容量（hop<=1024, overlap<=8, fft<=16384），固定 Mid/Side 实例，
// 无动态分配，memory 不增长，JS 端视图地址稳定。

#include <wasm_simd128.h>

// 完全 freestanding（无 libc/libc++/标准头），wasm32 下 size_t 为 32 位
using size_t = unsigned int;
using uint32_t = unsigned int;
using uint64_t = unsigned long long;
using int64_t = long long;

// ============================================================
// 最小 float libm（wasm 无 libm；sqrt/floor/ceil/trunc/fabs 由
// wasm 原生指令生成，这里只提供需要实现的函数）
// ============================================================
extern "C" {

float floorf(float);
float ceilf(float);
float truncf(float);
float fabsf(float);
float sqrtf(float);
float roundf(float);
float fmodf(float, float);
float sinf(float);
float cosf(float);
float atan2f(float, float);
float logf(float);
float log10f(float);
float log1pf(float);
float expf(float);
float exp2f(float);
float powf(float, float);
float hypotf(float, float);

float roundf(float x) {
    return x >= 0.0f ? floorf(x + 0.5f) : ceilf(x - 0.5f);
}

float fmodf(float x, float y) {
    return x - truncf(x / y) * y;
}

// ============================================================
// 高精度三角函数（double 内部计算 + float 输出，~1 ULP）
// 系数由 Python/mpmath 50 位精度最小二乘生成（见 _gen_coefs.py）
// sin(x)=x·P(x²), cos(x)=Q(x²), x∈[-π/4,π/4]；atan(x)=x·R(x²), |x|≤1
// ============================================================
static const double kSinPoly[9] = {
    1.00000000000000178e+00, -1.66666666666764551e-01, 8.33333333559123021e-03, -1.98412724229970940e-04,
    2.75589050713162905e-06, -2.55997147306855562e-08, 1.22187619371526177e-09, -1.07668830334320741e-09,
    4.43795552535296879e-10,
};
static const double kCosPoly[9] = {
    1.00000000000000155e+00, -5.00000000000096478e-01, 4.16666666690774581e-02, -1.38888891763078821e-03,
    2.48017699056733995e-05, -2.76220612181966729e-07, 3.36788292772965989e-09, -1.32889146966614275e-09,
    5.49244900787683429e-10,
};
static constexpr int kAtanDegree = 8;
static const double kAtanPoly[kAtanDegree + 1] = {
    9.99999960229774776e-01, -3.33329447829176895e-01, 1.99908489968225994e-01, -1.41931483109798390e-01,
    1.06087903520581742e-01, -7.44965457130417064e-02, 4.21739393553590691e-02, -1.58149066268421894e-02,
    2.80028232958323946e-03,
};

// 角度约化：把 x 归到 [0,4) 象限，返回 (象限, r∈[-π/4,π/4])
static int quadrantReduce(float x, double& r) {
    constexpr double kHalfPi = 1.5707963267948966;
    const double d = (double)x;
    const double qd = (d / kHalfPi) + (d >= 0.0 ? 0.5 : -0.5); // half-away-from-zero
    const int q = (int)qd;
    r = d - (double)q * kHalfPi;
    return q & 3; // C++ 负 q 的 &3 为补码低两位，等效 mod4
}

static double sinPoly(double t) {
    double p = kSinPoly[8];
    for (int i = 7; i >= 0; --i) p = p * t + kSinPoly[i];
    return p;
}
static double cosPoly(double t) {
    double p = kCosPoly[8];
    for (int i = 7; i >= 0; --i) p = p * t + kCosPoly[i];
    return p;
}

float sinf(float x) {
    double r;
    switch (quadrantReduce(x, r)) {
        case 0: return (float)(r * sinPoly(r * r));
        case 1: return (float)(cosPoly(r * r));
        case 2: return (float)(-r * sinPoly(r * r));
        default: return (float)(-cosPoly(r * r));
    }
}

float cosf(float x) {
    double r;
    switch (quadrantReduce(x, r)) {
        case 0: return (float)(cosPoly(r * r));
        case 1: return (float)(-r * sinPoly(r * r));
        case 2: return (float)(-cosPoly(r * r));
        default: return (float)(r * sinPoly(r * r));
    }
}

static void sinCos(float angle, float& sine, float& cosine) {
    double r;
    const int quadrant = quadrantReduce(angle, r);
    const double t = r * r;
    const float s = (float)(r * sinPoly(t));
    const float c = (float)cosPoly(t);
    switch (quadrant) {
        case 0: sine = s; cosine = c; break;
        case 1: sine = c; cosine = -s; break;
        case 2: sine = -s; cosine = -c; break;
        default: sine = -c; cosine = s; break;
    }
}

// atan：|x|≤1 用 minimax 多项式，配合 atan(x)+atan(1/x)=π/2
static double atanPoly(double u) {
    double p = kAtanPoly[kAtanDegree];
    for (int i = kAtanDegree - 1; i >= 0; --i) p = p * u + kAtanPoly[i];
    return p;
}

float atanf(float x) {
    const bool neg = x < 0.0f;
    const double ax = neg ? -(double)x : (double)x;
    double r;
    if (ax > 1.0) {
        r = 1.5707963267948966 - atanPoly(1.0 / (ax * ax)) / ax;
    } else {
        r = ax * atanPoly(ax * ax);
    }
    return (float)(neg ? -r : r);
}

float atan2f(float y, float x) {
    if (x > 0.0f) return atanf(y / x);
    if (x < 0.0f) {
        if (y >= 0.0f) return atanf(y / x) + 3.141592653589793f;
        return atanf(y / x) - 3.141592653589793f;
    }
    if (y > 0.0f) return 1.5707963267948966f;
    if (y < 0.0f) return -1.5707963267948966f;
    return 0.0f;
}

float logf(float x) {
    if (x <= 0.0f) return -3.0e38f;
    uint32_t bits;
    __builtin_memcpy(&bits, &x, 4);
    const int e = (int)((bits >> 23) & 0xff) - 127;
    bits = (bits & 0x007fffffu) | 0x3f800000u; // m in [1,2)
    float m;
    __builtin_memcpy(&m, &bits, 4);
    const float u = (m - 1.0f) / (m + 1.0f);
    const float u2 = u * u;
    const float logm = 2.0f * u * (1.0f + u2 * (0.3333333333333333f
        + u2 * (0.2f + u2 * (0.14285714285714285f + u2 * (0.1111111111111111f + u2 / 9.0f)))));
    return logm + (float)e * 0.6931471805599453f;
}

float log10f(float x) {
    return logf(x) * 0.4342944819032518f;
}

float log1pf(float x) {
    return logf(1.0f + x);
}

float expf(float x) {
    const float n = roundf(x * 1.4426950408889634f); // x / ln2
    const float r = x - n * 0.6931471805599453f;
    const float r2 = r * r;
    const float er = 1.0f + r + r2 * (0.5f + r * (0.16666666666666666f
        + r * (0.041666666666666664f + r * (0.008333333333333333f + r * 0.001388888888888889f))));
    const int ni = (int)n;
    float p2;
    const uint32_t b = (uint32_t)(ni + 127) << 23;
    __builtin_memcpy(&p2, &b, 4);
    return er * p2;
}

float exp2f(float x) {
    return expf(x * 0.6931471805599453f);
}

float powf(float x, float y) {
    if (x <= 0.0f) return 0.0f;
    return expf(y * logf(x));
}

float hypotf(float x, float y) {
    return sqrtf(x * x + y * y);
}

} // extern "C"

// ============================================================
// 固定容量实时 PGHI 移调器
// ============================================================

namespace {

constexpr size_t kMaxHop = 1024;
constexpr size_t kMaxOverlap = 8;
constexpr size_t kMaxWindow = kMaxHop * kMaxOverlap;           // 8192
constexpr size_t kMaxFft = 16384;                              // nextPow2(8192*2)
constexpr size_t kMaxBins = kMaxFft / 2 + 1;                   // 8193
constexpr size_t kSynthesisRing = kMaxFft * 16;                // 262144
constexpr size_t kHeapCapacity = kMaxBins * 2;
constexpr size_t kMaxSuperFluxWeights = kMaxBins * 3;
constexpr size_t kMaxSuperFluxBands = 256;
constexpr size_t kDsFluxWindow = 32;                    // DSPark 历史缓冲上限（帧）
constexpr size_t kDsFluxReferenceWindow = 12;           // DSPark 基准历史窗长（帧）
constexpr float kDsFluxDelta = 0.02f;
constexpr size_t kSincRadius = 8;
constexpr size_t kIoCapacity = 4096;
constexpr size_t kInputRadius = 2 * kSincRadius;
constexpr size_t kMaxOutputRadius = 4 * kSincRadius;
constexpr size_t kInputResampleRing = 4 * kInputRadius;
constexpr size_t kSincTableSize = 2048;
constexpr size_t kMaxTransientMarks = 32;
constexpr size_t kDisplayColumns = 900;

constexpr int kGaussianWindow = 3;
constexpr int kGaussian59Window = 4;
constexpr int kGaussian79Window = 5;
constexpr int kGaussian102Window = 6;

bool isGaussianWindow(int windowType) {
    return windowType >= kGaussianWindow && windowType <= kGaussian102Window;
}

size_t windowOverlap(int windowType) {
    switch (windowType) {
        case 0: return 4;
        case kGaussian59Window: return 5;
        case 1:
        case kGaussian79Window: return 6;
        case kGaussian102Window: return 7;
        default: return 8;
    }
}

float wrapToPi(float phase) {
    constexpr float kTwoPi = 6.283185307179586f;
    return phase - kTwoPi * roundf(phase / kTwoPi);
}

// 归一化 sinc × 对称 Blackman 窗内插核
float sincKernel(float x) {
    if (x < 1.0e-6f && x > -1.0e-6f) return 1.0f;
    const float px = 3.141592653589793f * x;
    const float window = 0.42f + 0.5f * cosf(3.141592653589793f * x / (float)kSincRadius)
        + 0.08f * cosf(6.283185307179586f * x / (float)kSincRadius);
    return sinf(px) / px * window;
}

size_t nextPowerOfTwo(size_t v) {
    size_t r = 1;
    while (r < v) r <<= 1;
    return r;
}

// ------------------------------------------------------------
// 迭代基 2 实数 FFT（CCS 布局，与浏览器 JS 版一致；1/N 逆变换）
// 用固定 16384 的 twiddle 表支持任意 2^n <= 16384
// ------------------------------------------------------------
class FftCore {
public:
    size_t n;
    size_t radix2Size;
    size_t oddRadix;
    uint32_t rev[kMaxFft];
    float cosT[kMaxFft / 2];
    float sinT[kMaxFft / 2];
    float stageCos[kMaxFft / 2];
    float stageSin[kMaxFft / 2];
    float reBuf[kMaxFft];
    float imBuf[kMaxFft];
    float mixedRe[kMaxFft / 2];
    float mixedIm[kMaxFft / 2];
    float mixedCos[kMaxFft / 2];
    float mixedSin[kMaxFft / 2];
    float oddCos[kMaxFft / 2];
    float oddSin[kMaxFft / 2];

    void init(size_t fftSize) {
        n = fftSize;
        const size_t half = n / 2;
        radix2Size = half & (0u - half);
        oddRadix = half / radix2Size;

        size_t bits = 0;
        for (size_t length = radix2Size; length > 1; length >>= 1) ++bits;
        for (size_t i = 0; i < radix2Size; ++i) {
            uint32_t reversed = 0;
            for (size_t b = 0; b < bits; ++b) {
                reversed = (reversed << 1) | ((uint32_t)(i >> b) & 1u);
            }
            for (size_t group = 0; group < oddRadix; ++group) {
                rev[i * oddRadix + group] = (uint32_t)(group * radix2Size + reversed);
            }
        }

        constexpr float kTwoPi = 6.283185307179586f;
        for (size_t k = 0; k < half; ++k) {
            const float angle = -kTwoPi * (float)k / (float)n;
            sinCos(angle, sinT[k], cosT[k]);
        }
        for (size_t len = 8; len <= radix2Size; len <<= 1) {
            const size_t stageHalf = len >> 1;
            for (size_t k = 0; k < stageHalf; ++k) {
                const float angle = -kTwoPi * (float)k / (float)len;
                sinCos(angle, stageSin[stageHalf - 1 + k], stageCos[stageHalf - 1 + k]);
            }
        }
        if (oddRadix == 1) return;
        for (size_t group = 0; group < oddRadix; ++group) {
            const float angle = -kTwoPi * (float)group / (float)oddRadix;
            sinCos(angle, oddSin[group], oddCos[group]);
            for (size_t k = 0; k < radix2Size; ++k) {
                const size_t index = group * radix2Size + k;
                const float phase = -kTwoPi * (float)(group * k) / (float)half;
                sinCos(phase, mixedSin[index], mixedCos[index]);
            }
        }
    }

    // 实数 FFT：将偶数和奇数采样打包成半长复数 FFT。
    void forward(const float* x, float* ccs, size_t binCount) {
        const size_t half = n >> 1;
        for (size_t i = 0; i < half; ++i) {
            const size_t index = rev[i];
            reBuf[index] = x[2 * i];
            imBuf[index] = x[2 * i + 1];
        }
        transform(1);
        ccs[0] = reBuf[0] + imBuf[0];
        ccs[1] = 0.0f;
        if (binCount > half) {
            ccs[n] = reBuf[0] - imBuf[0];
            ccs[n + 1] = 0.0f;
        }
        const size_t end = binCount < half ? binCount : half;
        for (size_t k = 1; k < end; ++k) {
            const size_t mirror = half - k;
            const float evenRe = 0.5f * (reBuf[k] + reBuf[mirror]);
            const float evenIm = 0.5f * (imBuf[k] - imBuf[mirror]);
            const float oddRe = 0.5f * (imBuf[k] + imBuf[mirror]);
            const float oddIm = 0.5f * (reBuf[mirror] - reBuf[k]);
            const float c = cosT[k];
            const float s = sinT[k];
            ccs[2 * k] = evenRe + c * oddRe - s * oddIm;
            ccs[2 * k + 1] = evenIm + c * oddIm + s * oddRe;
        }
    }

    void inverse(const float* ccs, float* out) {
        const size_t half = n >> 1;
        reBuf[0] = 0.5f * (ccs[0] + ccs[n]);
        imBuf[0] = 0.5f * (ccs[0] - ccs[n]);
        for (size_t k = 1; k < half; ++k) {
            const size_t mirror = half - k;
            const size_t index = rev[k];
            const float evenRe = 0.5f * (ccs[2 * k] + ccs[2 * mirror]);
            const float evenIm = 0.5f * (ccs[2 * k + 1] - ccs[2 * mirror + 1]);
            const float diffRe = 0.5f * (ccs[2 * k] - ccs[2 * mirror]);
            const float diffIm = 0.5f * (ccs[2 * k + 1] + ccs[2 * mirror + 1]);
            const float c = cosT[k];
            const float s = sinT[k];
            reBuf[index] = evenRe - (c * diffIm - s * diffRe);
            imBuf[index] = evenIm + (c * diffRe + s * diffIm);
        }
        transform(-1);
        const float scale = 1.0f / (float)half;
        for (size_t i = 0; i < half; ++i) {
            out[2 * i] = reBuf[i] * scale;
            out[2 * i + 1] = imBuf[i] * scale;
        }
    }

    void transform(int sign) {
        for (size_t group = 0; group < oddRadix; ++group) {
            const size_t offset = group * radix2Size;
            transformRadix2(reBuf + offset, imBuf + offset, radix2Size, sign);
        }
        if (oddRadix == 1) return;

        // Cooley–Tukey：先算各交错子序列的 2 幂 FFT，再按奇数基合并。
        const size_t half = n / 2;
        for (size_t i = radix2Size; i < half; ++i) {
            const float re = reBuf[i], im = imBuf[i];
            const float c = mixedCos[i];
            const float s = sign > 0 ? mixedSin[i] : -mixedSin[i];
            reBuf[i] = re * c - im * s;
            imBuf[i] = re * s + im * c;
        }
        for (size_t group = 0; group < oddRadix; ++group) {
            const size_t output = group * radix2Size;
            for (size_t k = 0; k < radix2Size; ++k) {
                mixedRe[output + k] = reBuf[k];
                mixedIm[output + k] = imBuf[k];
            }
            size_t root = group;
            for (size_t sub = 1; sub < oddRadix; ++sub) {
                const size_t input = sub * radix2Size;
                const float c = oddCos[root];
                const float s = sign > 0 ? oddSin[root] : -oddSin[root];
                for (size_t k = 0; k < radix2Size; ++k) {
                    const float re = reBuf[input + k], im = imBuf[input + k];
                    mixedRe[output + k] += re * c - im * s;
                    mixedIm[output + k] += re * s + im * c;
                }
                root += group;
                if (root >= oddRadix) root -= oddRadix;
            }
        }
        for (size_t i = 0; i < half; ++i) {
            reBuf[i] = mixedRe[i];
            imBuf[i] = mixedIm[i];
        }
    }

    void transformRadix2(float* reBuf, float* imBuf, size_t sz, int sign) {
        if (sz == 1) return;
        if (sz == 2) {
            const float re = reBuf[0], im = imBuf[0];
            reBuf[0] = re + reBuf[1];
            imBuf[0] = im + imBuf[1];
            reBuf[1] = re - reBuf[1];
            imBuf[1] = im - imBuf[1];
            return;
        }
        const float direction = sign > 0 ? 1.0f : -1.0f;
        for (size_t i = 0; i < sz; i += 4) {
            const float evenRe = reBuf[i] + reBuf[i + 1];
            const float evenIm = imBuf[i] + imBuf[i + 1];
            const float evenDiffRe = reBuf[i] - reBuf[i + 1];
            const float evenDiffIm = imBuf[i] - imBuf[i + 1];
            const float oddRe = reBuf[i + 2] + reBuf[i + 3];
            const float oddIm = imBuf[i + 2] + imBuf[i + 3];
            const float rotatedRe = direction * (imBuf[i + 2] - imBuf[i + 3]);
            const float rotatedIm = -direction * (reBuf[i + 2] - reBuf[i + 3]);
            reBuf[i] = evenRe + oddRe;
            imBuf[i] = evenIm + oddIm;
            reBuf[i + 1] = evenDiffRe + rotatedRe;
            imBuf[i + 1] = evenDiffIm + rotatedIm;
            reBuf[i + 2] = evenRe - oddRe;
            imBuf[i + 2] = evenIm - oddIm;
            reBuf[i + 3] = evenDiffRe - rotatedRe;
            imBuf[i + 3] = evenDiffIm - rotatedIm;
        }
        for (size_t len = 8; len <= sz; len <<= 1) {
            const size_t half = len >> 1;
            const float* cosines = stageCos + half - 1;
            const float* sines = stageSin + half - 1;
            for (size_t i = 0; i < sz; i += len) {
                for (size_t k = 0; k < half; k += 4) {
                    const size_t j = i + k, m = j + half;
                    const v128_t wr = wasm_v128_load(cosines + k);
                    const v128_t sine = wasm_v128_load(sines + k);
                    const v128_t wi = sign > 0 ? sine : wasm_f32x4_neg(sine);
                    const v128_t re = wasm_v128_load(reBuf + m);
                    const v128_t im = wasm_v128_load(imBuf + m);
                    const v128_t tr = wasm_f32x4_sub(wasm_f32x4_mul(re, wr), wasm_f32x4_mul(im, wi));
                    const v128_t ti = wasm_f32x4_add(wasm_f32x4_mul(re, wi), wasm_f32x4_mul(im, wr));
                    const v128_t leftRe = wasm_v128_load(reBuf + j);
                    const v128_t leftIm = wasm_v128_load(imBuf + j);
                    wasm_v128_store(reBuf + m, wasm_f32x4_sub(leftRe, tr));
                    wasm_v128_store(imBuf + m, wasm_f32x4_sub(leftIm, ti));
                    wasm_v128_store(reBuf + j, wasm_f32x4_add(leftRe, tr));
                    wasm_v128_store(imBuf + j, wasm_f32x4_add(leftIm, ti));
                }
            }
        }
    }
};

constexpr int kLocalPhaseMode = 3;
constexpr size_t kFluxBands = 64;

constexpr size_t kJointFrames = 3;
constexpr size_t kJointShortWindow = 1024;
constexpr float kJointPhaseLimit = 0.65f;

struct JointPhaseFrame {
    uint64_t start = 0;
    size_t bins = 0;
    bool hasConstraints = false;
    bool locked = false;
    float spectrum[kMaxFft + 2];
    float weight[kMaxBins];
    float gradient[kMaxBins];
    float correction[kMaxBins];
};

struct PhaseCorrectionBand {
    size_t begin = 0;
    size_t end = 0;
    float delay = 0.0f;
    float confidence = 0.0f;
};

// 短窗检测在原始输入时钟上运行，输出 Mid/Side 共享的起音坐标。
class ShortFluxDetector {
public:
    void init() {
        fft.init(kWindow);
        for (size_t i = 0; i < kWindow; ++i) {
            window[i] = 0.5f - 0.5f * cosf(6.283185307179586f * (float)i / (float)kWindow);
        }
        reset();
    }

    void reset() {
        write = 0;
        samplesUntilFrame = kWindow;
        for (size_t bin = 0; bin < kBins; ++bin) previousMagnitude[bin] = 0.0f;
        pastFlux = peakFlux = background = 0.0f;
        peakThreshold = 0.0f;
        for (size_t band = 0; band < kFluxBands; ++band) peakBandConfidence[band] = 0.0f;
        nextOnset = 0.0;
    }

    const float* onsetBands() const { return detectedBandConfidence; }

    double push(float mid, float side, uint64_t position, double cooldownSamples, bool trackBands) {
        ring[0][write] = mid;
        ring[1][write] = side;
        write = (write + 1) % kWindow;
        if (--samplesUntilFrame != 0) return -1.0;
        samplesUntilFrame = kHop;

        measurePower();
        float flux = 0.0f;
        float bandRise[kFluxBands] = {};
        float bandMagnitude[kFluxBands] = {};
        for (size_t bin = 1; bin < kBins; ++bin) {
            const float magnitude = sqrtf(power[bin]);
            const float rise = magnitude - previousMagnitude[bin];
            if (rise > 0.0f) flux += rise;
            if (trackBands) {
                const size_t band = (bin - 1) * kFluxBands / (kBins - 1);
                bandMagnitude[band] += magnitude;
                if (rise > 0.0f) bandRise[band] += rise;
            }
            previousMagnitude[bin] = magnitude;
        }
        flux *= 2.0f / (float)kWindow;

        // 正差的峰值领先窗中心处的冲击，用半个 hop 与四分之一窗校正时间戳。
        const double onset = (double)(position + 1) - 1.5 * (double)kHop - 0.25 * (double)kWindow;
        const bool hit = peakFlux > peakThreshold && peakFlux > pastFlux
            && peakFlux >= flux && onset >= nextOnset;
        if (trackBands) {
            for (size_t band = 0; band < kFluxBands; ++band) {
                if (hit) detectedBandConfidence[band] = peakBandConfidence[band];
                const float relativeRise = bandRise[band] / (bandMagnitude[band] + 1.0e-12f);
                const float scaled = 2.0f * (relativeRise - 0.25f);
                peakBandConfidence[band] = scaled > 1.0f ? 1.0f : (scaled > 0.0f ? scaled : 0.0f);
            }
        }
        const float threshold = 0.012f + 2.5f * background;
        background += 0.08f * (flux - background);
        pastFlux = peakFlux;
        peakFlux = flux;
        peakThreshold = threshold;
        if (!hit) return -1.0;
        nextOnset = onset + cooldownSamples;
        return onset;
    }

private:
    static constexpr size_t kWindow = 512;
    static constexpr size_t kHop = 128;
    static constexpr size_t kBins = kWindow / 2 + 1;
    FftCore fft;
    float window[kWindow];
    float ring[2][kWindow];
    float frame[kWindow];
    float spectrum[kWindow + 2];
    float power[kBins];
    float previousMagnitude[kBins];
    float peakBandConfidence[kFluxBands];
    float detectedBandConfidence[kFluxBands];
    size_t write = 0;
    size_t samplesUntilFrame = kWindow;
    float pastFlux = 0.0f;
    float peakFlux = 0.0f;
    float peakThreshold = 0.0f;
    float background = 0.0f;
    double nextOnset = 0.0;

    void measurePower() {
        for (size_t bin = 0; bin < kBins; ++bin) power[bin] = 0.0f;
        for (const auto& channel : ring) {
            bool audible = false;
            for (size_t i = 0; i < kWindow; ++i) {
                const float sample = channel[(write + i) % kWindow];
                audible |= sample != 0.0f;
                frame[i] = sample * window[i];
            }
            if (!audible) continue;
            fft.forward(frame, spectrum, kBins);
            for (size_t bin = 1; bin < kBins; ++bin) {
                const float re = spectrum[2 * bin], im = spectrum[2 * bin + 1];
                power[bin] += re * re + im * im;
            }
        }
    }
};

// ------------------------------------------------------------
// 实时移调器
// ------------------------------------------------------------
class Shifter {
public:
    // 参数
    float sampleRate = 48000.0f;
    size_t hopSize = 512;
    int windowType = 1; // Hann / BH3 / BH4 / Gaussian
    size_t overlap = 6;
    size_t windowSize = 3072;
    size_t halfWindow = 1536;
    size_t frameSize = 6144;
    size_t numBins = 3073;
    size_t outputStart = 3584;
    float cooldownMs = 64.0f;

    float targetRatio = 1.0f;
    float currentRatio = 1.0f;

    float inputResampleStep() const {
        // 升调保留原始分析时基，降调在输入和输出两端分摊。
        return currentRatio < 1.0f ? sqrtf(currentRatio) : 1.0f;
    }
    int transientMode = 1; // DSPark
    bool firstFrame = true;
    bool jointPhase = false;
    JointPhaseFrame jointFrames[kJointFrames];
    size_t jointHead = 0;
    size_t jointCount = 0;
    size_t jointPreviousBins = 0;
    float jointPrevious[kMaxBins];
    float jointShortWindow[kJointShortWindow];
    size_t jointShortSize = 1024;
    double jointOnsets[kMaxTransientMarks];
    size_t jointOnsetRead = 0;
    size_t jointOnsetWrite = 0;
    double jointMark = -1.0;

    // FFT
    FftCore fft;
    float fftInput[kMaxFft];
    float fftOutput[kMaxFft + 2];
    float fftTime[kMaxFft];

    // 瞬态检测器独立 FFT：分析阶段每隔分析 hop 做两次 FFT（一次检测器、一次相位声码器）。
    // 检测器始终用 hann 窗（与主链窗无关），避免 bh4 那样的窗旁瓣泄漏把扫频误读为瞬态；
    // 但帧位置/时序与主链一致，保证检测与合成严格同步。
    FftCore detFft;
    float detInput[kMaxFft];
    float detOutput[kMaxFft + 2];
    float detWindow[kMaxWindow];       // 恒为 hann（长度=detWindowSize）
    float detMag[kMaxBins];            // 检测器幅度谱（hann 窗分析）
    size_t detWindowSize = 2048;       // 检测器窗长（固定 min(2048, windowSize)）
    size_t detFrameSize = 2048;        // 检测器 FFT 帧长
    size_t detNumBins = 1025;          // 检测器 bin 数

    // 窗 / 环
    float window[kMaxWindow];
    float synthesisWindow[kMaxWindow];
    float inputRing[kMaxWindow];
    double inputSourcePositions[kMaxWindow];
    float inputResampleRing[kInputResampleRing];
    double inputResamplePosition = 0.0;
    float synthesisRing[kSynthesisRing];

    // bin 状态
    float currentMag[kMaxBins];
    float currentAnalysisPhase[kMaxBins];
    float currentSynthPhase[kMaxBins];
    float previousAnalysisPhase[kMaxBins];
    float previousSynthPhase[kMaxBins];
    float previousMag[kMaxBins];

    // PGHI 堆
    unsigned char processedBins[kMaxBins];
    struct HeapEntry {
        float magnitude;
        uint32_t binAndFrame;
    };
    HeapEntry heap[kHeapCapacity];
    size_t heapSize = 0;

    // DSPark 滤波器组（SuperFlux 已移除，保留供 DSPark 复用）
    uint32_t superfluxBandStarts[kMaxSuperFluxBands];
    uint32_t superfluxBandSizes[kMaxSuperFluxBands];
    uint32_t superfluxBandOffsets[kMaxSuperFluxBands];
    float superfluxWeights[kMaxSuperFluxWeights];
    size_t superfluxBandCount = 0;
    size_t detectorActiveBins = 0;
    size_t superfluxWeightCount = 0;

    float dsfluxCurrent[kMaxSuperFluxBands];
    float dsfluxMaxPrev[kMaxSuperFluxBands];
    float dsfluxHistory[kDsFluxWindow];
    float dsfluxScratch[kDsFluxWindow];
    size_t dsfluxPos = 0;
    size_t dsfluxFilled = 0;
    size_t dsfluxWindow = kDsFluxReferenceWindow;   // 当前历史窗长（帧），固定为基准值
    size_t dsfluxCooldown = 0;

    // sinc 重采样
    float sincTable[kSincTableSize + 1];
    struct SincKernel {
        float weights[2 * kMaxOutputRadius];
        float fraction = -1.0f;
        float cutoff = 0.0f;
        size_t radius = 0;
        float weightSum = 1.0f;
    };
    SincKernel inputKernel;
    SincKernel outputKernel;

    // 流状态
    size_t inputWrite = 0;
    size_t collectedSamples = 0;
    size_t silentSamples = 0;
    size_t previousActiveBins = 0;
    size_t samplesSinceFrame = 0;
    float synthesisSamplesToFrame = 0.0f;
    bool analysisStarted = false;
    uint64_t synthesisFrameStart = 0;
    uint64_t synthesisAvailable = 0;
    uint64_t synthesisClearedUntil = 0;
    double resamplePosition = 0.0;
    bool resamplerStarted = false;

    // 显示
    uint64_t inputPosition = 0;
    size_t columnSamples = 160;
    size_t displaySize = 144000;
    size_t displayColumns = kDisplayColumns;
    float env[kDisplayColumns * 2];
    size_t colIndex = 0;
    size_t colCount = 0;
    float colMin = 1.0f;
    float colMax = -1.0f;
    size_t totalColumns = 0;
    double marks[kMaxTransientMarks];
    size_t markCount = 0;
    double pendingOnsets[kMaxTransientMarks];
    float onsetBandConfidence[kMaxTransientMarks][kFluxBands];
    double lastCorrectionMark = -1.0;
    size_t onsetRead = 0;
    size_t onsetWrite = 0;

    // --------------------------------------------------------
    void init(float sr, size_t hop, int win) {
        sampleRate = sr;
        hopSize = hop;
        windowType = win;
        buildSizes();
        buildWindow();
        buildSincTable();
        buildSuperFluxFilterBank();
        reset();
    }

    void reinit(size_t hop, int win) {
        hopSize = hop;
        windowType = win;
        buildSizes();
        buildWindow();
        buildSuperFluxFilterBank();
        reset();
    }

    void buildSizes() {
        overlap = windowOverlap(windowType);
        windowSize = hopSize * overlap;
        halfWindow = windowSize >> 1;
        // 分析窗均使用两倍长度的 FFT，保留原有的输出起点。
        frameSize = 2 * windowSize;
        outputStart = (windowType == 1 ? nextPowerOfTwo(windowSize) : windowSize) - hopSize;
        numBins = frameSize / 2 + 1;
        jointShortSize = windowSize < kJointShortWindow ? windowSize : kJointShortWindow;
        fft.init(frameSize);
        // 检测器固定几何：窗与 FFT 长度均为 min(2048, windowSize)。
        // 帧时序仍由主链 analysisHop 驱动，但分析帧长固定，彻底消除 hop/窗敏感性。
        detWindowSize = windowSize < 2048 ? windowSize : 2048;
        detFrameSize = detWindowSize;
        detNumBins = detFrameSize / 2 + 1;
        detFft.init(detFrameSize);
        displayColumns = kDisplayColumns;
        displaySize = (size_t)(sampleRate * 3.0f);
        columnSamples = (displaySize + displayColumns - 1) / displayColumns;
        if (columnSamples == 0) columnSamples = 1;
    }

    void buildWindow() {
        const size_t L = windowSize;
        const float twopi = 6.283185307179586f;
        if (windowType == 0) { // hann
            for (size_t n = 0; n < L; ++n) {
                const float t = (float)n / (float)L;
                window[n] = 0.5f * (1.0f - cosf(twopi * t));
            }
        } else if (windowType == 1) { // bh3
            for (size_t n = 0; n < L; ++n) {
                const float t = (float)n / (float)L;
                window[n] = 0.4243801f - 0.4973406f * cosf(twopi * t) + 0.0782793f * cosf(2.0f * twopi * t);
            }
        } else if (isGaussianWindow(windowType)) {
            // 各旁瓣等级共用 σ。截断到 5–8 个 hop，改变旁瓣而保留主瓣的有效时宽。
            const float sigma = 0.80015186f * (float)hopSize;
            for (size_t n = 0; n < L; ++n) {
                const float t = ((float)n - (float)halfWindow) / sigma;
                window[n] = expf(-0.5f * t * t);
            }
        } else { // bh4
            for (size_t n = 0; n < L; ++n) {
                const float t = (float)n / (float)L;
                window[n] = 0.35875f - 0.48829f * cosf(twopi * t) + 0.14128f * cosf(2.0f * twopi * t)
                    - 0.01168f * cosf(3.0f * twopi * t);
            }
        }
        const float shortSigma = (float)jointShortSize / 8.0f;
        for (size_t n = 0; n < jointShortSize; ++n) {
            const float t = ((float)n - 0.5f * (float)jointShortSize) / shortSigma;
            jointShortWindow[n] = expf(-0.5f * t * t);
        }
        // 分析窗与合成窗的乘积在每个合成 hop 余数类中叠加为 1。
        for (size_t offset = 0; offset < hopSize; ++offset) {
            double sum = 0.0;
            for (size_t n = offset; n < L; n += hopSize) {
                sum += (double)window[n] * window[n];
            }
            const float gain = (float)(1.0 / sum);
            for (size_t n = offset; n < L; n += hopSize) {
                synthesisWindow[n] = window[n] * gain;
            }
        }
        // 瞬态检测器始终用 hann 窗（与主链 windowType 无关），长度 = detWindowSize（固定）
        for (size_t n = 0; n < detWindowSize; ++n) {
            const float t = (float)n / (float)detWindowSize;
            detWindow[n] = 0.5f * (1.0f - cosf(twopi * t));
        }
    }

    void buildSincTable() {
        const float step = (float)kSincRadius / (float)kSincTableSize;
        for (size_t i = 0; i <= kSincTableSize; ++i) {
            sincTable[i] = sincKernel((float)i * step);
        }
    }

    void buildSuperFluxFilterBank() {
        constexpr float kMinimumFrequency = 27.5f;
        constexpr float kMaximumFrequency = 16000.0f;
        constexpr int kBandsPerOctave = 24;
        uint32_t centers[kMaxSuperFluxBands + 2];
        size_t centerCount = 0;
        // 检测器用固定几何（detFrameSize/detNumBins），不随主链窗变化
        const float binHz = sampleRate / (float)detFrameSize;
        const float maximumFrequency = kMaximumFrequency < sampleRate * 0.5f * 0.999f
            ? kMaximumFrequency : sampleRate * 0.5f * 0.999f;

        for (int index = 0; centerCount < kMaxSuperFluxBands + 2; ++index) {
            const float frequency = kMinimumFrequency * exp2f((float)index / (float)kBandsPerOctave);
            if (frequency > maximumFrequency) break;
            uint32_t bin = (uint32_t)(frequency / binHz + 0.5f);
            if (bin > detNumBins - 1) bin = (uint32_t)(detNumBins - 1);
            if (centerCount == 0 || bin > centers[centerCount - 1]) {
                centers[centerCount++] = bin;
            }
        }

        superfluxBandCount = 0;
        detectorActiveBins = 0;
        superfluxWeightCount = 0;
        for (size_t c = 1; c + 1 < centerCount; ++c) {
            const uint32_t low = centers[c - 1];
            const uint32_t middle = centers[c];
            const uint32_t high = centers[c + 1];
            const size_t size = high - low + 1;
            if (low >= middle || middle >= high || superfluxBandCount == kMaxSuperFluxBands
                || superfluxWeightCount + size > kMaxSuperFluxWeights) {
                continue;
            }
            const size_t band = superfluxBandCount++;
            detectorActiveBins = high + 1;
            superfluxBandStarts[band] = low;
            superfluxBandSizes[band] = (uint32_t)size;
            superfluxBandOffsets[band] = (uint32_t)superfluxWeightCount;
            for (uint32_t bin = low; bin <= high; ++bin) {
                const float weight = bin <= middle
                    ? (float)(bin - low) / (float)(middle - low)
                    : (float)(high - bin) / (float)(high - middle);
                superfluxWeights[superfluxWeightCount++] = weight;
            }
        }
    }

    void reset() {
        for (size_t i = 0; i < kMaxWindow; ++i) inputRing[i] = 0.0f;
        for (size_t i = 0; i < kSynthesisRing; ++i) synthesisRing[i] = 0.0f;
        for (size_t i = 0; i < kInputResampleRing; ++i) inputResampleRing[i] = 0.0f;
        inputResamplePosition = 0.0;
        inputWrite = 0;
        collectedSamples = 0;
        silentSamples = 0;
        previousActiveBins = 0;
        samplesSinceFrame = 0;
        synthesisSamplesToFrame = 0.0f;
        analysisStarted = false;
        synthesisFrameStart = 0;
        jointHead = jointCount = jointPreviousBins = 0;
        jointOnsetRead = jointOnsetWrite = 0;
        jointMark = -1.0;
        synthesisAvailable = 0;
        synthesisClearedUntil = 0;
        resamplePosition = 0.0;
        resamplerStarted = false;
        currentRatio = targetRatio;
        inputPosition = 0;

        for (size_t i = 0; i < kDisplayColumns * 2; ++i) env[i] = 0.0f;
        colIndex = 0;
        colCount = 0;
        colMin = 1.0f;
        colMax = -1.0f;
        totalColumns = 0;
        for (size_t i = 0; i < kMaxTransientMarks; ++i) marks[i] = 0.0;
        markCount = 0;
        onsetRead = onsetWrite = 0;
        lastCorrectionMark = -1.0;

        resetPhaseState();
    }

    void resetPhaseState() {
        for (size_t i = 0; i < kMaxBins; ++i) {
            previousAnalysisPhase[i] = 0.0f;
            previousSynthPhase[i] = 0.0f;
            previousMag[i] = 0.0f;
        }
        for (size_t i = 0; i < kMaxSuperFluxBands; ++i) {
            dsfluxCurrent[i] = 0.0f;
            dsfluxMaxPrev[i] = 0.0f;
        }
        for (size_t i = 0; i < kDsFluxWindow; ++i) { dsfluxHistory[i] = 0.0f; dsfluxScratch[i] = 0.0f; }
        dsfluxPos = 0;
        dsfluxFilled = 0;
        dsfluxWindow = kDsFluxReferenceWindow;
        dsfluxCooldown = 0;
        firstFrame = true;
    }

    size_t cooldownFrames(float ms) const {
        const float samples = ms * sampleRate / 1000.0f;
        size_t f = (size_t)(samples / (float)hopSize + 0.5f);
        return f < 1 ? 1 : f;
    }

    // 冷却帧数按分析 hop 计算（用于随 analysisHop 自适应缩放的瞬态检测器）。
    // 高变调时 analysisHop 变小，用更小的 hop 换算才能得到相同的实际输入时间长度。
    size_t cooldownFramesForHop(float ms, size_t analysisHop) const {
        const float inputStep = inputResampleStep();
        const float samples = ms * sampleRate / (1000.0f * inputStep);
        const size_t hop = analysisHop > 0 ? analysisHop : 1;
        size_t frames = (size_t)(samples / (float)hop + 0.5f);
        return frames < 1 ? 1 : frames;
    }

    void setPitchShift(float semitones) {
        if (semitones > 24.0f) semitones = 24.0f;
        if (semitones < -24.0f) semitones = -24.0f;
        targetRatio = exp2f(semitones / 12.0f);
        if (!analysisStarted) currentRatio = targetRatio;
    }

    void setTransientMode(int mode) {
        if (transientMode == mode) return;
        transientMode = mode;
        onsetRead = onsetWrite = 0;
        lastCorrectionMark = -1.0;
        resetPhaseState();
    }

    void setCooldownMs(float ms) {
        cooldownMs = ms < 0.0f ? 0.0f : ms;
    }

    // --------------------------------------------------------
    void updateEnvelope(float left, float right) {
        const float low = left < right ? left : right;
        const float high = left > right ? left : right;
        if (low < colMin) colMin = low;
        if (high > colMax) colMax = high;
        ++colCount;
        if (colCount >= columnSamples) {
            env[2 * colIndex] = colMin;
            env[2 * colIndex + 1] = colMax;
            colIndex = (colIndex + 1) % displayColumns;
            colCount = 0;
            colMin = 1.0f;
            colMax = -1.0f;
            ++totalColumns;
        }
    }

    float processSample(float input) {
        const size_t write = (size_t)(inputPosition % kInputResampleRing);
        inputResampleRing[write] = input;
        ++inputPosition;

        // 两级重采样步长的乘积决定 PGHI 的时间伸缩率。
        const float inputStep = inputResampleStep();
        const float outputStep = currentRatio / inputStep;
        const float cutoff = inputStep > 1.0f ? 1.0f / inputStep : 1.0f;
        while ((uint64_t)inputResamplePosition + kInputRadius < inputPosition) {
            const uint64_t lower = (uint64_t)inputResamplePosition;
            const float sample = cutoff == 1.0f && inputResamplePosition == (double)lower
                ? inputResampleRing[(size_t)(lower % kInputResampleRing)]
                : interpolate(inputResampleRing, inputResamplePosition, cutoff, inputKernel);
            inputRing[inputWrite] = sample;
            silentSamples = sample != 0.0f ? 0 : silentSamples + (silentSamples < windowSize);
            advanceAnalysis(inputResamplePosition, inputStep * outputStep);
            inputResamplePosition += (double)inputStep;
        }
        return renderOutputSample(outputStep);
    }

    void advanceAnalysis(double sourcePosition, float stretch) {
        inputSourcePositions[inputWrite] = sourcePosition;
        inputWrite = (inputWrite + 1) % windowSize;
        collectedSamples = collectedSamples + 1 < windowSize ? collectedSamples + 1 : windowSize;
        ++samplesSinceFrame;

        if (!analysisStarted && collectedSamples == windowSize) {
            processFrame(hopSize);
            analysisStarted = true;
            samplesSinceFrame = 0;
            synthesisSamplesToFrame = (float)hopSize;
        } else if (analysisStarted) {
            synthesisSamplesToFrame -= stretch;
            if (synthesisSamplesToFrame <= 0.0f) {
                processFrame(samplesSinceFrame);
                samplesSinceFrame = 0;
                synthesisSamplesToFrame += (float)hopSize;
            }
        }
    }

    void queueOnset(double position, const float* bands) {
        if (onsetWrite - onsetRead == kMaxTransientMarks) ++onsetRead;
        const size_t index = onsetWrite++ % kMaxTransientMarks;
        pendingOnsets[index] = position;
        if (bands) {
            for (size_t band = 0; band < kFluxBands; ++band) onsetBandConfidence[index][band] = bands[band];
        }
    }

    bool consumeOnsets() {
        if (onsetRead == onsetWrite) return false;
        const size_t center = (inputWrite + halfWindow) % windowSize;
        // 以相邻主窗中心的中点为分界，已经确认且较早的起音由此帧接收。
        const double halfSourceHop = 0.5 * (double)hopSize * inputResampleStep() / currentRatio;
        const double end = inputSourcePositions[center] + halfSourceHop;
        bool reset = false;
        while (onsetRead != onsetWrite) {
            const double onset = pendingOnsets[onsetRead % kMaxTransientMarks];
            if (onset > end) break;
            putTransientMark(onset);
            ++onsetRead;
            reset = true;
        }
        return reset;
    }

    void queueJointOnset(double onset) {
        if (jointOnsetWrite - jointOnsetRead == kMaxTransientMarks) ++jointOnsetRead;
        jointOnsets[jointOnsetWrite++ % kMaxTransientMarks] = onset;
    }

    double jointSourceOffset() {
        const double center = inputSourcePositions[(inputWrite + halfWindow) % windowSize];
        const double radius = 0.012 * (double)sampleRate;
        while (jointOnsetRead != jointOnsetWrite && jointOnsets[jointOnsetRead % kMaxTransientMarks] < center - radius) {
            ++jointOnsetRead;
        }
        if (jointOnsetRead == jointOnsetWrite) return (double)kMaxFft;
        double onset = jointOnsets[jointOnsetRead % kMaxTransientMarks];
        if (onset > center + radius) return (double)kMaxFft;
        for (size_t i = jointOnsetRead + 1; i != jointOnsetWrite; ++i) {
            const double next = jointOnsets[i % kMaxTransientMarks];
            if (next + onset >= 2.0 * center) break;
            onset = next;
        }
        if (transientMode == 0 && jointMark != onset) {
            putTransientMark(onset);
            jointMark = onset;
        }
        return onset - center;
    }

    void processFrame(size_t analysisHop) {
        const bool shortFluxReset = transientMode == 2 && consumeOnsets();
        currentRatio += 0.25f * (targetRatio - currentRatio);
        const size_t correction = transientMode == kLocalPhaseMode && onsetRead != onsetWrite
            ? selectPhaseCorrection() : kMaxTransientMarks;
        const double jointOffset = jointPhase && jointOnsetRead != jointOnsetWrite
            ? jointSourceOffset() : (double)kMaxFft;
        if (silentSamples == windowSize) {
            if (!firstFrame) resetPhaseState();
            completeSynthesisFrame(0, true, jointOffset);
            return;
        }

        // 为输出抗混叠滤波保留过渡带，跳过更高频点的相位分析和传播。
        const float outputStep = currentRatio / inputResampleStep();
        const float band = outputStep > 1.25f ? 1.25f / outputStep : 1.0f;
        const size_t activeBins = 1 + (size_t)((float)(numBins - 1) * band);
        const bool detect = transientMode == 1 && !firstFrame && detectorActiveBins != 0;
        transformWindow(window, fftOutput, activeBins);
        analyseSpectrum(activeBins);
        if (detect) {
            windowInput(detWindow, detWindowSize, detInput);
            detFft.forward(detInput, detOutput, detectorActiveBins);
            for (size_t bin = 0; bin < detectorActiveBins; ++bin) {
                detMag[bin] = hypotf(detOutput[2 * bin], detOutput[2 * bin + 1]);
            }
        }

        const bool dsparkReset = detect && detectDsParkTransient(analysisHop);
        const bool locked = firstFrame || shortFluxReset || dsparkReset;
        if (locked) {
            for (size_t bin = 0; bin < activeBins; ++bin) currentSynthPhase[bin] = currentAnalysisPhase[bin];
            if (dsparkReset) {
                const size_t center = (inputWrite + (detWindowSize >> 1)) % windowSize;
                putTransientMark(inputSourcePositions[center]);
            }
        } else {
            for (size_t bin = previousActiveBins; bin < activeBins; ++bin) {
                previousMag[bin] = 0.0f;
                previousAnalysisPhase[bin] = currentAnalysisPhase[bin];
                previousSynthPhase[bin] = currentAnalysisPhase[bin];
            }
            propagatePghi(analysisHop, activeBins);
        }

        synthesizeSpectrum(activeBins);
        if (correction != kMaxTransientMarks && currentRatio != 1.0f) {
            correctTransientPhase(activeBins, outputStep, correction);
        }
        completeSynthesisFrame(activeBins, locked, jointOffset);

        for (size_t bin = 0; bin < activeBins; ++bin) {
            previousAnalysisPhase[bin] = currentAnalysisPhase[bin];
            previousSynthPhase[bin] = currentSynthPhase[bin];
            previousMag[bin] = currentMag[bin];
        }
        previousActiveBins = activeBins;
        firstFrame = false;
    }

    void analyseSpectrum(size_t activeBins) {
        size_t bin = 0;
        const v128_t zero = wasm_f32x4_splat(0.0f);
        const v128_t halfPi = wasm_f32x4_splat(1.5707963267948966f);
        const v128_t pi = wasm_f32x4_splat(3.141592653589793f);
        for (; bin + 4 <= activeBins; bin += 4) {
            const v128_t lo = wasm_v128_load(fftOutput + 2 * bin);
            const v128_t hi = wasm_v128_load(fftOutput + 2 * bin + 4);
            const v128_t re = wasm_i32x4_shuffle(lo, hi, 0, 2, 4, 6);
            const v128_t im = wasm_i32x4_shuffle(lo, hi, 1, 3, 5, 7);
            const v128_t energy = wasm_f32x4_add(wasm_f32x4_mul(re, re), wasm_f32x4_mul(im, im));
            wasm_v128_store(currentMag + bin, wasm_f32x4_sqrt(energy));

            // 将 atan2 的输入约化到 [0, 1]，沿用标量版的逼近系数。
            const v128_t absRe = wasm_f32x4_abs(re);
            const v128_t absIm = wasm_f32x4_abs(im);
            const v128_t largest = wasm_f32x4_max(absRe, absIm);
            const v128_t divisor = wasm_v128_bitselect(
                wasm_f32x4_splat(1.0f), largest, wasm_f32x4_eq(largest, zero));
            const v128_t x = wasm_f32x4_div(wasm_f32x4_min(absRe, absIm), divisor);
            const v128_t square = wasm_f32x4_mul(x, x);
            v128_t poly = wasm_f32x4_splat((float)kAtanPoly[kAtanDegree]);
            for (int i = kAtanDegree - 1; i >= 0; --i) {
                poly = wasm_f32x4_add(wasm_f32x4_splat((float)kAtanPoly[i]), wasm_f32x4_mul(square, poly));
            }
            v128_t phase = wasm_f32x4_mul(x, poly);
            phase = wasm_v128_bitselect(wasm_f32x4_sub(halfPi, phase), phase, wasm_f32x4_gt(absIm, absRe));
            phase = wasm_v128_bitselect(wasm_f32x4_sub(pi, phase), phase, wasm_f32x4_lt(re, zero));
            phase = wasm_v128_bitselect(wasm_f32x4_neg(phase), phase, wasm_f32x4_lt(im, zero));
            wasm_v128_store(currentAnalysisPhase + bin, phase);
        }
        for (; bin < activeBins; ++bin) {
            const float re = fftOutput[2 * bin];
            const float im = fftOutput[2 * bin + 1];
            currentMag[bin] = hypotf(re, im);
            currentAnalysisPhase[bin] = atan2f(im, re);
        }
    }

    void addSynthesis(uint64_t start, size_t windowOffset, size_t fftOffset, size_t length) {
        for (size_t i = 0; i < length; ++i) {
            const size_t index = (size_t)((start + windowOffset + i) % kSynthesisRing);
            synthesisRing[index] += fftTime[fftOffset + i] * synthesisWindow[windowOffset + i];
        }
    }

    void renderSynthesisFrame(uint64_t start, bool audible) {
        if (audible) {
            fft.inverse(fftOutput, fftTime);
            if (windowType != 2) {
                addSynthesis(start, 0, frameSize - halfWindow, halfWindow);
                addSynthesis(start, halfWindow, 0, halfWindow);
            } else {
                addSynthesis(start, 0, 0, windowSize);
            }
        }
        synthesisAvailable = start + hopSize + 1;
    }

    void buildJointEdges(JointPhaseFrame& frame, double sourceOffset) {
        const float inputOffset = (float)(sourceOffset / inputResampleStep());
        const float target = inputOffset * currentRatio;
        const size_t half = jointShortSize / 2;
        if (fabsf(inputOffset) >= 0.84f * (float)half || fabsf(target) >= 0.95f * (float)halfWindow) return;
        const size_t low = 1 + (size_t)(400.0f * (float)frameSize * inputResampleStep() / sampleRate);
        const size_t end = frame.bins < numBins - 1 ? frame.bins : numBins - 1;
        if (end < low + 2) return;

        const size_t begin = inputWrite + halfWindow - half;
        for (size_t i = 0; i < half; ++i) {
            fftInput[i] = inputRing[(begin + half + i) % windowSize] * jointShortWindow[half + i];
            fftInput[frameSize - half + i] = inputRing[(begin + i) % windowSize] * jointShortWindow[i];
        }
        for (size_t i = half; i < frameSize - half; ++i) fftInput[i] = 0.0f;
        fft.forward(fftInput, detOutput, end);

        float peak = 0.0f;
        for (size_t bin = low; bin < end; ++bin) {
            const float re = detOutput[2 * bin], im = detOutput[2 * bin + 1];
            const float power = re * re + im * im;
            if (power > peak) peak = power;
        }
        const float binWidth = 6.283185307179586f / (float)frameSize;
        const float tolerance = 0.002f * sampleRate / inputResampleStep() * binWidth;
        const float ramp = (target - inputOffset) * binWidth;
        const float center = windowType == 2 ? (float)halfWindow * binWidth : 0.0f;
        for (size_t bin = low + 1; bin < end; ++bin) {
            const float ar = detOutput[2 * bin - 2], ai = detOutput[2 * bin - 1];
            const float br = detOutput[2 * bin], bi = detOutput[2 * bin + 1];
            const float a = ar * ar + ai * ai, b = br * br + bi * bi;
            const float power = a < b ? a : b;
            if (power < peak * 0.0009f || power <= 1.0e-10f) continue;
            const float observed = atan2f(bi * ar - br * ai, br * ar + bi * ai);
            const float mismatch = fabsf(wrapToPi(observed + inputOffset * binWidth));
            if (mismatch >= tolerance) continue;
            const float base = currentSynthPhase[bin] - currentSynthPhase[bin - 1] + center;
            frame.gradient[bin] = wrapToPi(observed - ramp - base);
            const float strength = 4.0f * sqrtf(power / peak);
            frame.weight[bin] = (strength < 1.0f ? strength : 1.0f) * (1.0f - mismatch / tolerance);
            frame.hasConstraints = true;
        }
    }

    JointPhaseFrame& jointFrame(size_t row) {
        return jointFrames[(jointHead + row) % kJointFrames];
    }

    void solveJointPhase() {
        // 频率边匹配短窗群延迟，时间边保留 PGHI 的相位增量，提交过的帧作为固定边界。
        for (int sweep = 0; sweep < 6; ++sweep) {
            for (size_t row = 0; row < kJointFrames; ++row) {
                JointPhaseFrame& frame = jointFrame(row);
                if (frame.locked || frame.bins < 3) continue;
                for (size_t k = 1; k + 1 < frame.bins && k + 1 < numBins; ++k) {
                    const float left = frame.weight[k], right = frame.weight[k + 1];
                    float numerator = left * (frame.correction[k - 1] + frame.gradient[k])
                        + right * (frame.correction[k + 1] - frame.gradient[k + 1]);
                    float denominator = 0.08f + left + right;
                    constexpr float kTimeWeight = 0.25f;
                    if (row == 0) {
                        if (k < jointPreviousBins) {
                            numerator += kTimeWeight * jointPrevious[k];
                            denominator += kTimeWeight;
                        }
                    } else {
                        const JointPhaseFrame& prev = jointFrame(row - 1);
                        if (k < prev.bins) {
                            numerator += kTimeWeight * prev.correction[k];
                            denominator += kTimeWeight;
                        }
                    }
                    if (row + 1 < kJointFrames) {
                        const JointPhaseFrame& next = jointFrame(row + 1);
                        if (k < next.bins) {
                            numerator += kTimeWeight * next.correction[k];
                            denominator += kTimeWeight;
                        }
                    }
                    const float value = numerator / denominator;
                    frame.correction[k] = value > kJointPhaseLimit ? kJointPhaseLimit
                        : (value < -kJointPhaseLimit ? -kJointPhaseLimit : value);
                }
            }
        }
    }

    void completeSynthesisFrame(size_t bins, bool locked, double jointOffset) {
        const uint64_t start = synthesisFrameStart;
        synthesisFrameStart += hopSize;
        if (!jointPhase) {
            renderSynthesisFrame(start, bins != 0);
            return;
        }

        JointPhaseFrame& next = jointFrame(jointCount++);
        next.start = start;
        next.bins = bins;
        next.locked = locked;
        next.hasConstraints = false;
        for (size_t k = 0; k < bins; ++k) {
            next.spectrum[2 * k] = fftOutput[2 * k];
            next.spectrum[2 * k + 1] = fftOutput[2 * k + 1];
            next.weight[k] = next.gradient[k] = next.correction[k] = 0.0f;
        }
        if (!locked && currentRatio != 1.0f && jointOffset != (double)kMaxFft) buildJointEdges(next, jointOffset);
        if (jointCount < kJointFrames) return;

        bool constrained = false;
        for (size_t row = 0; row < kJointFrames; ++row) constrained |= jointFrame(row).hasConstraints;
        if (constrained) solveJointPhase();

        const JointPhaseFrame& ready = jointFrame(0);
        for (size_t k = 0; k < ready.bins; ++k) {
            const float phase = constrained ? ready.correction[k] : 0.0f;
            float re = ready.spectrum[2 * k], im = ready.spectrum[2 * k + 1];
            if (phase != 0.0f) {
                float sine, cosine;
                sinCos(phase, sine, cosine);
                const float rotated = re * cosine - im * sine;
                im = re * sine + im * cosine;
                re = rotated;
            }
            fftOutput[2 * k] = re;
            fftOutput[2 * k + 1] = im;
            jointPrevious[k] = phase;
        }
        jointPreviousBins = constrained ? ready.bins : 0;
        if (ready.bins != 0) {
            for (size_t i = 2 * ready.bins; i < frameSize + 2; ++i) fftOutput[i] = 0.0f;
        }
        renderSynthesisFrame(ready.start, ready.bins != 0);
        jointHead = (jointHead + 1) % kJointFrames;
        --jointCount;
    }

    void propagatePghi(size_t analysisHop, size_t activeBins) {
        for (size_t bin = 0; bin < activeBins; ++bin) processedBins[bin] = 0;
        heapSize = 0;
        for (size_t bin = 0; bin < activeBins; ++bin) {
            heapPush(previousMag[bin], (uint32_t)bin, true);
        }

        const float analysisScale = 6.283185307179586f * (float)analysisHop / (float)frameSize;
        const float synthesisScale = 6.283185307179586f * (float)hopSize / (float)frameSize;
        const float stretchRatio = (float)hopSize / (float)analysisHop;
        // 自然顺序窗的中心在 N/2。频率梯度先扣除这段线性相位，再按伸缩率传播。
        const float windowCenterPhase = windowType == 2
            ? 6.283185307179586f * (float)halfWindow / (float)frameSize : 0.0f;
        size_t processedCount = 0;
        while (processedCount < activeBins && heapSize > 0) {
            heapPop();
            const size_t bin = popBin;
            const bool isPrev = popIsPrev;
            if (isPrev) {
                if (processedBins[bin] != 0) continue;
                const float expected = analysisScale * (float)bin;
                const float residual = wrapToPi(currentAnalysisPhase[bin] - previousAnalysisPhase[bin] - expected);
                currentSynthPhase[bin] = wrapToPi(previousSynthPhase[bin]
                    + synthesisScale * (float)bin + stretchRatio * residual);
                processedBins[bin] = 1;
                ++processedCount;
                heapPush(currentMag[bin], (uint32_t)bin, false);
                continue;
            }
            if (bin + 1 < activeBins && processedBins[bin + 1] == 0) {
                const float delta = wrapToPi(currentAnalysisPhase[bin + 1] - currentAnalysisPhase[bin] + windowCenterPhase);
                currentSynthPhase[bin + 1] = wrapToPi(currentSynthPhase[bin] + stretchRatio * delta - windowCenterPhase);
                processedBins[bin + 1] = 1;
                ++processedCount;
                heapPush(currentMag[bin + 1], (uint32_t)(bin + 1), false);
            }
            if (bin > 0 && processedBins[bin - 1] == 0) {
                const float delta = wrapToPi(currentAnalysisPhase[bin - 1] - currentAnalysisPhase[bin] - windowCenterPhase);
                currentSynthPhase[bin - 1] = wrapToPi(currentSynthPhase[bin] + stretchRatio * delta + windowCenterPhase);
                processedBins[bin - 1] = 1;
                ++processedCount;
                heapPush(currentMag[bin - 1], (uint32_t)(bin - 1), false);
            }
        }
    }

    void heapPush(float magnitude, uint32_t bin, bool isPrev) {
        size_t index = heapSize++;
        while (index > 0) {
            const size_t parent = (index - 1) >> 1;
            if (heap[parent].magnitude >= magnitude) break;
            heap[index] = heap[parent];
            index = parent;
        }
        heap[index] = {magnitude, (bin << 1) | (uint32_t)isPrev};
    }

    size_t popBin = 0;
    bool popIsPrev = false;

    void heapPop() {
        const uint32_t binAndFrame = heap[0].binAndFrame;
        popBin = binAndFrame >> 1;
        popIsPrev = (binAndFrame & 1u) != 0;
        const HeapEntry last = heap[--heapSize];
        size_t index = 0;
        while (true) {
            const size_t left = index * 2 + 1;
            if (left >= heapSize) break;
            const size_t right = left + 1;
            const size_t largest = right < heapSize && heap[right].magnitude > heap[left].magnitude ? right : left;
            if (last.magnitude >= heap[largest].magnitude) break;
            heap[index] = heap[largest];
            index = largest;
        }
        heap[index] = last;
    }

    bool detectDsParkTransient(size_t analysisHop) {
        if (superfluxBandCount == 0) return false;
        float flux = 0.0f;
        // 沿用 DSPark 的检测增益标定，FFT 去掉零填充后窗内能量不变。
        constexpr float kReferenceWindowSize = 1024.0f;
        const float scale = kReferenceWindowSize / (float)detWindowSize;
        const size_t bc = superfluxBandCount;
        for (size_t band = 0; band < bc; ++band) {
            float magnitude = 0.0f;
            const size_t off = superfluxBandOffsets[band];
            const size_t size = superfluxBandSizes[band];
            for (size_t i = 0; i < size; ++i) {
                magnitude += detMag[superfluxBandStarts[band] + i] * superfluxWeights[off + i];
            }
            dsfluxCurrent[band] = log10f(magnitude * scale + 1.0f);
            if (!firstFrame) {
                const float d = dsfluxCurrent[band] - dsfluxMaxPrev[band];
                if (d > 0.0f) flux += d;
            }
        }
        flux /= (float)(bc > 1 ? bc : 1);

        // 窗口固定为基准帧数（由 resetPhaseState 设为 kDsFluxReferenceWindow）。
        // 高变调时 analysisHop 变小，但窗口不以帧数补齐——这里与已通过验证的本机
        // 参考实现保持一致：历史窗长按帧计保持恒定，仅阈值与冷却按 analysisHop 缩放。
        const size_t window = dsfluxWindow;

        bool rise = false;
        if (dsfluxFilled >= window) {
            for (size_t i = 0; i < window; ++i) dsfluxScratch[i] = dsfluxHistory[i];
            for (size_t i = 1; i < window; ++i) {
                const float v = dsfluxScratch[i];
                size_t j = i;
                while (j > 0 && dsfluxScratch[j - 1] > v) { dsfluxScratch[j] = dsfluxScratch[j - 1]; --j; }
                dsfluxScratch[j] = v;
            }
            // 阈值按分析 hop 缩放：变调时每帧频谱变化幅度改变，阈值需同步缩放。
            // bh3 (3-term Blackman-Harris) 旁瓣泄漏较 bh4 高（-61dB vs -92dB），
            // 扫频时能量在相邻对数频带间渗漏，会把渐进式扫频误读为瞬态。
            // 实测 chirp 扫频泄漏 flux 峰值落在 acid_mono 正常瞬态 flux 分布内，
            // 无法两全；故对 bh3 使用加倍的基准阈值（0.04），彻底消除扫频误判，
            // 代价是 bh3 对真实弱瞬态的灵敏度略降（acid +0st 命中 33→28）。
            const float scaledDelta = kDsFluxDelta * (float)analysisHop / (float)hopSize;
            rise = (flux - dsfluxScratch[window >> 1]) >= scaledDelta;
        }
        dsfluxHistory[dsfluxPos] = flux;
        dsfluxPos = (dsfluxPos + 1) % window;
        dsfluxFilled = dsfluxFilled + 1 < window ? dsfluxFilled + 1 : window;

        for (size_t band = 0; band < bc; ++band) {
            float maximum = dsfluxCurrent[band];
            if (band > 0 && dsfluxCurrent[band - 1] > maximum) maximum = dsfluxCurrent[band - 1];
            if (band + 1 < bc && dsfluxCurrent[band + 1] > maximum) maximum = dsfluxCurrent[band + 1];
            dsfluxMaxPrev[band] = maximum;
        }
        const bool transient = dsfluxCooldown == 0 && !firstFrame && rise;
        dsfluxCooldown = transient ? cooldownFramesForHop(cooldownMs, analysisHop)
            : (dsfluxCooldown > 0 ? dsfluxCooldown - 1 : 0);
        return transient;
    }

    void transformWindow(const float* weights, float* spectrum, size_t bins) {
        if (windowType != 2) {
            windowCenteredInput(weights, fftInput);
        } else {
            windowInput(weights, windowSize, fftInput);
            for (size_t i = windowSize; i < frameSize; ++i) fftInput[i] = 0.0f;
        }
        fft.forward(fftInput, spectrum, bins);
    }

    void windowInput(const float* weights, size_t length, float* frame) const {
        for (size_t i = 0; i < length; ++i) {
            frame[i] = inputRing[(inputWrite + i) % windowSize] * weights[i];
        }
    }

    void windowCenteredInput(const float* weights, float* frame) const {
        for (size_t i = 0; i < halfWindow; ++i) {
            frame[i] = inputRing[(inputWrite + halfWindow + i) % windowSize] * weights[halfWindow + i];
            frame[frameSize - halfWindow + i] = inputRing[(inputWrite + i) % windowSize] * weights[i];
        }
        for (size_t i = halfWindow; i < frameSize - halfWindow; ++i) frame[i] = 0.0f;
    }

    void synthesizeSpectrum(size_t activeBins) {
        for (size_t bin = 0; bin < activeBins; ++bin) {
            float sine, cosine;
            sinCos(currentSynthPhase[bin], sine, cosine);
            fftOutput[2 * bin] = currentMag[bin] * cosine;
            fftOutput[2 * bin + 1] = currentMag[bin] * sine;
        }
        for (size_t i = 2 * activeBins; i < frameSize + 2; ++i) fftOutput[i] = 0.0f;
        fftOutput[1] = 0.0f;
        fftOutput[2 * (numBins - 1) + 1] = 0.0f;
    }

    bool estimateBandDelay(PhaseCorrectionBand& band, float expected, float binWidth,
                           float centerPhase, float search, float maxDeviation) const {
        if (band.end - band.begin < 5) return false;
        float peak = 0.0f;
        for (size_t bin = band.begin; bin < band.end; ++bin) {
            if (currentMag[bin] > peak) peak = currentMag[bin];
        }
        if (peak <= 1.0e-7f) return false;
        float accepted = 0.0f, all = 0.0f, firstMoment = 0.0f, secondMoment = 0.0f;
        size_t pairs = 0;
        for (size_t bin = band.begin + 1; bin < band.end; ++bin) {
            const float a = currentMag[bin - 1], b = currentMag[bin];
            const float weight = a < b ? a : b;
            if (weight < peak * 0.1f) continue;
            all += weight;
            const float delta = currentSynthPhase[bin] - currentSynthPhase[bin - 1] + centerPhase;
            const float delay = -wrapToPi(delta + expected * binWidth) / binWidth;
            if (fabsf(delay) > search) continue;
            firstMoment += weight * delay;
            secondMoment += weight * delay * delay;
            accepted += weight;
            ++pairs;
        }
        if (pairs < 4 || accepted < 0.6f * all) return false;
        const float estimate = firstMoment / accepted;
        if (secondMoment / accepted - estimate * estimate > maxDeviation * maxDeviation) return false;
        band.delay = estimate;
        band.confidence *= accepted / all;
        return true;
    }

    void rotateCorrectedBand(const PhaseCorrectionBand& band, float shift, float binWidth) {
        const float center = 0.5f * (float)(band.begin + band.end - 1);
        const float fade = 0.15f * (float)(band.end - band.begin);
        for (size_t bin = band.begin; bin < band.end; ++bin) {
            const size_t left = bin - band.begin, right = band.end - bin - 1;
            const float edge = (float)(left < right ? left : right) / fade;
            const float taper = edge >= 1.0f ? 1.0f : edge * edge * (3.0f - 2.0f * edge);
            // 以频带中心的相位为参照，平滑施加局部斜率，边界回到原相位。
            const float phase = shift * binWidth * ((float)bin - center) * taper;
            float sine, cosine;
            sinCos(wrapToPi(phase), sine, cosine);
            const float re = fftOutput[2 * bin], im = fftOutput[2 * bin + 1];
            fftOutput[2 * bin] = re * cosine - im * sine;
            fftOutput[2 * bin + 1] = re * sine + im * cosine;
        }
    }

    size_t selectPhaseCorrection() {
        const double sourceCenter = inputSourcePositions[(inputWrite + halfWindow) % windowSize];
        const double radius = (double)sampleRate * 0.012;
        while (onsetRead != onsetWrite && pendingOnsets[onsetRead % kMaxTransientMarks] < sourceCenter - radius) {
            ++onsetRead;
        }
        if (onsetRead == onsetWrite) return kMaxTransientMarks;
        size_t index = onsetRead % kMaxTransientMarks;
        double onset = pendingOnsets[index];
        if (onset > sourceCenter + radius) return kMaxTransientMarks;
        for (size_t i = onsetRead + 1; i != onsetWrite; ++i) {
            const size_t next = i % kMaxTransientMarks;
            if (pendingOnsets[next] + onset >= 2.0 * sourceCenter) break;
            index = next;
            onset = pendingOnsets[index];
        }

        if (lastCorrectionMark != onset) {
            putTransientMark(onset);
            lastCorrectionMark = onset;
        }
        return index;
    }

    void correctTransientPhase(size_t bins, float outputStep, size_t index) {
        const double sourceCenter = inputSourcePositions[(inputWrite + halfWindow) % windowSize];
        const float expected = (float)(pendingOnsets[index] - sourceCenter) * outputStep;
        const float search = 0.0025f * sampleRate * outputStep;
        if (fabsf(expected) + search > (float)halfWindow) return;

        const float binWidth = 6.283185307179586f / (float)frameSize;
        const float centerPhase = windowType == 2 ? binWidth * (float)halfWindow : 0.0f;
        const float bandWidth = 0.5f * (float)frameSize * inputResampleStep() / (float)kFluxBands;
        const float deviation = 0.0006f * sampleRate * outputStep;
        PhaseCorrectionBand reliable[kFluxBands];
        float delays[kFluxBands];
        size_t count = 0;
        const size_t endBin = bins < numBins - 1 ? bins : numBins - 1;
        for (size_t b = 0; b < kFluxBands; ++b) {
            const float confidence = onsetBandConfidence[index][b];
            if (confidence < 0.35f) continue;
            const size_t begin = (size_t)ceilf((float)b * bandWidth) + 1;
            const size_t next = (size_t)ceilf((float)(b + 1) * bandWidth) + 1;
            if (begin >= endBin) break;
            PhaseCorrectionBand band{begin, next < endBin ? next : endBin, 0.0f, confidence};
            if (!estimateBandDelay(band, expected, binWidth, centerPhase, search, deviation)) continue;
            reliable[count] = band;
            size_t insert = count++;
            while (insert > 0 && delays[insert - 1] > band.delay) {
                delays[insert] = delays[insert - 1];
                --insert;
            }
            delays[insert] = band.delay;
        }
        if (count < 3) return;

        // 用可靠频带自身的中位到达时间作参照，避免把检测误差变成整次起音的平移。
        const float reference = 0.5f * (delays[(count - 1) / 2] + delays[count / 2]);
        for (size_t i = 0; i < count; ++i) {
            const PhaseCorrectionBand& band = reliable[i];
            const float difference = band.delay - reference;
            if (fabsf(difference) < 0.0001f * sampleRate * outputStep) continue;
            const float bounded = difference > deviation ? deviation : (difference < -deviation ? -deviation : difference);
            rotateCorrectedBand(band, bounded * band.confidence, binWidth);
        }
    }

    float sincWeight(float distance, float cutoff) const {
        const float tableScale = (float)kSincTableSize / (float)kSincRadius;
        const float tablePos = distance * cutoff * tableScale;
        if (tablePos >= (float)kSincTableSize) return 0.0f;
        const size_t index = (size_t)tablePos;
        return sincTable[index] + (tablePos - (float)index) * (sincTable[index + 1] - sincTable[index]);
    }

    template <size_t RingSize>
    float interpolate(const float (&ring)[RingSize], double position, float cutoff, SincKernel& kernel) {
        const uint64_t lower = (uint64_t)position;
        const float fraction = (float)(position - (double)lower);
        if (fraction != kernel.fraction || cutoff != kernel.cutoff) {
            kernel.fraction = fraction;
            kernel.cutoff = cutoff;
            kernel.radius = (size_t)ceilf((float)kSincRadius / cutoff);
            kernel.weightSum = 0.0f;
            for (size_t i = 0; i < 2 * kernel.radius; ++i) {
                const float tap = (float)((int)i + 1 - (int)kernel.radius);
                kernel.weights[i] = sincWeight(fabsf(fraction - tap), cutoff);
                kernel.weightSum += kernel.weights[i];
            }
        }
        const size_t start = (size_t)((lower + 1 - kernel.radius) % RingSize);
        // RingSize 是 2 的幂，启动时负采样索引映射到已清零的环尾。
        float output = 0.0f;
        for (size_t i = 0; i < 2 * kernel.radius; ++i) {
            output += ring[(start + i) % RingSize] * kernel.weights[i];
        }
        return output / kernel.weightSum;
    }

    float renderOutputSample(float outputStep) {
        constexpr size_t radius = kMaxOutputRadius;
        const float cutoff = outputStep > 1.0f ? 1.0f / outputStep : 1.0f;
        if (!resamplerStarted) {
            if (synthesisAvailable <= outputStart + hopSize + radius) return 0.0f;
            resamplePosition = (double)outputStart;
            resamplerStarted = true;
        }

        const uint64_t lower = (uint64_t)resamplePosition;
        if (lower + radius >= synthesisAvailable) return 0.0f;
        const float output = interpolate(synthesisRing, resamplePosition, cutoff, outputKernel);
        resamplePosition += (double)outputStep;
        const uint64_t floorPosition = (uint64_t)resamplePosition;
        const uint64_t clearUntil = floorPosition > radius ? floorPosition - radius : 0;
        while (synthesisClearedUntil < clearUntil) {
            synthesisRing[(size_t)(synthesisClearedUntil % kSynthesisRing)] = 0.0f;
            ++synthesisClearedUntil;
        }
        return output;
    }

    void putTransientMark(double position) {
        marks[markCount++ % kMaxTransientMarks] = position;
    }
};

// Mid 和 Side 使用独立的相位与瞬态状态，参数和帧时钟一致。
Shifter g_mid;
Shifter g_side;
ShortFluxDetector g_shortFlux;
float g_in[2][kIoCapacity];
float g_out[2][kIoCapacity];

} // namespace

// ============================================================
// 导出（wasm32 指针即 i32；JS 通过 instance.exports 直接调用）
// ============================================================
extern "C" {

void init(int sr, int hop, int win) {
    g_mid.init((float)sr, (size_t)hop, win);
    g_side.init((float)sr, (size_t)hop, win);
    g_shortFlux.init();
}

void process(int frameCount) {
    if (frameCount <= 0 || (size_t)frameCount > kIoCapacity) return;
    const bool localPhase = g_mid.transientMode == kLocalPhaseMode;
    const bool resetWithFlux = localPhase || g_mid.transientMode == 2;
    const bool useShortFlux = resetWithFlux || g_mid.jointPhase;
    const double cooldownSamples = (double)g_mid.cooldownMs * g_mid.sampleRate / 1000.0;
    for (int i = 0; i < frameCount; ++i) {
        const float left = g_in[0][i];
        const float right = g_in[1][i];
        g_mid.updateEnvelope(left, right);
        const float midInput = 0.5f * (left + right);
        const float sideInput = 0.5f * (left - right);
        if (useShortFlux) {
            const double onset = g_shortFlux.push(midInput, sideInput, g_mid.inputPosition, cooldownSamples, localPhase);
            if (onset >= 0.0) {
                if (resetWithFlux) {
                    const float* bands = localPhase ? g_shortFlux.onsetBands() : nullptr;
                    g_mid.queueOnset(onset, bands);
                    g_side.queueOnset(onset, bands);
                }
                if (g_mid.jointPhase) {
                    g_mid.queueJointOnset(onset);
                    g_side.queueJointOnset(onset);
                }
            }
        }
        const float mid = g_mid.processSample(midInput);
        const float side = g_side.processSample(sideInput);
        g_out[0][i] = mid + side;
        g_out[1][i] = mid - side;
    }
}

void set_pitch_shift(float semitones) {
    g_mid.setPitchShift(semitones);
    g_side.setPitchShift(semitones);
}
void set_transient_mode(int mode) {
    if ((mode == 2 || mode == kLocalPhaseMode) && g_mid.transientMode != mode) g_shortFlux.reset();
    g_mid.setTransientMode(mode);
    g_side.setTransientMode(mode);
}
void set_phase_integration(int mode) {
    const bool joint = mode == 1;
    if (g_mid.jointPhase == joint) return;
    g_mid.jointPhase = g_side.jointPhase = joint;
    g_mid.reset();
    g_side.reset();
    g_shortFlux.reset();
}
void set_cooldown_ms(float ms) {
    g_mid.setCooldownMs(ms);
    g_side.setCooldownMs(ms);
}
void reinit(int hop, int win) {
    g_mid.reinit((size_t)hop, win);
    g_side.reinit((size_t)hop, win);
    g_shortFlux.reset();
}
void reset() {
    g_mid.reset();
    g_side.reset();
    g_shortFlux.reset();
}

float* in_ptr() { return g_in[0]; }
float* out_ptr() { return g_out[0]; }
float* in_right_ptr() { return g_in[1]; }
float* out_right_ptr() { return g_out[1]; }
float* env_ptr() { return g_mid.env; }
double* marks_ptr() { return g_mid.marks; }

int mark_count() { return (int)g_mid.markCount; }
int col_index() { return (int)g_mid.colIndex; }
int total_columns() { return (int)g_mid.totalColumns; }
int hop() { return (int)g_mid.hopSize; }
int window_size() { return (int)g_mid.windowSize; }
int fft_size() { return (int)g_mid.frameSize; }
int window_type() { return g_mid.windowType; }
int display_size() { return (int)g_mid.displaySize; }
int columns() { return (int)g_mid.displayColumns; }
double position() { return (double)g_mid.inputPosition; }
double ratio() { return (double)g_mid.currentRatio; }

} // extern "C"
