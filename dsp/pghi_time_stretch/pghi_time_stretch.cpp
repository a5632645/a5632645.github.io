// pghi_time_stretch.cpp — 实时 PGHI 时间拉伸器（WebAssembly 版）
//
// 基于 dsp/pghi/pghi_shifter.cpp 的 PGHI 移调器移植：
//   * 移除输出端的 sinc 重采样器（原 renderOutputSample / sincTable / sincKernel）；
//   * 移除相位声码器中的抗混叠滤波器（原 synthesizeSpectrum 的 shiftedNyquist bin 截断）；
//   * 音频输入只使用用户上传的文件：整段单声道样本一次性拷入 wasm 内部缓冲，
//     由 DSP 自身按速度从缓冲拉取分析帧（分析 hop = hopSize × speed），
//     合成 hop 固定为 hopSize，合成环 1:1 直读。
//
// 时间拉伸原理：PGHI 合成相位按 stretchRatio = hopSize / analysisHop = 1/speed 外推，
// 使瞬时频率在合成域保持不变（音高不变）；分析帧间隔（源样本）为 hopSize×speed，
// 因此输出时长 = 源时长 / speed。speed > 1 变快变短，speed < 1 变慢变长。
//
// 编译（clang wasm32，无需 emscripten / libc）：
//   clang --target=wasm32 -O3 -std=c++17 -nostdlib -fno-exceptions -fno-rtti \
//     -Wl,--no-entry -Wl,--initial-memory=67108864 \
//     -Wl,--export=init -Wl,--export=process ... \
//     pghi_time_stretch.cpp -o pghi_time_stretch.wasm
//
// 内存布局：源缓冲固定 8M 样本（≈175s @48k），加 DSP 状态约 2MB，
// 初始内存 64MB，memory 不增长，JS 端视图地址稳定。

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
// 固定容量实时 PGHI 时间拉伸器
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
constexpr size_t kMaxTransientMarks = 32;
constexpr size_t kDisplayColumns = 900;
constexpr size_t kMaxSourceSamples = 8u * 1024u * 1024u;      // 8388608 ≈ 175s @48k

// 源音频缓冲（BSS，零初始化）；由 JS 通过 source_ptr() 写入后 set_source(length)
float g_source[kMaxSourceSamples];

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
// 实时时间拉伸器
// ------------------------------------------------------------
class Stretcher {
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

    float targetSpeed = 1.0f;
    float currentSpeed = 1.0f;
    int transientMode = 1; // DSPark
    bool firstFrame = true;

    // FFT
    FftCore fft;
    float fftInput[kMaxFft];
    float fftOutput[kMaxFft + 2];
    float fftTime[kMaxFft];

    // 瞬态检测器独立 FFT：检测器始终用 hann 窗（与主链窗无关），
    // 帧位置/时序与主链一致（同源中心），保证检测与合成严格同步。
    FftCore detFft;
    float detInput[kMaxFft];
    float detOutput[kMaxFft + 2];
    float detWindow[kMaxWindow];       // 恒为 hann（长度=detWindowSize）
    float detMag[kMaxBins];            // 检测器幅度谱（hann 窗分析）
    size_t detWindowSize = 2048;       // 检测器窗长（固定 min(2048, windowSize)）
    size_t detFrameSize = 4096;        // 检测器 FFT 帧长
    size_t detNumBins = 2049;          // 检测器 bin 数

    // 窗 / 环（无输入环：分析窗直接从 g_source 按整数位置取，无需重采样）
    float window[kMaxWindow];
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

    // DSPark 滤波器组（复用 SuperFlux 频带划分）
    uint32_t superfluxBandStarts[kMaxSuperFluxBands];
    uint32_t superfluxBandSizes[kMaxSuperFluxBands];
    uint32_t superfluxBandOffsets[kMaxSuperFluxBands];
    float superfluxWeights[kMaxSuperFluxWeights];
    size_t superfluxBandCount = 0;
    size_t superfluxWeightCount = 0;

    float dsfluxCurrent[kMaxSuperFluxBands];
    float dsfluxMaxPrev[kMaxSuperFluxBands];
    float dsfluxHistory[kDsFluxWindow];
    float dsfluxScratch[kDsFluxWindow];
    size_t dsfluxPos = 0;
    size_t dsfluxFilled = 0;
    size_t dsfluxWindow = kDsFluxReferenceWindow;
    size_t dsfluxCooldown = 0;

