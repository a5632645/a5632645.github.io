/*
 * pghi_worklet.js
 *
 * 实时 PGHI 移调器 —— playing.cpp 的 RealtimePitchShifter 的浏览器（AudioWorklet）移植。
 *
 * 算法要点（与原 C++ 一致）：
 *   - 固定合成 hop，可变分析 hop 完成时间拉伸；
 *   - PGHI 相位传播（幅度优先堆，从高幅度 bin 向相邻 bin 扩展相位）；
 *   - 5 种可选瞬态检测：None / Flux / SuperFlux / Vocoder / DSPark；
 *   - 窗函数 sinc 插值重采样完成移调，超出奈奎斯特频率的 bin 静音防混叠；
 *   - 窗函数与 HOP 大小作为参数（本页新增，结构对应 pitch_shifter_rt.hpp）：
 *     窗长 = HOP × COLA 重叠因子（hann×4 / 三项 BH×6 / 四项 BH×8），FFT = nextPow2(2 × 窗长)。
 *
 * 与原实现不同的数值约定：
 *   - 本页 IFFT 归一化为 1/N（往返增益 = 1），OLA 增益按 1 / Σw² 自动计算，
 *     因此任意窗函数在 0 移调时输出增益为 1（原实现 kOlaGain 是 BH3 专用常数）。
 *
 * 初始化完成后，音频处理路径不进行任何动态内存分配（所有缓冲预分配）。
 */

'use strict';

// ------------------------------------------------------------
// FftCore —— 基 2 迭代复数 FFT（原地）
// ------------------------------------------------------------
class FftCore {
    constructor(n) {
        this.n = n;
        this.logN = Math.round(Math.log2(n));
        this.rev = new Uint32Array(n);
        for (let i = 0; i < n; ++i) {
            let r = 0;
            for (let b = 0; b < this.logN; ++b) r = (r << 1) | ((i >> b) & 1);
            this.rev[i] = r;
        }
        const half = n >> 1;
        this.cosT = new Float32Array(half);
        this.sinT = new Float32Array(half);
        for (let k = 0; k < half; ++k) {
            const a = -2.0 * Math.PI * k / n;
            this.cosT[k] = Math.cos(a);
            this.sinT[k] = Math.sin(a);
        }
        this.reBuf = new Float32Array(n);
        this.imBuf = new Float32Array(n);
    }

    // 实输入 x[n] -> CCS 谱 ccs[n+2]（[re,im] 对，ccs[0]=DC re, ccs[1]=0, ccs[n]=Nyquist re）
    forward(x, ccs) {
        const n = this.n, re = this.reBuf, im = this.imBuf, rev = this.rev;
        for (let i = 0; i < n; ++i) {
            re[rev[i]] = x[i];
            im[rev[i]] = 0.0;
        }
        this.transform(re, im, 1);
        ccs[0] = re[0]; ccs[1] = 0.0;
        const h = n >> 1;
        for (let k = 1; k < h; ++k) {
            ccs[2 * k] = re[k];
            ccs[2 * k + 1] = im[k];
        }
        ccs[n] = re[h]; ccs[n + 1] = 0.0;
    }

    // CCS 谱 ccs[n+2] -> 实输出 out[n]，归一化 1/N（往返增益 = 1）
    inverse(ccs, out) {
        const n = this.n, re = this.reBuf, im = this.imBuf, rev = this.rev;
        const h = n >> 1;
        re[rev[0]] = ccs[0]; im[rev[0]] = 0.0;
        re[rev[h]] = ccs[n]; im[rev[h]] = 0.0;
        for (let k = 1; k < h; ++k) {
            const r0 = ccs[2 * k], i0 = ccs[2 * k + 1];
            re[rev[k]] = r0; im[rev[k]] = i0;
            re[rev[n - k]] = r0; im[rev[n - k]] = -i0;
        }
        this.transform(re, im, -1);
        const inv = 1.0 / n;
        for (let i = 0; i < n; ++i) out[i] = re[i] * inv;
    }

    transform(re, im, sign) {
        const n = this.n, cosT = this.cosT, sinT = this.sinT;
        let len = 2;
        while (len <= n) {
            const half = len >> 1;
            const step = (n / len) | 0;
            for (let i = 0; i < n; i += len) {
                let tw = 0;
                for (let k = 0; k < half; ++k) {
                    const wr = cosT[tw], wi = sinT[tw] * sign;
                    const j = i + k, m = j + half;
                    const tr = re[m] * wr - im[m] * wi;
                    const ti = re[m] * wi + im[m] * wr;
                    re[m] = re[j] - tr; im[m] = im[j] - ti;
                    re[j] += tr; im[j] += ti;
                    tw += step;
                }
            }
            len <<= 1;
        }
    }
}

