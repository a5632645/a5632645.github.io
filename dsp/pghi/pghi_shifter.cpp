// pghi_shifter.cpp — 实时 PGHI 移调器（WebAssembly 版）
//
// 从 qwqdsp/playing/playing.cpp 的 RealtimePitchShifter 移植，
// 并带上浏览器版的新特性：HOP/窗函数运行时参数化、统一冷却时间（毫秒）、
// 3 种瞬态检测（None / SuperFlux / DSPark）、900 列波形包络显示。
//
// 编译（clang wasm32，无需 emscripten / libc）：
//   clang --target=wasm32 -O3 -std=c++17 -nostdlib -fno-exceptions -fno-rtti \
//     -Wl,--no-entry -Wl,--initial-memory=33554432 \
//     -Wl,--export=init -Wl,--export=process ... \
//     pghi_shifter.cpp -o pghi_shifter.wasm
//
// 内存布局：固定最大容量（hop<=1024, overlap<=8, fft<=16384），全局单例，
// 无动态分配，memory 不增长，JS 端视图地址稳定。

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
static const double kAtanPoly[13] = {
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

// atan：|x|≤1 用 minimax 多项式，配合 atan(x)+atan(1/x)=π/2
static double atanPoly(double u) {
    double p = kAtanPoly[12];
    for (int i = 11; i >= 0; --i) p = p * u + kAtanPoly[i];
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
constexpr size_t kSincTableSize = 2048;
constexpr size_t kMaxTransientMarks = 32;
constexpr size_t kDisplayColumns = 900;

// 每窗 COLA 重叠因子与 OLA 增益（对应 pitch_shifter_rt.hpp WindowTraits）
float windowOlaGain(int windowType) {
    switch (windowType) {
        case 0: return 2.0f / 3.0f;        // hann
        case 1: return 0.5431781f;         // blackman-harris 3-term
        default: return 0.4845649f;        // blackman-harris 4-term
    }
}
size_t windowOverlap(int windowType) {
    switch (windowType) {
        case 0: return 4;
        case 1: return 6;
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
    size_t logN;
    uint32_t rev[kMaxFft];
    float cosT[kMaxFft / 2];
    float sinT[kMaxFft / 2];
    float reBuf[kMaxFft];
    float imBuf[kMaxFft];

    void init(size_t fftSize) {
        n = fftSize;
        logN = 0;
        size_t t = fftSize;
        while (t > 1) { t >>= 1; ++logN; }
        for (size_t i = 0; i < fftSize; ++i) {
            uint32_t r = 0;
            for (size_t b = 0; b < logN; ++b) r = (r << 1) | ((uint32_t)(i >> b) & 1u);
            rev[i] = r;
        }
        // 固定 16384 twiddle 表
        for (size_t k = 0; k < kMaxFft / 2; ++k) {
            const float a = -6.283185307179586f * (float)k / (float)kMaxFft;
            cosT[k] = cosf(a);
            sinT[k] = sinf(a);
        }
    }

    // 实输入 x[n] -> CCS 谱 ccs[n+2]
    void forward(const float* x, float* ccs) {
        const size_t sz = n;
        for (size_t i = 0; i < sz; ++i) {
            reBuf[rev[i]] = x[i];
            imBuf[rev[i]] = 0.0f;
        }
        transform(1);
        ccs[0] = reBuf[0];
        ccs[1] = 0.0f;
        const size_t h = sz >> 1;
        for (size_t k = 1; k < h; ++k) {
            ccs[2 * k] = reBuf[k];
            ccs[2 * k + 1] = imBuf[k];
        }
        ccs[sz] = reBuf[h];
        ccs[sz + 1] = 0.0f;
    }

    // CCS 谱 ccs[n+2] -> 实输出 out[n]（1/N）
    void inverse(const float* ccs, float* out) {
        const size_t sz = n;
        const size_t h = sz >> 1;
        reBuf[rev[0]] = ccs[0];
        imBuf[rev[0]] = 0.0f;
        reBuf[rev[h]] = ccs[sz];
        imBuf[rev[h]] = 0.0f;
        for (size_t k = 1; k < h; ++k) {
            const float r0 = ccs[2 * k], i0 = ccs[2 * k + 1];
            reBuf[rev[k]] = r0;
            imBuf[rev[k]] = i0;
            reBuf[rev[sz - k]] = r0;
            imBuf[rev[sz - k]] = -i0;
        }
        transform(-1);
        const float inv = 1.0f / (float)sz;
        for (size_t i = 0; i < sz; ++i) out[i] = reBuf[i] * inv;
    }

    void transform(int sign) {
        const size_t sz = n;
        size_t len = 2;
        while (len <= sz) {
            const size_t half = len >> 1;
            const size_t step = (kMaxFft / len) | 0; // 固定表步进
            for (size_t i = 0; i < sz; i += len) {
                size_t tw = 0;
                for (size_t k = 0; k < half; ++k) {
                    const float wr = cosT[tw];
                    const float wi = sign > 0 ? sinT[tw] : -sinT[tw];
                    const size_t j = i + k, m = j + half;
                    const float tr = reBuf[m] * wr - imBuf[m] * wi;
                    const float ti = reBuf[m] * wi + imBuf[m] * wr;
                    reBuf[m] = reBuf[j] - tr;
                    imBuf[m] = imBuf[j] - ti;
                    reBuf[j] += tr;
                    imBuf[j] += ti;
                    tw += step;
                }
            }
            len <<= 1;
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
    int windowType = 1; // 0=hann 1=bh3 2=bh4
    size_t overlap = 6;
    size_t windowSize = 3072;
    size_t halfWindow = 1536;
    size_t frameSize = 8192;
    size_t numBins = 4097;
    float olaGain = 0.5431781f;
    float cooldownMs = 64.0f;

    float targetRatio = 1.0f;
    float currentRatio = 1.0f;
    int transientMode = 2; // DSPark
    bool firstFrame = true;

    // FFT
    FftCore fft;
    float fftInput[kMaxFft];
    float fftOutput[kMaxFft + 2];
    float fftTime[kMaxFft];

    // 窗 / 环
    float window[kMaxWindow];
    float inputRing[kMaxWindow];
    float synthesisRing[kSynthesisRing];

    // bin 状态
    float currentRe[kMaxBins];
    float currentIm[kMaxBins];
    float currentMag[kMaxBins];
    float currentAnalysisPhase[kMaxBins];
    float currentSynthPhase[kMaxBins];
    float previousAnalysisPhase[kMaxBins];
    float previousSynthPhase[kMaxBins];
    float previousMag[kMaxBins];

    // PGHI 堆
    unsigned char processedBins[kMaxBins];
    float heapMag[kHeapCapacity];
    uint32_t heapBin[kHeapCapacity];
    unsigned char heapIsPrev[kHeapCapacity];
    size_t heapSize = 0;

    // SuperFlux / DSPark 共用滤波器组
    uint32_t superfluxBandStarts[kMaxSuperFluxBands];
    uint32_t superfluxBandSizes[kMaxSuperFluxBands];
    uint32_t superfluxBandOffsets[kMaxSuperFluxBands];
    float superfluxWeights[kMaxSuperFluxWeights];
    float superfluxCurrent[kMaxSuperFluxBands];
    float superfluxPreviousMax[kMaxSuperFluxBands];
    size_t superfluxBandCount = 0;
    size_t superfluxWeightCount = 0;
    size_t superfluxCooldown = 0;

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

    // 流状态
    size_t inputWrite = 0;
    size_t collectedSamples = 0;
    size_t samplesSinceFrame = 0;
    float samplesToFrame = 0.0f;
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
        frameSize = nextPowerOfTwo(windowSize * 2);
        numBins = frameSize / 2 + 1;
        olaGain = windowOlaGain(windowType);
        fft.init(frameSize);
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
        } else { // bh4
            for (size_t n = 0; n < L; ++n) {
                const float t = (float)n / (float)L;
                window[n] = 0.35875f - 0.48829f * cosf(twopi * t) + 0.14128f * cosf(2.0f * twopi * t)
                    - 0.01168f * cosf(3.0f * twopi * t);
            }
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
        const float binHz = sampleRate / (float)frameSize;
        const float maximumFrequency = kMaximumFrequency < sampleRate * 0.5f * 0.999f
            ? kMaximumFrequency : sampleRate * 0.5f * 0.999f;

        for (int index = 0; centerCount < kMaxSuperFluxBands + 2; ++index) {
            const float frequency = kMinimumFrequency * exp2f((float)index / (float)kBandsPerOctave);
            if (frequency > maximumFrequency) break;
            uint32_t bin = (uint32_t)(frequency / binHz + 0.5f);
            if (bin > numBins - 1) bin = (uint32_t)(numBins - 1);
            if (centerCount == 0 || bin > centers[centerCount - 1]) {
                centers[centerCount++] = bin;
            }
        }

        superfluxBandCount = 0;
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
        inputWrite = 0;
        collectedSamples = 0;
        samplesSinceFrame = 0;
        samplesToFrame = 0.0f;
        analysisStarted = false;
        synthesisFrameStart = 0;
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

        resetPhaseState();
    }

    void resetPhaseState() {
        for (size_t i = 0; i < kMaxBins; ++i) {
            previousAnalysisPhase[i] = 0.0f;
            previousSynthPhase[i] = 0.0f;
            previousMag[i] = 0.0f;
        }
        for (size_t i = 0; i < kMaxSuperFluxBands; ++i) {
            superfluxCurrent[i] = 0.0f;
            superfluxPreviousMax[i] = 0.0f;
            dsfluxCurrent[i] = 0.0f;
            dsfluxMaxPrev[i] = 0.0f;
        }
        for (size_t i = 0; i < kDsFluxWindow; ++i) { dsfluxHistory[i] = 0.0f; dsfluxScratch[i] = 0.0f; }
        dsfluxPos = 0;
        dsfluxFilled = 0;
        dsfluxWindow = kDsFluxReferenceWindow;
        dsfluxCooldown = 0;
        superfluxCooldown = 0;
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
        const float samples = ms * sampleRate / 1000.0f;
        const size_t hop = analysisHop > 0 ? analysisHop : 1;
        size_t frames = (size_t)(samples / (float)hop + 0.5f);
        return frames < 1 ? 1 : frames;
    }

    void setPitchShift(float semitones) {
        if (semitones > 24.0f) semitones = 24.0f;
        if (semitones < -24.0f) semitones = -24.0f;
        targetRatio = exp2f(semitones / 12.0f);
        if (firstFrame) currentRatio = targetRatio;
    }

    void setTransientMode(int mode) {
        if (transientMode == mode) return;
        transientMode = mode;
        resetPhaseState();
    }

    void setCooldownMs(float ms) {
        cooldownMs = ms < 0.0f ? 0.0f : ms;
    }

    // --------------------------------------------------------
    void process(const float* input, float* output, size_t frameCount) {
        for (size_t i = 0; i < frameCount; ++i) {
            const float v = input[i];
            inputRing[inputWrite] = v;
            inputWrite = (inputWrite + 1) % windowSize;
            collectedSamples = collectedSamples + 1 < windowSize ? collectedSamples + 1 : windowSize;
            ++samplesSinceFrame;
            ++inputPosition;

            // 显示列包络
            if (v < colMin) colMin = v;
            if (v > colMax) colMax = v;
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

            if (!analysisStarted && collectedSamples == windowSize) {
                processFrame(hopSize);
                analysisStarted = true;
                samplesSinceFrame = 0;
                samplesToFrame = (float)hopSize / currentRatio;
            } else if (analysisStarted) {
                samplesToFrame -= 1.0f;
                if (samplesToFrame <= 0.0f) {
                    processFrame(samplesSinceFrame < 1 ? 1 : samplesSinceFrame);
                    samplesSinceFrame = 0;
                    samplesToFrame += (float)hopSize / currentRatio;
                }
            }
            output[i] = renderOutputSample();
        }
    }

    void processFrame(size_t analysisHop) {
        currentRatio += 0.25f * (targetRatio - currentRatio);
        const size_t halfW = halfWindow;
        const size_t iw = inputWrite;
        const size_t wS = windowSize;

        // PGHI 居中分半窗
        for (size_t i = 0; i < frameSize; ++i) fftInput[i] = 0.0f;
        for (size_t i = 0; i < halfW; ++i) {
            fftInput[i] = inputRing[(iw + halfW + i) % wS] * window[halfW + i];
        }
        const size_t pad = frameSize - halfW;
        for (size_t i = 0; i < halfW; ++i) {
            fftInput[pad + i] = inputRing[(iw + i) % wS] * window[i];
        }
        fft.forward(fftInput, fftOutput);

        for (size_t bin = 0; bin < numBins; ++bin) {
            const float re = fftOutput[2 * bin];
            const float im = fftOutput[2 * bin + 1];
            currentRe[bin] = re;
            currentIm[bin] = im;
            currentMag[bin] = hypotf(re, im);
            currentAnalysisPhase[bin] = atan2f(im, re);
        }

        bool resetPhase = firstFrame;
        if (!firstFrame) {
            if (transientMode == 1) resetPhase = detectSuperFluxTransient();
            else if (transientMode == 2) resetPhase = detectDsParkTransient(analysisHop);
        }

        if (resetPhase) {
            for (size_t bin = 0; bin < numBins; ++bin) currentSynthPhase[bin] = currentAnalysisPhase[bin];
            if (!firstFrame) recordTransientMark();
        } else {
            propagatePghi(analysisHop);
        }

        synthesizeSpectrum();
        fft.inverse(fftOutput, fftTime);

        const size_t fs = frameSize;
        for (size_t i = 0; i < halfW; ++i) {
            const size_t index = (size_t)((synthesisFrameStart + i) % kSynthesisRing);
            const size_t source = fs - halfW + i;
            synthesisRing[index] += fftTime[source] * window[i] * olaGain;
        }
        for (size_t i = 0; i < halfW; ++i) {
            const size_t index = (size_t)((synthesisFrameStart + halfW + i) % kSynthesisRing);
            const size_t source = i;
            synthesisRing[index] += fftTime[source] * window[halfW + i] * olaGain;
        }
        synthesisAvailable = synthesisFrameStart + hopSize + 1;
        synthesisFrameStart += hopSize;

        for (size_t bin = 0; bin < numBins; ++bin) {
            previousAnalysisPhase[bin] = currentAnalysisPhase[bin];
            previousSynthPhase[bin] = currentSynthPhase[bin];
            previousMag[bin] = currentMag[bin];
        }
        firstFrame = false;
    }

    void propagatePghi(size_t analysisHop) {
        for (size_t bin = 0; bin < numBins; ++bin) processedBins[bin] = 0;
        heapSize = 0;
        for (size_t bin = 0; bin < numBins; ++bin) {
            heapPush(previousMag[bin], (uint32_t)bin, true);
        }

        const float analysisScale = 6.283185307179586f * (float)analysisHop / (float)frameSize;
        const float synthesisScale = 6.283185307179586f * (float)hopSize / (float)frameSize;
        const float stretchRatio = (float)hopSize / (float)analysisHop;
        size_t processedCount = 0;
        while (processedCount < numBins && heapSize > 0) {
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
            if (bin + 1 < numBins && processedBins[bin + 1] == 0) {
                const float delta = wrapToPi(currentAnalysisPhase[bin + 1] - currentAnalysisPhase[bin]);
                currentSynthPhase[bin + 1] = wrapToPi(currentSynthPhase[bin] + stretchRatio * delta);
                processedBins[bin + 1] = 1;
                ++processedCount;
                heapPush(currentMag[bin + 1], (uint32_t)(bin + 1), false);
            }
            if (bin > 0 && processedBins[bin - 1] == 0) {
                const float delta = wrapToPi(currentAnalysisPhase[bin - 1] - currentAnalysisPhase[bin]);
                currentSynthPhase[bin - 1] = wrapToPi(currentSynthPhase[bin] + stretchRatio * delta);
                processedBins[bin - 1] = 1;
                ++processedCount;
                heapPush(currentMag[bin - 1], (uint32_t)(bin - 1), false);
            }
        }
    }

    void heapPush(float magnitude, uint32_t bin, bool isPrev) {
        if (heapSize == kHeapCapacity) return;
        size_t index = heapSize++;
        heapMag[index] = magnitude;
        heapBin[index] = bin;
        heapIsPrev[index] = isPrev ? 1 : 0;
        while (index > 0) {
            const size_t parent = (index - 1) >> 1;
            if (heapMag[parent] >= heapMag[index]) break;
            size_t t;
            float ft;
            ft = heapMag[parent]; heapMag[parent] = heapMag[index]; heapMag[index] = ft;
            t = heapBin[parent]; heapBin[parent] = heapBin[index]; heapBin[index] = t;
            t = heapIsPrev[parent]; heapIsPrev[parent] = heapIsPrev[index]; heapIsPrev[index] = t;
            index = parent;
        }
    }

    size_t popBin = 0;
    bool popIsPrev = false;

    void heapPop() {
        popBin = heapBin[0];
        popIsPrev = heapIsPrev[0] == 1;
        --heapSize;
        heapMag[0] = heapMag[heapSize];
        heapBin[0] = heapBin[heapSize];
        heapIsPrev[0] = heapIsPrev[heapSize];
        size_t index = 0;
        while (true) {
            const size_t left = index * 2 + 1;
            if (left >= heapSize) break;
            const size_t right = left + 1;
            const size_t largest = right < heapSize && heapMag[right] > heapMag[left] ? right : left;
            if (heapMag[index] >= heapMag[largest]) break;
            size_t t;
            float ft;
            ft = heapMag[index]; heapMag[index] = heapMag[largest]; heapMag[largest] = ft;
            t = heapBin[index]; heapBin[index] = heapBin[largest]; heapBin[largest] = t;
            t = heapIsPrev[index]; heapIsPrev[index] = heapIsPrev[largest]; heapIsPrev[largest] = t;
            index = largest;
        }
    }

    bool detectSuperFluxTransient() {
        if (superfluxBandCount == 0) return false;
        float flux = 0.0f;
        constexpr float kReferenceFrameSize = 4096.0f;
        const float scale = kReferenceFrameSize / (float)frameSize;
        const size_t bc = superfluxBandCount;
        for (size_t band = 0; band < bc; ++band) {
            float magnitude = 0.0f;
            const size_t off = superfluxBandOffsets[band];
            const size_t size = superfluxBandSizes[band];
            for (size_t i = 0; i < size; ++i) {
                magnitude += currentMag[superfluxBandStarts[band] + i] * superfluxWeights[off + i];
            }
            superfluxCurrent[band] = log10f(magnitude * scale + 1.0f);
            if (!firstFrame) {
                const float d = superfluxCurrent[band] - superfluxPreviousMax[band];
                if (d > 0.0f) flux += d;
            }
        }
        for (size_t band = 0; band < bc; ++band) {
            float maximum = superfluxCurrent[band];
            if (band > 0 && superfluxCurrent[band - 1] > maximum) maximum = superfluxCurrent[band - 1];
            if (band + 1 < bc && superfluxCurrent[band + 1] > maximum) maximum = superfluxCurrent[band + 1];
            superfluxPreviousMax[band] = maximum;
        }
        const bool transient = superfluxCooldown == 0 && !firstFrame && flux / (float)bc > 0.03f;
        superfluxCooldown = transient ? cooldownFrames(cooldownMs)
            : (superfluxCooldown > 0 ? superfluxCooldown - 1 : 0);
        return transient;
    }

    bool detectDsParkTransient(size_t analysisHop) {
        if (superfluxBandCount == 0) return false;
        float flux = 0.0f;
        constexpr float kReferenceFrameSize = 2048.0f;
        const float scale = kReferenceFrameSize / (float)frameSize;
        const size_t bc = superfluxBandCount;
        for (size_t band = 0; band < bc; ++band) {
            float magnitude = 0.0f;
            const size_t off = superfluxBandOffsets[band];
            const size_t size = superfluxBandSizes[band];
            for (size_t i = 0; i < size; ++i) {
                magnitude += currentMag[superfluxBandStarts[band] + i] * superfluxWeights[off + i];
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
            // 阈值按分析 hop 缩放：变调时每帧频谱变化幅度改变，阈值需同步缩放
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

    void synthesizeSpectrum() {
        for (size_t i = 0; i < frameSize + 2; ++i) fftOutput[i] = 0.0f;
        const float shiftedNyquist = (float)(numBins - 1) / (currentRatio > 1.0e-6f ? currentRatio : 1.0e-6f);
        for (size_t bin = 0; bin < numBins; ++bin) {
            if ((float)bin > shiftedNyquist) break;
            fftOutput[2 * bin] = currentMag[bin] * cosf(currentSynthPhase[bin]);
            fftOutput[2 * bin + 1] = currentMag[bin] * sinf(currentSynthPhase[bin]);
        }
        fftOutput[1] = 0.0f;
        fftOutput[2 * (numBins - 1) + 1] = 0.0f;
    }

    float renderOutputSample() {
        const uint64_t kResampleStart = frameSize - hopSize;
        if (!resamplerStarted) {
            if (synthesisAvailable <= kResampleStart + 1) return 0.0f;
            resamplePosition = (double)kResampleStart;
            while (synthesisClearedUntil < kResampleStart) {
                synthesisRing[(size_t)(synthesisClearedUntil % kSynthesisRing)] = 0.0f;
                ++synthesisClearedUntil;
            }
            resamplerStarted = true;
        }

        const uint64_t lower = (uint64_t)resamplePosition;
        if (lower + kSincRadius >= synthesisAvailable) return 0.0f;
        const float fraction = (float)(resamplePosition - (double)lower);
        const float tableScale = (float)kSincTableSize / (float)kSincRadius;

        float output = 0.0f;
        const int64_t lowerSigned = (int64_t)lower;
        for (int64_t tap = -(int64_t)kSincRadius + 1; tap <= (int64_t)kSincRadius; ++tap) {
            const float tablePos = fabsf(fraction - (float)tap) * tableScale;
            size_t index = (size_t)tablePos;
            if (index > kSincTableSize - 1) index = kSincTableSize - 1;
            const float tableFraction = tablePos - (float)index;
            const float kernel = sincTable[index] + tableFraction * (sincTable[index + 1] - sincTable[index]);
            int64_t ringIndex = (lowerSigned + tap) % (int64_t)kSynthesisRing;
            if (ringIndex < 0) ringIndex += (int64_t)kSynthesisRing;
            output += synthesisRing[(size_t)ringIndex] * kernel;
        }

        resamplePosition += (double)currentRatio;
        const uint64_t floorPosition = (uint64_t)resamplePosition;
        const uint64_t clearUntil = floorPosition > kSincRadius ? floorPosition - kSincRadius : 0;
        while (synthesisClearedUntil < clearUntil) {
            synthesisRing[(size_t)(synthesisClearedUntil % kSynthesisRing)] = 0.0f;
            ++synthesisClearedUntil;
        }
        return output;
    }

    void recordTransientMark() {
        marks[markCount % kMaxTransientMarks] = (double)inputPosition;
        ++markCount;
    }
};

// 全局单例与输入输出缓冲（BSS，零初始化）
Shifter g_shifter;
float g_in[4096];
float g_out[4096];

} // namespace

// ============================================================
// 导出（wasm32 指针即 i32；JS 通过 instance.exports 直接调用）
// ============================================================
extern "C" {

void init(int sr, int hop, int win) {
    g_shifter.init((float)sr, (size_t)hop, win);
}

void process(int frameCount) {
    g_shifter.process(g_in, g_out, (size_t)frameCount);
}

void set_pitch_shift(float semitones) { g_shifter.setPitchShift(semitones); }
void set_transient_mode(int mode) { g_shifter.setTransientMode(mode); }
void set_cooldown_ms(float ms) { g_shifter.setCooldownMs(ms); }
void reinit(int hop, int win) { g_shifter.reinit((size_t)hop, win); }
void reset() { g_shifter.reset(); }

float* in_ptr() { return g_in; }
float* out_ptr() { return g_out; }
float* env_ptr() { return g_shifter.env; }
double* marks_ptr() { return g_shifter.marks; }

int mark_count() { return (int)g_shifter.markCount; }
int col_index() { return (int)g_shifter.colIndex; }
int total_columns() { return (int)g_shifter.totalColumns; }
int hop() { return (int)g_shifter.hopSize; }
int window_type() { return g_shifter.windowType; }
int display_size() { return (int)g_shifter.displaySize; }
int columns() { return (int)g_shifter.displayColumns; }
double position() { return (double)g_shifter.inputPosition; }
double ratio() { return (double)g_shifter.currentRatio; }

} // extern "C"