    // 传输状态（源缓冲拉取模型）
    size_t sourceLength = 0;
    double sourceClock = 0.0;          // 当前输出样本对应的源位置（可为小数）
    bool playing = false;
    bool loop = false;
    bool bypass = false;
    uint64_t outputPos = 0;            // 合成环读位置 = 帧放置位置
    size_t outputSinceFrame = 0;
    bool haveFrame = false;
    int64_t lastCenter = 0;

    // 显示（源时间轴）：以源样本为单位推进，与 marks / position 同坐标系。
    // 关键：不能按输出样本推进——速度≠1 时源时钟与输出时钟不同步，
    // 且按四舍五入取源样本会在 speed>1 时跳样，导致波形与瞬态标记错位。
    uint64_t inputPosition = 0;
    int64_t displayPos = 0;            // 下一个待送入显示的整数源位置
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
        // 检测器固定几何：窗长 min(2048, windowSize)，帧长 nextPow2(2*窗长)。
        detWindowSize = windowSize < 2048 ? windowSize : 2048;
        detFrameSize = nextPowerOfTwo(detWindowSize * 2);
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
        } else { // bh4
            for (size_t n = 0; n < L; ++n) {
                const float t = (float)n / (float)L;
                window[n] = 0.35875f - 0.48829f * cosf(twopi * t) + 0.14128f * cosf(2.0f * twopi * t)
                    - 0.01168f * cosf(3.0f * twopi * t);
            }
        }
        // 瞬态检测器始终用 hann 窗（与主链 windowType 无关），长度 = detWindowSize（固定）
        for (size_t n = 0; n < detWindowSize; ++n) {
            const float t = (float)n / (float)detWindowSize;
            detWindow[n] = 0.5f * (1.0f - cosf(twopi * t));
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
        for (size_t i = 0; i < kSynthesisRing; ++i) synthesisRing[i] = 0.0f;
        sourceClock = 0.0;
        outputPos = 0;
        outputSinceFrame = 0;
        haveFrame = false;
        lastCenter = 0;
        currentSpeed = targetSpeed;

        for (size_t i = 0; i < kDisplayColumns * 2; ++i) env[i] = 0.0f;
        colIndex = 0;
        colCount = 0;
        colMin = 1.0f;
        colMax = -1.0f;
        totalColumns = 0;
        inputPosition = 0;
        displayPos = 0;
        for (size_t i = 0; i < kMaxTransientMarks; ++i) marks[i] = 0.0;
        markCount = 0;

        resetPhaseState();
    }

    // 中途重启声码器（HOP/窗切换、bypass 关闭等）：清空环与相位，从当前源位置继续
    void restartVocoder() {
        for (size_t i = 0; i < kSynthesisRing; ++i) synthesisRing[i] = 0.0f;
        outputPos = 0;
        outputSinceFrame = 0;
        haveFrame = false;
        lastCenter = 0;
        currentSpeed = targetSpeed;
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
    size_t cooldownFramesForHop(float ms, size_t analysisHop) const {
        const float samples = ms * sampleRate / 1000.0f;
        const size_t hop = analysisHop > 0 ? analysisHop : 1;
        size_t frames = (size_t)(samples / (float)hop + 0.5f);
        return frames < 1 ? 1 : frames;
    }

    void setSpeed(float speed) {
        if (speed > 20.0f) speed = 20.0f;
        if (speed < 0.05f) speed = 0.05f;
        targetSpeed = speed;
        if (firstFrame) currentSpeed = targetSpeed;
    }

    void setTransientMode(int mode) {
        if (transientMode == mode) return;
        transientMode = mode;
        resetPhaseState();
    }

    void setCooldownMs(float ms) {
        cooldownMs = ms < 0.0f ? 0.0f : ms;
    }

    void setSource(size_t length) {
        sourceLength = length > kMaxSourceSamples ? kMaxSourceSamples : length;
        playing = false;
        reset();
    }

    void play() {
        if (sourceLength == 0) return;
        // 播放到末尾后再次点击播放：从开头重来。
        // loop 时 sourceClock 会持续增长，但此时仍在播放中，不能重置。
        if (!playing && sourceClock >= (double)sourceLength) {
            reset();
        }
        playing = true;
    }
    void pause() { playing = false; }
    void stop() { playing = false; reset(); }
    void setLoop(int on) { loop = on != 0; }

    void setBypass(int on) {
        const bool b = on != 0;
        if (bypass == b) return;
        bypass = b;
        if (!bypass) restartVocoder();
    }

    // 源样本读取：loop 时按源长环绕（无缝循环），否则越界补零
    float srcAt(int64_t p) const {
        if (sourceLength == 0) return 0.0f;
        if (loop) {
            int64_t m = p % (int64_t)sourceLength;
            if (m < 0) m += (int64_t)sourceLength;
            return g_source[m];
        }
        return (p >= 0 && p < (int64_t)sourceLength) ? g_source[p] : 0.0f;
    }

    // --------------------------------------------------------
    void process(float* output, size_t frameCount) {
        for (size_t i = 0; i < frameCount; ++i) output[i] = nextSample();
    }

    float nextSample() {
        if (!playing || sourceLength == 0) return 0.0f;

        float out;
        if (bypass) {
            out = srcAt((int64_t)(sourceClock + 0.5));
            sourceClock += 1.0;
        } else {
            if (outputSinceFrame == 0) {
                // 速度平滑（每帧一次），与移调器对 ratio 的处理一致
                currentSpeed += 0.25f * (targetSpeed - currentSpeed);
                const int64_t center = (int64_t)(sourceClock + 0.5);
                int64_t ha;
                if (!haveFrame) {
                    ha = (int64_t)((float)hopSize * currentSpeed + 0.5f);
                    haveFrame = true;
                } else {
                    ha = center - lastCenter;
                }
                if (ha < 1) ha = 1;
                if (ha > (int64_t)kMaxWindow) ha = (int64_t)kMaxWindow;
                processFrame(center, (size_t)ha);
                lastCenter = center;
            }
            out = synthesisRing[(size_t)(outputPos % (uint64_t)kSynthesisRing)];
            ++outputPos;
            outputSinceFrame = (outputSinceFrame + 1) % hopSize;
            sourceClock += (double)currentSpeed;
        }

        advanceDisplay();
        checkStop();
        return out;
    }

    // 把 [displayPos, floor(sourceClock)) 之间的每个整数源样本送入显示。
    // 逐样本推进保证 speed>1 时不跳样，且与 marks 的源坐标系严格对齐。
    void advanceDisplay() {
        const int64_t target = (int64_t)sourceClock;
        while (displayPos < target) {
            updateDisplaySample(srcAt(displayPos));
            ++displayPos;
        }
        if (target > 0) inputPosition = (uint64_t)target;
    }

    void checkStop() {
        if (!loop && sourceClock >= (double)sourceLength + (double)windowSize) {
            playing = false;
        }
    }

    void updateDisplaySample(float v) {
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
    }

    void processFrame(int64_t center, size_t analysisHop) {
        const size_t halfW = halfWindow;
        const size_t wS = windowSize;
        const int64_t base = center - (int64_t)halfW;

        // PGHI 居中分半窗（直接按整数源位置取，无插值）
        for (size_t i = 0; i < frameSize; ++i) fftInput[i] = 0.0f;
        const size_t pad = frameSize - halfW;
        for (size_t j = 0; j < halfW; ++j) {
            fftInput[pad + j] = srcAt(base + (int64_t)j) * window[j];
        }
        for (size_t j = halfW; j < wS; ++j) {
            fftInput[j - halfW] = srcAt(base + (int64_t)j) * window[j];
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

        // 瞬态检测器独立分析 FFT：窗恒为 hann，帧长固定（detFrameSize），
        // 与主链同源中心（center），时间对齐保留。
        {
            const size_t dW = detWindowSize;
            const size_t dHalf = dW >> 1;
            const int64_t dBase = center - (int64_t)dHalf;
            for (size_t i = 0; i < detFrameSize; ++i) detInput[i] = 0.0f;
            const size_t dpad = detFrameSize - dHalf;
            for (size_t j = 0; j < dHalf; ++j) {
                detInput[dpad + j] = srcAt(dBase + (int64_t)j) * detWindow[j];
            }
            for (size_t j = dHalf; j < dW; ++j) {
                detInput[j - dHalf] = srcAt(dBase + (int64_t)j) * detWindow[j];
            }
            detFft.forward(detInput, detOutput);
        }
        for (size_t bin = 0; bin < detNumBins; ++bin) {
            const float re = detOutput[2 * bin];
            const float im = detOutput[2 * bin + 1];
            detMag[bin] = hypotf(re, im);
        }

        bool resetPhase = firstFrame;
        if (!firstFrame) {
            if (transientMode == 1) resetPhase = detectDsParkTransient(analysisHop);
        }

        if (resetPhase) {
            for (size_t bin = 0; bin < numBins; ++bin) currentSynthPhase[bin] = currentAnalysisPhase[bin];
            if (!firstFrame) recordTransientMark(center);
        } else {
            propagatePghi(analysisHop);
        }

        synthesizeSpectrum();
        fft.inverse(fftOutput, fftTime);

        // 清除本帧新覆盖的环区（前 windowSize-hopSize 已由更早帧清零）
        const uint64_t clearStart = outputPos + (uint64_t)windowSize - (uint64_t)hopSize;
        const uint64_t clearEnd = outputPos + (uint64_t)windowSize;
        for (uint64_t p = clearStart; p < clearEnd; ++p) {
            synthesisRing[(size_t)(p % (uint64_t)kSynthesisRing)] = 0.0f;
        }

        // OLA 叠加：环位置 outputPos 对应帧最新样本，1:1 直读
        const size_t fs = frameSize;
        for (size_t i = 0; i < halfW; ++i) {
            const size_t index = (size_t)((outputPos + i) % (uint64_t)kSynthesisRing);
            synthesisRing[index] += fftTime[fs - halfW + i] * window[i] * olaGain;
        }
        for (size_t i = 0; i < halfW; ++i) {
            const size_t index = (size_t)((outputPos + halfW + i) % (uint64_t)kSynthesisRing);
            synthesisRing[index] += fftTime[i] * window[halfW + i] * olaGain;
        }

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

    bool detectDsParkTransient(size_t analysisHop) {
        if (superfluxBandCount == 0) return false;
        float flux = 0.0f;
        constexpr float kReferenceFrameSize = 2048.0f;
        const float scale = kReferenceFrameSize / (float)detFrameSize;
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
            // 阈值按分析 hop 缩放：拉伸时每帧源前进量改变，阈值需同步缩放。
            // bh3 旁瓣泄漏较 bh4 高，扫频时能量在相邻对数频带间渗漏，
            // 故对 bh3 使用加倍的基准阈值（0.04），彻底消除扫频误判。
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

    // 抗混叠滤波器已移除：时间拉伸不改变音高，所有 bin 直接保留
    void synthesizeSpectrum() {
        for (size_t i = 0; i < frameSize + 2; ++i) fftOutput[i] = 0.0f;
        for (size_t bin = 0; bin < numBins; ++bin) {
            fftOutput[2 * bin] = currentMag[bin] * cosf(currentSynthPhase[bin]);
            fftOutput[2 * bin + 1] = currentMag[bin] * sinf(currentSynthPhase[bin]);
        }
        fftOutput[1] = 0.0f;
        fftOutput[2 * (numBins - 1) + 1] = 0.0f;
    }

    void recordTransientMark(int64_t center) {
        if (sourceLength == 0) return;
        marks[markCount % kMaxTransientMarks] = (double)(center > 0 ? center : 0);
        ++markCount;
    }
};

// 全局单例与输出缓冲（BSS，零初始化）
Stretcher g_stretcher;
float g_out[4096];

} // namespace

// ============================================================
// 导出（wasm32 指针即 i32；JS 通过 instance.exports 直接调用）
// ============================================================
extern "C" {

void init(int sr, int hop, int win) {
    g_stretcher.init((float)sr, (size_t)hop, win);
}

void process(int frameCount) {
    g_stretcher.process(g_out, (size_t)frameCount);
}

void set_speed(float speed) { g_stretcher.setSpeed(speed); }
void set_transient_mode(int mode) { g_stretcher.setTransientMode(mode); }
void set_cooldown_ms(float ms) { g_stretcher.setCooldownMs(ms); }
void set_source(int length) { g_stretcher.setSource((size_t)length); }
void play() { g_stretcher.play(); }
void pause() { g_stretcher.pause(); }
void stop() { g_stretcher.stop(); }
void set_loop(int on) { g_stretcher.setLoop(on); }
void set_bypass(int on) { g_stretcher.setBypass(on); }
void reinit(int hop, int win) { g_stretcher.reinit((size_t)hop, win); }
void reset() { g_stretcher.reset(); }

float* out_ptr() { return g_out; }
float* source_ptr() { return g_source; }
int source_capacity() { return (int)kMaxSourceSamples; }
int is_playing() { return g_stretcher.playing ? 1 : 0; }
int source_length() { return (int)g_stretcher.sourceLength; }
int is_bypass() { return g_stretcher.bypass ? 1 : 0; }

float* env_ptr() { return g_stretcher.env; }
double* marks_ptr() { return g_stretcher.marks; }

int mark_count() { return (int)g_stretcher.markCount; }
int col_index() { return (int)g_stretcher.colIndex; }
int total_columns() { return (int)g_stretcher.totalColumns; }
int hop() { return (int)g_stretcher.hopSize; }
int window_type() { return g_stretcher.windowType; }
int display_size() { return (int)g_stretcher.displaySize; }
int columns() { return (int)g_stretcher.displayColumns; }
double position() { return (double)g_stretcher.inputPosition; }
double speed() { return (double)g_stretcher.currentSpeed; }

} // extern "C"