// ------------------------------------------------------------
// PghiPitchShifter —— 实时 PGHI 移调核心（playing.cpp 移植）
// ------------------------------------------------------------
// 窗类型与 COLA 重叠因子、OLA 增益（对应 pitch_shifter_rt.hpp 的 WindowTraits）：
//   Hann                 ×4  OLA 增益 2/3
//   三项 Blackman-Harris ×6  OLA 增益 0.5431781
//   标准四项 BH          ×8  OLA 增益 0.4845649
// 窗长 = HOP × 重叠因子，FFT = nextPow2(2 × 窗长)。OLA 增益为周期窗在
// IFFT 归一化 1/N 下的直接适用常数（与原 C++ 数值一致）。
const WINDOW_DEFS = {
    'hann': { overlap: 4, olaGain: 2.0 / 3.0 },
    'blackman-harris-3term': { overlap: 6, olaGain: 0.5431781 },
    'blackman-harris': { overlap: 8, olaGain: 0.4845649 },
};
const kSincRadius = 8;
const kSincTableSize = 2048;
const kFluxHistorySize = 32;
const kMaxSuperFluxBands = 256;
const kDsFluxWindow = 12;
const kDsFluxDelta = 0.02;
const kSuperFluxCooldown = 6;
const kDsParkCooldown = 6;
const kMaxTransientMarks = 32;
const kDisplaySeconds = 3;

function wrapToPi(phase) {
    const kTwoPi = 2.0 * Math.PI;
    return phase - kTwoPi * Math.round(phase / kTwoPi);
}

function sincKernel(x) {
    if (Math.abs(x) < 1.0e-6) return 1.0;
    const px = Math.PI * x;
    const window = 0.42 + 0.5 * Math.cos(Math.PI * x / kSincRadius)
        + 0.08 * Math.cos(2.0 * Math.PI * x / kSincRadius);
    return Math.sin(px) / px * window;
}

class PghiPitchShifter {
    constructor(sampleRate, hopSize, windowType) {
        this.sampleRate = sampleRate;
        this.hopSize = hopSize;
        this.windowType = windowType;

        this.targetRatio = 1.0;
        this.currentRatio = 1.0;
        this.transientMode = 4; // DSPark

        this.initSizes();
        this.reset();
    }

    initSizes() {
        const hop = this.hopSize;
        const def = WINDOW_DEFS[this.windowType];
        this.overlap = def.overlap;
        this.windowSize = hop * this.overlap;
        this.halfWindow = this.windowSize >> 1;
        this.frameSize = this.nextPowerOfTwo(this.windowSize * 2);
        this.numBins = (this.frameSize >> 1) + 1;
        this.synthesisRingSize = this.frameSize * 16;
        this.heapCapacity = this.numBins * 2;
        this.maxSuperFluxWeights = this.numBins * 3;

        // ---- 窗函数（周期窗） ----
        this.window = new Float32Array(this.windowSize);
        this.buildWindow();
        // OLA 增益：pitch_shifter_rt.hpp 中每窗专用常数（IFFT 归一化 1/N 下直接适用）
        this.olaGain = def.olaGain;

        this.fft = new FftCore(this.frameSize);
        this.fftInput = new Float32Array(this.frameSize);
        this.fftOutput = new Float32Array(this.frameSize + 2);
        this.fftTime = new Float32Array(this.frameSize);
        this.inputRing = new Float32Array(this.windowSize);
        this.synthesisRing = new Float32Array(this.synthesisRingSize);

        // ---- bin 状态 ----
        const nb = this.numBins;
        this.currentRe = new Float32Array(nb);
        this.currentIm = new Float32Array(nb);
        this.currentMag = new Float32Array(nb);
        this.currentAnalysisPhase = new Float32Array(nb);
        this.currentSynthPhase = new Float32Array(nb);
        this.previousAnalysisPhase = new Float32Array(nb);
        this.previousSynthPhase = new Float32Array(nb);
        this.previousMag = new Float32Array(nb);

        // ---- PGHI 堆 ----
        this.processedBins = new Uint8Array(nb);
        this.heapMag = new Float32Array(this.heapCapacity);
        this.heapBin = new Uint32Array(this.heapCapacity);
        this.heapIsPrev = new Uint8Array(this.heapCapacity);
        this.heapSize = 0;

        // ---- Flux ----
        this.fluxHistory = new Float32Array(kFluxHistorySize);
        this.fluxScratch = new Float32Array(kFluxHistorySize);

        // ---- SuperFlux / DSPark 共用滤波器组 ----
        this.superfluxBandStarts = new Uint32Array(kMaxSuperFluxBands);
        this.superfluxBandSizes = new Uint32Array(kMaxSuperFluxBands);
        this.superfluxBandOffsets = new Uint32Array(kMaxSuperFluxBands);
        this.superfluxWeights = new Float32Array(this.maxSuperFluxWeights);
        this.superfluxCurrent = new Float32Array(kMaxSuperFluxBands);
        this.superfluxPreviousMax = new Float32Array(kMaxSuperFluxBands);
        this.dsfluxCurrent = new Float32Array(kMaxSuperFluxBands);
        this.dsfluxMaxPrev = new Float32Array(kMaxSuperFluxBands);
        this.dsfluxHistory = new Float32Array(kDsFluxWindow);
        this.dsfluxScratch = new Float32Array(kDsFluxWindow);

        // ---- sinc 重采样核 ----
        this.sincTable = new Float32Array(kSincTableSize + 1);
        this.buildSincTable();

        this.buildSuperFluxFilterBank();

        // ---- 波形显示（列包络，900 列 ≈ 3 秒） ----
        this.displayColumns = 900;
        this.displaySize = Math.round(this.sampleRate * kDisplaySeconds);
        this.columnSamples = Math.round(this.displaySize / this.displayColumns);
        this.envMin = new Float32Array(this.displayColumns);
        this.envMax = new Float32Array(this.displayColumns);
        this.displayEnvelope = new Float32Array(this.displayColumns * 2);

        this.transientMarks = new Float64Array(kMaxTransientMarks);
    }

