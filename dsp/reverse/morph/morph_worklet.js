// morph_worklet.js
// AudioWorkletProcessor: Prosoniq Morph 频谱形态化核心的浏览器实时实现。
// 与 reverse 仓库中的 morph_dsp.py / morph_realtime.py 保持一致：
//   2048 点复 FFT，1024 采样 hop，循环播放 A/B 两个源。
// 通过 port 接收：
//   { type: 'sources', a: Float32Array, b: Float32Array }  两个单声道源（相同采样率）
//   { type: 'params',  ...MorphParams, running: bool }     参数与播放开关

const N_FFT = 2048;
const HOP = 1024;

/* ---------- 迭代基-2 复数 FFT（2048 点，预计算旋转因子） ---------- */
class FFT {
    constructor(n) {
        this.n = n;
        const half = n >> 1;
        this.cos = new Float64Array(half);
        this.sin = new Float64Array(half);
        for (let i = 0; i < half; i++) {
            const a = (-2.0 * Math.PI * i) / n;
            this.cos[i] = Math.cos(a);
            this.sin[i] = Math.sin(a);
        }
    }

    // 就地正变换（与 numpy.fft.fft 相同符号约定）
    transform(re, im) {
        const n = this.n;
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const half = len >> 1;
            const step = n / len;
            for (let i = 0; i < n; i += len) {
                for (let k = 0; k < half; k++) {
                    const tw = k * step;
                    const c = this.cos[tw], s = this.sin[tw];
                    const a = i + k, b = a + half;
                    const tre = re[b] * c - im[b] * s;
                    const tim = re[b] * s + im[b] * c;
                    re[b] = re[a] - tre; im[b] = im[a] - tim;
                    re[a] += tre; im[a] += tim;
                }
            }
        }
    }

    // 就地逆变换（conj(fft(conj(x)))/n）
    inverse(re, im) {
        const n = this.n;
        for (let i = 0; i < n; i++) im[i] = -im[i];
        this.transform(re, im);
        for (let i = 0; i < n; i++) { im[i] = -im[i]; re[i] /= n; im[i] /= n; }
    }
}