    nextPowerOfTwo(v) {
        let r = 1;
        while (r < v) r <<= 1;
        return r;
    }

    buildWindow() {
        const L = this.windowSize, w = this.window;
        const twopi = 2.0 * Math.PI;
        if (this.windowType === 'hann') {
            for (let n = 0; n < L; ++n) {
                const t = n / L;
                w[n] = 0.5 * (1.0 - Math.cos(twopi * t));
            }
        } else if (this.windowType === 'blackman-harris-3term') {
            for (let n = 0; n < L; ++n) {
                const t = n / L;
                w[n] = 0.4243801 - 0.4973406 * Math.cos(twopi * t) + 0.0782793 * Math.cos(2.0 * twopi * t);
            }
        } else { // blackman-harris（标准四项，周期窗）
            for (let n = 0; n < L; ++n) {
                const t = n / L;
                w[n] = 0.35875 - 0.48829 * Math.cos(twopi * t) + 0.14128 * Math.cos(2.0 * twopi * t)
                    - 0.01168 * Math.cos(3.0 * twopi * t);
            }
        }
    }

    buildSincTable() {
        const step = kSincRadius / kSincTableSize;
        for (let i = 0; i <= kSincTableSize; ++i) {
            this.sincTable[i] = sincKernel(i * step);
        }
    }

    buildSuperFluxFilterBank() {
        const kMinimumFrequency = 27.5;
        const kMaximumFrequency = 16000.0;
        const kBandsPerOctave = 24;
        const centers = new Float64Array(kMaxSuperFluxBands + 2);
        let centerCount = 0;
        const binHz = this.sampleRate / this.frameSize;
        const maximumFrequency = Math.min(kMaximumFrequency, this.sampleRate * 0.5 * 0.999);

        for (let index = 0; centerCount < centers.length; ++index) {
            const frequency = kMinimumFrequency * Math.pow(2.0, index / kBandsPerOctave);
            if (frequency > maximumFrequency) break;
            let bin = Math.round(frequency / binHz);
            if (bin > this.numBins - 1) bin = this.numBins - 1;
            if (centerCount === 0 || bin > centers[centerCount - 1]) {
                centers[centerCount++] = bin;
            }
        }

        this.superfluxBandCount = 0;
        this.superfluxWeightCount = 0;
        for (let center = 1; center + 1 < centerCount; ++center) {
            const low = centers[center - 1];
            const middle = centers[center];
            const high = centers[center + 1];
            const size = high - low + 1;
            if (low >= middle || middle >= high || this.superfluxBandCount === kMaxSuperFluxBands
                || this.superfluxWeightCount + size > this.maxSuperFluxWeights) {
                continue;
            }
            const band = this.superfluxBandCount++;
            this.superfluxBandStarts[band] = low;
            this.superfluxBandSizes[band] = size;
            this.superfluxBandOffsets[band] = this.superfluxWeightCount;
            for (let bin = low; bin <= high; ++bin) {
                const weight = bin <= middle
                    ? (bin - low) / (middle - low)
                    : (high - bin) / (high - middle);
                this.superfluxWeights[this.superfluxWeightCount++] = weight;
            }
        }
    }

    // --------------------------------------------------------
    // 参数 / 状态
    // --------------------------------------------------------

    setPitchShift(semitones) {
        this.targetRatio = Math.pow(2.0, Math.max(-12.0, Math.min(12.0, semitones)) / 12.0);
        if (this.firstFrame) {
            this.currentRatio = this.targetRatio;
        }
    }

    setTransientMode(mode) {
        if (this.transientMode === mode) return;
        this.transientMode = mode;
        this.resetPhaseState();
    }

    reset() {
        this.inputRing.fill(0.0);
        this.synthesisRing.fill(0.0);
        this.inputWrite = 0;
        this.collectedSamples = 0;
        this.samplesSinceFrame = 0;
        this.samplesToFrame = 0.0;
        this.analysisStarted = false;
        this.synthesisFrameStart = 0;
        this.synthesisAvailable = 0;
        this.synthesisClearedUntil = 0;
        this.resamplePosition = 0.0;
        this.resamplerStarted = false;
        this.currentRatio = this.targetRatio;
        this.inputPosition = 0;

        // 显示
        this.envMin.fill(0.0);
        this.envMax.fill(0.0);
        this.displayColIndex = 0;
        this.colCount = 0;
        this.colMin = Infinity;
        this.colMax = -Infinity;
        this.totalColumnsFinalized = 0;
        this.transientMarks.fill(0.0);
        this.transientMarkCount = 0;

        this.resetPhaseState();
    }

    resetPhaseState() {
        this.previousAnalysisPhase.fill(0.0);
        this.previousSynthPhase.fill(0.0);
        this.previousMag.fill(0.0);
        this.fluxHistory.fill(0.0);
        this.fluxHistoryCount = 0;
        this.fluxHistoryWrite = 0;
        this.fluxCooldown = 0;
        this.transientMean = 0.0;
        this.transientVariance = 0.0;
        this.transientFrames = 0;
        this.transientCooldown = 0;
        this.transientHasMean = false;
        this.superfluxCurrent.fill(0.0);
        this.superfluxPreviousMax.fill(0.0);
        this.superfluxCooldown = 0;
        this.dsfluxCurrent.fill(0.0);
        this.dsfluxMaxPrev.fill(0.0);
        this.dsfluxHistory.fill(0.0);
        this.dsfluxScratch.fill(0.0);
        this.dsfluxPos = 0;
        this.dsfluxFilled = 0;
        this.dsfluxCooldown = 0;
        this.firstFrame = true;
    }

    // 换 hop / 窗函数时重建（参数变化会清空处理状态）
    reinit(hopSize, windowType) {
        if (hopSize === this.hopSize && windowType === this.windowType) {
            this.reset();
            return;
        }
        this.hopSize = hopSize;
        this.windowType = windowType;
        this.initSizes();
        this.reset();
    }

    // --------------------------------------------------------
    // 实时处理
    // --------------------------------------------------------

    process(input, output, frameCount) {
        for (let i = 0; i < frameCount; ++i) {
            const v = input[i];
            this.inputRing[this.inputWrite] = v;
            this.inputWrite = (this.inputWrite + 1) % this.windowSize;
            this.collectedSamples = Math.min(this.collectedSamples + 1, this.windowSize);
            ++this.samplesSinceFrame;
            ++this.inputPosition;

            // 显示列包络（min/max）
            if (v < this.colMin) this.colMin = v;
            if (v > this.colMax) this.colMax = v;
            ++this.colCount;
            if (this.colCount >= this.columnSamples) {
                this.envMin[this.displayColIndex] = this.colMin;
                this.envMax[this.displayColIndex] = this.colMax;
                this.displayColIndex = (this.displayColIndex + 1) % this.displayColumns;
                this.colCount = 0;
                this.colMin = Infinity;
                this.colMax = -Infinity;
                ++this.totalColumnsFinalized;
            }

            if (!this.analysisStarted && this.collectedSamples === this.windowSize) {
                this.processFrame(this.hopSize);
                this.analysisStarted = true;
                this.samplesSinceFrame = 0;
                this.samplesToFrame = this.hopSize / this.currentRatio;
            } else if (this.analysisStarted) {
                this.samplesToFrame -= 1.0;
                if (this.samplesToFrame <= 0.0) {
                    this.processFrame(Math.max(1, this.samplesSinceFrame));
                    this.samplesSinceFrame = 0;
                    this.samplesToFrame += this.hopSize / this.currentRatio;
                }
            }
            output[i] = this.renderOutputSample();
        }
    }