/* ---------- AudioWorkletProcessor ---------- */
class MorphProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.n = N_FFT;
        this.hop = HOP;
        this.half = N_FFT >> 1;
        this.pad = N_FFT >> 1;
        this.fft = new FFT(N_FFT);

        // 混响（WetDry/Room）由主线程原生 ConvolverNode 处理，worklet 只输出干信号
        this.params = {
            morph_x: 0.5,
            morph_y: 0.0,
            volume: 1.0,
            mode: false,      // false: 双声道都输出实部；true: 正交伪立体声
            mix_a: 0.0,
            mix_b: 0.0,
            running: false,
        };

        this.sourceA = null;
        this.sourceB = null;
        this.lenA = 0;
        this.lenB = 0;
        this.timeline = 0;
        // 音频线程内的状态标志（消息线程只置位，不在消息线程碰 DSP 缓冲）
        this._running = false;
        this._needReset = false;

        // sqrt-Hann 分析/合成窗
        this.win = new Float64Array(N_FFT);
        for (let i = 0; i < N_FFT; i++) {
            this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2.0 * Math.PI * i) / N_FFT));
        }

        // FFT 工作缓冲
        this.reA = new Float64Array(N_FFT);
        this.imA = new Float64Array(N_FFT);
        this.reB = new Float64Array(N_FFT);
        this.imB = new Float64Array(N_FFT);
        this.magA = new Float64Array(this.half);
        this.magB = new Float64Array(this.half);
        // 包络用 scratch（envA -> scr1/scr2，envB -> scr3/scr4）
        this.scr1 = new Float64Array(N_FFT);
        this.scr2 = new Float64Array(N_FFT);
        this.scr3 = new Float64Array(N_FFT);
        this.scr4 = new Float64Array(N_FFT);
        // 形态化输出谱 + 逆变换结果
        this.reOut = new Float64Array(N_FFT);
        this.imOut = new Float64Array(N_FFT);
        this.blkRe = new Float64Array(N_FFT);
        this.blkIm = new Float64Array(N_FFT);
        // 重叠相加
        this.accL = new Float64Array(N_FFT);
        this.accR = new Float64Array(N_FFT);
        this.accW = new Float64Array(N_FFT);
        // 输出环形缓冲（立体声交错）
        this.capFrames = 4096;
        this.ring = new Float32Array(this.capFrames * 2);
        this.rpos = 0;
        this.wpos = 0;
        // 块级 scratch
        this.chunk = new Float32Array(HOP * 2);
        this.dry = new Float32Array(HOP * 2);

        this.port.onmessage = (e) => this._onMessage(e.data);
    }

    _onMessage(d) {
        if (d.type === 'sources') {
            // 只更新源引用并置位重置标志；缓冲重置在音频线程内完成，避免竞争
            this.sourceA = new Float64Array(d.a);
            this.sourceB = new Float64Array(d.b);
            this.lenA = this.sourceA.length;
            this.lenB = this.sourceB.length;
            this._needReset = true;
        } else if (d.type === 'params') {
            Object.assign(this.params, d);
        }
    }

    // 在音频线程内完成缓冲重置（收到新源时调用）
    _resetState() {
        this.timeline = 0;
        this.accL.fill(0); this.accR.fill(0); this.accW.fill(0);
        this.rpos = this.wpos = 0;
        this.ring.fill(0);
    }

    _available() {
        return (this.wpos - this.rpos + this.capFrames) % this.capFrames;
    }

    _pushFrame(l, r) {
        this.ring[2 * this.wpos] = l;
        this.ring[2 * this.wpos + 1] = r;
        this.wpos = (this.wpos + 1) % this.capFrames;
    }

    // 频谱包络（0x1000ee20 的包络通路）
    // 输入 mag（前 half 个幅度 bin），输出仍写入 re 的前 half，并返回 re
    _spectralEnvelope(mag, x, re, im) {
        const n = this.n, half = this.half;
        let width = Math.round(n * x * x * x);
        width = Math.max(2, Math.min(width, n));
        for (let k = 0; k < half; k++) {
            re[k] = (k & 1) ? -mag[k] : mag[k];
            im[k] = 0;
        }
        for (let k = half; k < n; k++) { re[k] = 0; im[k] = 0; }
        this.fft.inverse(re, im); // 逆变换，取实部
        const center = half;
        const left = Math.max(0, center - (width >> 1));
        const right = Math.min(n, center + (width >> 1) + 1);
        const segLen = right - left;
        const q = segLen - 1;
        for (let i = 0; i < left; i++) re[i] = 0;
        for (let i = right; i < n; i++) re[i] = 0;
        const invQ = 1.0 / q;
        for (let i = left; i < right; i++) {
            const idx = i - left;
            const a = 2.0 * Math.PI * idx * invQ;
            re[i] *= 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a); // Blackman
        }
        for (let i = 0; i < n; i++) im[i] = 0; // 仅对实部做正变换
        this.fft.transform(re, im);
        for (let k = 0; k < half; k++) {
            re[k] = 2.0 * Math.hypot(re[k], im[k]);
        }
        return re;
    }

    // 生成一个 HOP 的输出块
    _step() {
        const p = this.params;
        if (!p.running || this.sourceA === null || this.sourceB === null ||
            this.lenA === 0 || this.lenB === 0) {
            for (let i = 0; i < this.hop; i++) this._pushFrame(0, 0);
            return;
        }
        const n = this.n, half = this.half;
        const timeline = this.timeline;
        const a = this.sourceA, b = this.sourceB;
        const la = this.lenA, lb = this.lenB;
        const pad = this.pad;
        const win = this.win;

        // 加窗取帧（环形取模，循环播放）
        const reA = this.reA, imA = this.imA, reB = this.reB, imB = this.imB;
        for (let i = 0; i < n; i++) {
            let ai = timeline + i - pad;
            ai = ((ai % la) + la) % la;
            let bi = timeline + i - pad;
            bi = ((bi % lb) + lb) % lb;
            const w = win[i];
            reA[i] = a[ai] * w; imA[i] = 0;
            reB[i] = b[bi] * w; imB[i] = 0;
        }

        this.fft.transform(reA, imA);
        this.fft.transform(reB, imB);

        for (let k = 0; k < half; k++) {
            this.magA[k] = Math.hypot(reA[k], imA[k]);
            this.magB[k] = Math.hypot(reB[k], imB[k]);
        }

        const x = Math.max(0, Math.min(1, p.morph_x));
        const y = Math.max(0, Math.min(1, p.morph_y));
        const a11 = Math.pow(x, 11);
        const b11 = Math.pow(1 - x, 11);
        const wa = 1 - b11, wb = 1 - a11;
        const t = wa * wb;

        const envA = this._spectralEnvelope(this.magA, x, this.scr1, this.scr2);
        const envB = this._spectralEnvelope(this.magB, x, this.scr3, this.scr4);

        const reOut = this.reOut, imOut = this.imOut;
        const omx = 1 - y;
        for (let k = 0; k < half; k++) {
            const ma = this.magA[k], mb = this.magB[k];
            const ea = envA[k], eb = envB[k];
            const ra = ea > 0 ? Math.min(ma / ea, 1000) : 1.0;
            const rb = eb > 0 ? Math.min(mb / eb, 1000) : 1.0;
            const ima = ma > 0 ? 1 / ma : 0;
            const imb = mb > 0 ? 1 / mb : 0;
            const caRe = reA[k] * ima, caIm = imA[k] * ima;
            const cbRe = reB[k] * imb, cbIm = imB[k] * imb;
            const c1 = omx * ra * eb, c2 = y * rb * ea;
            const crossRe = c1 * caRe + c2 * cbRe;
            const crossIm = c1 * caIm + c2 * cbIm;
            const normalRe = omx * reA[k] + y * reB[k];
            const normalIm = omx * imA[k] + y * imB[k];
            const swapRe = omx * reB[k] + y * reA[k];
            const swapIm = omx * imB[k] + y * imA[k];
            reOut[k] = t * crossRe + b11 * normalRe + a11 * swapRe;
            imOut[k] = t * crossIm + b11 * normalIm + a11 * swapIm;
        }
        for (let k = half; k < n; k++) { reOut[k] = 0; imOut[k] = 0; }

        // 逆变换（仅正频率谱，产生复数时间块）
        const blkRe = this.blkRe, blkIm = this.blkIm;
        blkRe.set(reOut);
        blkIm.set(imOut);
        this.fft.inverse(blkRe, blkIm);

        // 重叠相加
        const accL = this.accL, accR = this.accR, accW = this.accW;
        for (let i = 0; i < n; i++) {
            const synth = 2.0 * win[i];
            if (p.mode) {
                // Wide ON: 正交伪立体声
                accL[i] += (blkRe[i] - 0.25 * blkIm[i]) * synth;
                accR[i] += (blkIm[i] - 0.25 * blkRe[i]) * synth;
            } else {
                accL[i] += blkRe[i] * synth;
                accR[i] += blkRe[i] * synth;
            }
            accW[i] += win[i] * synth;
        }

        // 输出 HOP 帧（干信号：形态化结果 × 音量；混响由主线程 ConvolverNode 处理）
        const chunk = this.chunk, dry = this.dry;
        const vol = 2.0 * p.volume;
        for (let i = 0; i < this.hop; i++) {
            const w = accW[i];
            let l = w > 1e-12 ? accL[i] / w : 0;
            let r = w > 1e-12 ? accR[i] / w : 0;
            chunk[2 * i] = l * vol;
            chunk[2 * i + 1] = r * vol;
            const di = timeline + i;
            dry[2 * i] = a[((di % la) + la) % la];
            dry[2 * i + 1] = b[((di % lb) + lb) % lb];
        }

        // MixA/MixB 直接叠加原始源（默认 0，保留以对齐参数表）
        if (p.mix_a !== 0 || p.mix_b !== 0) {
            for (let i = 0; i < this.hop; i++) {
                const add = p.mix_a * dry[2 * i] + p.mix_b * dry[2 * i + 1];
                chunk[2 * i] += add;
                chunk[2 * i + 1] += add;
            }
        }

        for (let i = 0; i < this.hop; i++) {
            this._pushFrame(chunk[2 * i], chunk[2 * i + 1]);
        }

        // 平移重叠相加缓冲
        for (let i = 0; i < n - this.hop; i++) {
            accL[i] = accL[i + this.hop];
            accR[i] = accR[i + this.hop];
            accW[i] = accW[i + this.hop];
        }
        for (let i = n - this.hop; i < n; i++) { accL[i] = 0; accR[i] = 0; accW[i] = 0; }
        this.timeline = timeline + this.hop;
    }

    process(inputs, outputs) {
        const out = outputs[0];
        const chL = out[0];
        const chR = out[1];
        const frames = chL.length;
        try {
            // 音频线程内完成缓冲重置（对应新源消息）
            if (this._needReset) {
                this._needReset = false;
                this._resetState();
            }
            // 启动预热：running 由 false 变 true 时静默推进 2 帧填充 WOLA 累加器，
            // 丢弃热身输出以避免启动瞬态削波。必须与 process 在同一音频线程执行。
            if (this.params.running && !this._running) {
                this._running = true;
                for (let i = 0; i < 2; i++) this._step();
                this.rpos = this.wpos = 0;
                this.ring.fill(0);
            } else if (!this.params.running) {
                this._running = false;
            }
            let guard = 0;
            while (this._available() < frames) {
                this._step();
                if (++guard > 8) break;
            }
        } catch (err) {
            this.port.postMessage({ type: 'error', message: String(err) });
        }
        for (let i = 0; i < frames; i++) {
            chL[i] = this.ring[2 * this.rpos];
            if (chR) chR[i] = this.ring[2 * this.rpos + 1];
            this.rpos = (this.rpos + 1) % this.capFrames;
        }
        return true;
    }
}

registerProcessor('morph-processor', MorphProcessor);