    processFrame(analysisHop) {
        this.currentRatio += 0.25 * (this.targetRatio - this.currentRatio);
        const halfW = this.halfWindow;
        const wS = this.windowSize;
        const iw = this.inputWrite;

        // PGHI 采用居中的分半窗装入 FFT 输入（与原实现相同的索引布局）
        this.fftInput.fill(0.0);
        for (let i = 0; i < halfW; ++i) {
            this.fftInput[i] = this.inputRing[(iw + halfW + i) % wS] * this.window[halfW + i];
        }
        const pad = this.frameSize - halfW;
        for (let i = 0; i < halfW; ++i) {
            this.fftInput[pad + i] = this.inputRing[(iw + i) % wS] * this.window[i];
        }
        this.fft.forward(this.fftInput, this.fftOutput);

        const nb = this.numBins;
        for (let bin = 0; bin < nb; ++bin) {
            const re = this.fftOutput[2 * bin];
            const im = this.fftOutput[2 * bin + 1];
            this.currentRe[bin] = re;
            this.currentIm[bin] = im;
            this.currentMag[bin] = Math.hypot(re, im);
            this.currentAnalysisPhase[bin] = Math.atan2(im, re);
        }

        let resetPhase = this.firstFrame;
        if (!this.firstFrame) {
            switch (this.transientMode) {
                case 1: resetPhase = this.detectFluxTransient(); break;
                case 2: resetPhase = this.detectSuperFluxTransient(); break;
                case 3: resetPhase = this.detectVocoderTransient(); break;
                case 4: resetPhase = this.detectDsParkTransient(); break;
            }
        }

        if (resetPhase) {
            this.currentSynthPhase.set(this.currentAnalysisPhase);
            if (!this.firstFrame) {
                this.recordTransientMark();
            }
        } else {
            this.propagatePghi(analysisHop);
        }

        this.synthesizeSpectrum();
        this.fft.inverse(this.fftOutput, this.fftTime);

        const fs = this.frameSize;
        const ringSize = this.synthesisRingSize;
        for (let i = 0; i < halfW; ++i) {
            const index = (this.synthesisFrameStart + i) % ringSize;
            const source = fs - halfW + i;
            this.synthesisRing[index] += this.fftTime[source] * this.window[i] * this.olaGain;
        }
        for (let i = 0; i < halfW; ++i) {
            const index = (this.synthesisFrameStart + halfW + i) % ringSize;
            const source = i;
            this.synthesisRing[index] += this.fftTime[source] * this.window[halfW + i] * this.olaGain;
        }
        // 新合成帧在 hop 边界处的窗值为零，因此该边界样本已完整可读。
        this.synthesisAvailable = this.synthesisFrameStart + this.hopSize + 1;
        this.synthesisFrameStart += this.hopSize;

        this.previousAnalysisPhase.set(this.currentAnalysisPhase);
        this.previousSynthPhase.set(this.currentSynthPhase);
        this.previousMag.set(this.currentMag);
        this.firstFrame = false;
    }

    // PGHI 相位传播：幅度优先堆遍历，从高幅度 bin 向相邻 bin 扩展相位
    propagatePghi(analysisHop) {
        const nb = this.numBins;
        this.processedBins.fill(0);
        this.heapSize = 0;
        for (let bin = 0; bin < nb; ++bin) {
            this.heapPush(this.previousMag[bin], bin, true);
        }

        const analysisScale = 2.0 * Math.PI * analysisHop / this.frameSize;
        const synthesisScale = 2.0 * Math.PI * this.hopSize / this.frameSize;
        const stretchRatio = this.hopSize / analysisHop;
        let processedCount = 0;
        while (processedCount < nb && this.heapSize > 0) {
            const item = this.heapPop();
            const bin = item.bin;
            if (item.isPrevious) {
                if (this.processedBins[bin] !== 0) continue;
                const expected = analysisScale * bin;
                const residual = wrapToPi(this.currentAnalysisPhase[bin] - this.previousAnalysisPhase[bin] - expected);
                this.currentSynthPhase[bin] = wrapToPi(this.previousSynthPhase[bin]
                    + synthesisScale * bin + stretchRatio * residual);
                this.processedBins[bin] = 1;
                ++processedCount;
                this.heapPush(this.currentMag[bin], bin, false);
                continue;
            }
            if (bin + 1 < nb && this.processedBins[bin + 1] === 0) {
                const delta = wrapToPi(this.currentAnalysisPhase[bin + 1] - this.currentAnalysisPhase[bin]);
                this.currentSynthPhase[bin + 1] = wrapToPi(this.currentSynthPhase[bin] + stretchRatio * delta);
                this.processedBins[bin + 1] = 1;
                ++processedCount;
                this.heapPush(this.currentMag[bin + 1], bin + 1, false);
            }
            if (bin > 0 && this.processedBins[bin - 1] === 0) {
                const delta = wrapToPi(this.currentAnalysisPhase[bin - 1] - this.currentAnalysisPhase[bin]);
                this.currentSynthPhase[bin - 1] = wrapToPi(this.currentSynthPhase[bin] + stretchRatio * delta);
                this.processedBins[bin - 1] = 1;
                ++processedCount;
                this.heapPush(this.currentMag[bin - 1], bin - 1, false);
            }
        }
    }

    // 线性频谱通量 + 中位数基线自适应阈值
    detectFluxTransient() {
        const nb = this.numBins;
        let positiveDifference = 0.0;
        for (let bin = 0; bin < nb; ++bin) {
            positiveDifference += Math.max(0.0, this.currentMag[bin] - this.previousMag[bin]);
        }
        const flux = positiveDifference / nb;

        let baseline = 0.0;
        if (this.fluxHistoryCount > 0) {
            const sub = this.fluxScratch.subarray(0, this.fluxHistoryCount);
            sub.set(this.fluxHistory.subarray(0, this.fluxHistoryCount));
            Array.prototype.sort.call(sub, (a, b) => a - b);
            baseline = sub[this.fluxHistoryCount >> 1];
        }
        const transient = this.fluxCooldown === 0 && flux > Math.max(4.0 * baseline, 0.02);
        this.fluxCooldown = transient ? 6 : (this.fluxCooldown > 0 ? this.fluxCooldown - 1 : 0);
        if (!transient) {
            this.fluxHistory[this.fluxHistoryWrite] = flux;
            this.fluxHistoryWrite = (this.fluxHistoryWrite + 1) % kFluxHistorySize;
            this.fluxHistoryCount = Math.min(this.fluxHistoryCount + 1, kFluxHistorySize);
        }
        return transient;
    }

    // SuperFlux：对数频带三角滤波器组 + 频率最大滤波 + 固定阈值
    detectSuperFluxTransient() {
        if (this.superfluxBandCount === 0) return false;

        let flux = 0.0;
        const kReferenceFrameSize = 4096.0;
        const scale = kReferenceFrameSize / this.frameSize;
        const bc = this.superfluxBandCount;
        for (let band = 0; band < bc; ++band) {
            let magnitude = 0.0;
            const off = this.superfluxBandOffsets[band];
            const size = this.superfluxBandSizes[band];
            for (let i = 0; i < size; ++i) {
                magnitude += this.currentMag[this.superfluxBandStarts[band] + i] * this.superfluxWeights[off + i];
            }
            this.superfluxCurrent[band] = Math.log10(magnitude * scale + 1.0);
            if (!this.firstFrame) {
                flux += Math.max(0.0, this.superfluxCurrent[band] - this.superfluxPreviousMax[band]);
            }
        }
        for (let band = 0; band < bc; ++band) {
            let maximum = this.superfluxCurrent[band];
            if (band > 0) maximum = Math.max(maximum, this.superfluxCurrent[band - 1]);
            if (band + 1 < bc) maximum = Math.max(maximum, this.superfluxCurrent[band + 1]);
            this.superfluxPreviousMax[band] = maximum;
        }
        const transient = this.superfluxCooldown === 0 && !this.firstFrame
            && flux / bc > 0.03;
        this.superfluxCooldown = transient ? kSuperFluxCooldown
            : (this.superfluxCooldown > 0 ? this.superfluxCooldown - 1 : 0);
        return transient;
    }

    // Vocoder：log1p 谱通量 / 能量归一化 + EMA 均值方差双阈值
    detectVocoderTransient() {
        const nb = this.numBins;
        let flux = 0.0;
        let energy = 0.0;
        for (let bin = 0; bin < nb; ++bin) {
            const weight = 0.5 + 0.5 * bin / (nb - 1);
            const currentLog = Math.log1p(this.currentMag[bin]);
            flux += Math.max(0.0, currentLog - Math.log1p(this.previousMag[bin]));
            energy += weight * currentLog;
        }
        const normalizedFlux = flux / Math.max(energy, 1.0e-9);
        const deviation = Math.sqrt(this.transientVariance);
        const transient = this.transientFrames > 4 && this.transientCooldown === 0
            && normalizedFlux > this.transientMean + 1.5 * Math.max(0.07, deviation)
            && normalizedFlux > this.transientMean * 1.35;

        const alpha = transient ? 0.3 : 0.12;
        if (!this.transientHasMean) {
            this.transientMean = normalizedFlux;
            this.transientHasMean = true;
        } else {
            const delta = normalizedFlux - this.transientMean;
            this.transientMean += alpha * delta;
            this.transientVariance = (1.0 - alpha) * (this.transientVariance + alpha * delta * delta);
        }
        this.transientCooldown = transient ? 1 : (this.transientCooldown > 0 ? this.transientCooldown - 1 : 0);
        ++this.transientFrames;
        return transient;
    }

    // DSPark：对数滤波器组 + 运行中位数 + 固定增量
    detectDsParkTransient() {
        if (this.superfluxBandCount === 0) return false;

        let flux = 0.0;
        const kReferenceFrameSize = 2048.0;
        const scale = kReferenceFrameSize / this.frameSize;
        const bc = this.superfluxBandCount;
        for (let band = 0; band < bc; ++band) {
            let magnitude = 0.0;
            const off = this.superfluxBandOffsets[band];
            const size = this.superfluxBandSizes[band];
            for (let i = 0; i < size; ++i) {
                magnitude += this.currentMag[this.superfluxBandStarts[band] + i] * this.superfluxWeights[off + i];
            }
            this.dsfluxCurrent[band] = Math.log10(magnitude * scale + 1.0);
            if (!this.firstFrame) {
                flux += Math.max(0.0, this.dsfluxCurrent[band] - this.dsfluxMaxPrev[band]);
            }
        }
        flux /= Math.max(1, bc);

        let rise = false;
        if (this.dsfluxFilled >= kDsFluxWindow) {
            const sub = this.dsfluxScratch.subarray(0, kDsFluxWindow);
            sub.set(this.dsfluxHistory.subarray(0, kDsFluxWindow));
            Array.prototype.sort.call(sub, (a, b) => a - b);
            rise = (flux - sub[kDsFluxWindow >> 1]) >= kDsFluxDelta;
        }
        this.dsfluxHistory[this.dsfluxPos] = flux;
        this.dsfluxPos = (this.dsfluxPos + 1) % kDsFluxWindow;
        this.dsfluxFilled = Math.min(this.dsfluxFilled + 1, kDsFluxWindow);

        for (let band = 0; band < bc; ++band) {
            let maximum = this.dsfluxCurrent[band];
            if (band > 0) maximum = Math.max(maximum, this.dsfluxCurrent[band - 1]);
            if (band + 1 < bc) maximum = Math.max(maximum, this.dsfluxCurrent[band + 1]);
            this.dsfluxMaxPrev[band] = maximum;
        }
        const transient = this.dsfluxCooldown === 0 && !this.firstFrame && rise;
        this.dsfluxCooldown = transient ? kDsParkCooldown : (this.dsfluxCooldown > 0 ? this.dsfluxCooldown - 1 : 0);
        return transient;
    }

    // 由幅度与合成相位重建频谱（静音移调后超出奈奎斯特频率的 bin 防混叠）
    synthesizeSpectrum() {
        this.fftOutput.fill(0.0);
        const shiftedNyquist = (this.numBins - 1) / Math.max(this.currentRatio, 1.0e-6);
        for (let bin = 0; bin < this.numBins; ++bin) {
            if (bin > shiftedNyquist) break;
            this.fftOutput[2 * bin] = this.currentMag[bin] * Math.cos(this.currentSynthPhase[bin]);
            this.fftOutput[2 * bin + 1] = this.currentMag[bin] * Math.sin(this.currentSynthPhase[bin]);
        }
        this.fftOutput[1] = 0.0;
        this.fftOutput[2 * (this.numBins - 1) + 1] = 0.0;
    }

    // 窗函数 sinc 插值重采样合成信号
    renderOutputSample() {
        const kResampleStart = this.frameSize - this.hopSize;
        if (!this.resamplerStarted) {
            if (this.synthesisAvailable <= kResampleStart + 1) return 0.0;
            this.resamplePosition = kResampleStart;
            while (this.synthesisClearedUntil < kResampleStart) {
                this.synthesisRing[this.synthesisClearedUntil % this.synthesisRingSize] = 0.0;
                ++this.synthesisClearedUntil;
            }
            this.resamplerStarted = true;
        }

        const lower = Math.floor(this.resamplePosition);
        if (lower + kSincRadius >= this.synthesisAvailable) return 0.0;
        const fraction = this.resamplePosition - lower;
        const tableScale = kSincTableSize / kSincRadius;

        let output = 0.0;
        for (let tap = -kSincRadius + 1; tap <= kSincRadius; ++tap) {
            const tablePos = Math.abs(fraction - tap) * tableScale;
            const index = Math.min(kSincTableSize - 1, tablePos | 0);
            const tableFraction = tablePos - index;
            const kernel = this.sincTable[index] + tableFraction * (this.sincTable[index + 1] - this.sincTable[index]);
            let ringIndex = (lower + tap) % this.synthesisRingSize;
            if (ringIndex < 0) ringIndex += this.synthesisRingSize;
            output += this.synthesisRing[ringIndex] * kernel;
        }

        this.resamplePosition += this.currentRatio;
        const floorPosition = Math.floor(this.resamplePosition);
        // 保留 kSincRadius 个尾随抽头不清理，供下一次插值读取
        const clearUntil = floorPosition > kSincRadius ? floorPosition - kSincRadius : 0;
        while (this.synthesisClearedUntil < clearUntil) {
            this.synthesisRing[this.synthesisClearedUntil % this.synthesisRingSize] = 0.0;
            ++this.synthesisClearedUntil;
        }
        return output;
    }

    // ---- 堆（幅度优先，最大堆）----
    heapPush(magnitude, bin, isPrevious) {
        if (this.heapSize === this.heapCapacity) return;
        let index = this.heapSize++;
        this.heapMag[index] = magnitude;
        this.heapBin[index] = bin;
        this.heapIsPrev[index] = isPrevious ? 1 : 0;
        while (index > 0) {
            const parent = (index - 1) >> 1;
            if (this.heapMag[parent] >= this.heapMag[index]) break;
            this.heapSwap(parent, index);
            index = parent;
        }
    }

    heapPop() {
        const result = {
            magnitude: this.heapMag[0],
            bin: this.heapBin[0],
            isPrevious: this.heapIsPrev[0] === 1
        };
        this.heapSize--;
        this.heapMag[0] = this.heapMag[this.heapSize];
        this.heapBin[0] = this.heapBin[this.heapSize];
        this.heapIsPrev[0] = this.heapIsPrev[this.heapSize];
        let index = 0;
        while (true) {
            const left = index * 2 + 1;
            if (left >= this.heapSize) break;
            const right = left + 1;
            const largest = right < this.heapSize && this.heapMag[right] > this.heapMag[left] ? right : left;
            if (this.heapMag[index] >= this.heapMag[largest]) break;
            this.heapSwap(index, largest);
            index = largest;
        }
        return result;
    }

    heapSwap(a, b) {
        let t = this.heapMag[a]; this.heapMag[a] = this.heapMag[b]; this.heapMag[b] = t;
        t = this.heapBin[a]; this.heapBin[a] = this.heapBin[b]; this.heapBin[b] = t;
        t = this.heapIsPrev[a]; this.heapIsPrev[a] = this.heapIsPrev[b]; this.heapIsPrev[b] = t;
    }

    // ---- 显示支持 ----
    recordTransientMark() {
        const index = this.transientMarkCount % kMaxTransientMarks;
        this.transientMarks[index] = this.inputPosition;
        ++this.transientMarkCount;
    }

    getDisplayInfo() {
        const cols = this.displayColumns;
        for (let i = 0; i < cols; ++i) {
            this.displayEnvelope[2 * i] = this.envMin[i];
            this.displayEnvelope[2 * i + 1] = this.envMax[i];
        }
        return {
            position: this.inputPosition,
            env: this.displayEnvelope.slice(0),
            colIndex: this.displayColIndex,
            totalColumns: this.totalColumnsFinalized,
            marks: this.transientMarks.slice(0),
            markCount: this.transientMarkCount,
            displaySize: this.displaySize,
            columns: cols,
            hop: this.hopSize,
            window: this.windowType,
            ratio: this.currentRatio,
        };
    }
}

// ------------------------------------------------------------
// AudioWorklet 处理器
// ------------------------------------------------------------
if (typeof AudioWorkletGlobalScope !== 'undefined') {
    class PghiProcessor extends AudioWorkletProcessor {
        constructor() {
            super();
            this.shifter = new PghiPitchShifter(sampleRate, 512, 'blackman-harris-3term');
            this.pitch = 0.0;
            this.mode = 4;
            this.bypass = false;
            this.quantum = 0;
            this.port.onmessage = (ev) => this.onMessage(ev.data);
        }

        onMessage(m) {
            if (!m || m.type !== 'params') return;
            if (typeof m.pitch === 'number') {
                this.pitch = m.pitch;
                this.shifter.setPitchShift(this.pitch);
            }
            if (typeof m.mode === 'number') {
                this.mode = m.mode;
                this.shifter.setTransientMode(this.mode);
            }
            if (typeof m.bypass === 'boolean') {
                this.bypass = m.bypass;
            }
            if (typeof m.hop === 'number' && typeof m.window === 'string') {
                // 仅在 HOP/窗函数真正变化时重建；否则保留状态（音高/模式等热切换不清空）
                if (m.hop !== this.shifter.hopSize || m.window !== this.shifter.windowType) {
                    this.shifter.reinit(m.hop, m.window);
                }
            } else if (m.reset) {
                this.shifter.reset();
            }
        }

        process(inputs, outputs) {
            const input = inputs[0] && inputs[0][0];
            const output = outputs[0][0];
            if (!output) return true;
            if (!input) {
                output.fill(0.0);
            } else {
                this.shifter.process(input, output, input.length);
                if (this.bypass) {
                    output.set(input);
                }
            }
            if ((++this.quantum & 7) === 0) {
                const info = this.shifter.getDisplayInfo();
                info.type = 'display';
                info.mode = this.mode;
                info.bypass = this.bypass;
                this.port.postMessage(info);
            }
            return true;
        }
    }
    registerProcessor('pghi-processor', PghiProcessor);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PghiPitchShifter, FftCore };
}
