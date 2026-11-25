/*
 * pghi_worklet.js — AudioWorklet 处理器（wasm 桥接）
 *
 * DSP 核心在 pghi_shifter.wasm（C++ 编译，clang wasm32，无 emscripten）。
 * 主线程加载 wasm Module 后通过 port 传入，本处理器在此实例化并逐量子调用：
 *   process(): 输入拷入 wasm 内存 → ex.process(n) → 输出拷回
 *   params:    音高 / 算法 / 统一冷却时间(ms) / HOP / 窗函数
 *   display:   每 8 个量子从 wasm 读取波形包络与瞬态标记发回主线程
 *
 */

'use strict';

const workletClock = globalThis.performance;
const nowMs = typeof workletClock?.now === 'function' ? () => workletClock.now() : Date.now;
const LOAD_REPORT_SECONDS = 0.5;

const WINDOW_INDEX = {
    hann: 0, 'blackman-harris-3term': 1, 'blackman-harris': 2,
    gaussian: 3, 'gaussian-59db': 4, 'gaussian-79db': 5, 'gaussian-102db': 6,
};

class PghiProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.wasm = null;
        this.mem = null;      // Float32Array 视图
        this.inBase = [];
        this.outBase = [];
        this.pitch = 0.0;
        this.bypass = false;
        this.hop = 512;
        this.windowType = 'blackman-harris-3term';
        this.quantum = 0;
        this.loadFrames = 0;
        this.loadElapsedMs = 0;
        this.port.onmessage = (ev) => this.onMessage(ev.data);
    }

    onMessage(m) {
        if (!m) return;
        if (m.type === 'wasm') {
            this.initWasm(m).catch(err => {
                this.port.postMessage({ type: 'wasm-error', message: String(err) });
            });
            return;
        }
        if (m.type !== 'params' || !this.wasm) return;
        const ex = this.wasm.exports;
        if (typeof m.pitch === 'number') {
            this.pitch = m.pitch;
            ex.set_pitch_shift(this.pitch);
        }
        if (Number.isInteger(m.algorithm)) {
            ex.set_algorithm(m.algorithm);
        }
        if (typeof m.cooldownMs === 'number') {
            ex.set_cooldown_ms(m.cooldownMs);
        }
        if (typeof m.bypass === 'boolean') {
            this.bypass = m.bypass;
        }
        if (typeof m.hop === 'number' && typeof m.window === 'string') {
            if (m.hop !== this.hop || m.window !== this.windowType) {
                this.hop = m.hop;
                this.windowType = m.window;
                ex.reinit(this.hop, WINDOW_INDEX[this.windowType]);
                this.postGeometry();
            }
        } else if (m.reset) {
            ex.reset();
        }
    }

    // 支持两种载荷：WebAssembly.Module（m.module）或 ArrayBuffer 字节（m.bytes）
    async initWasm(m) {
        let module;
        if (m.module instanceof WebAssembly.Module) {
            module = m.module;
        } else if (m.bytes) {
            module = await WebAssembly.compile(m.bytes);
        } else {
            throw new Error('no wasm payload');
        }
        this.wasm = new WebAssembly.Instance(module, {});
        const ex = this.wasm.exports;
        this.mem = new Float32Array(ex.memory.buffer);
        this.inBase = [ex.in_ptr() >> 2, ex.in_right_ptr() >> 2];
        this.outBase = [ex.out_ptr() >> 2, ex.out_right_ptr() >> 2];
        ex.init(sampleRate, this.hop, WINDOW_INDEX[this.windowType]);
        ex.set_cooldown_ms(64);
        this.postGeometry();
        this.port.postMessage({ type: 'wasm-ready' });
    }

    postGeometry() {
        const ex = this.wasm.exports;
        this.port.postMessage({
            type: 'geometry',
            hop: ex.hop(),
            window: this.windowType,
            windowSize: ex.window_size(),
            fftSize: ex.fft_size(),
        });
    }

    process(inputs, outputs) {
        const output = outputs[0];
        if (!output?.length) return true;
        if (!this.wasm) {
            for (const channel of output) channel.fill(0);
            return true;
        }
        const startMs = nowMs();
        const input = inputs[0];
        const n = output[0].length;
        for (let ch = 0; ch < 2; ++ch) {
            const channel = input[ch] ?? input[0];
            const base = this.inBase[ch];
            if (channel) this.mem.set(channel, base);
            else this.mem.fill(0, base, base + n);
        }

        this.wasm.exports.process(n);

        for (let ch = 0; ch < output.length; ++ch) {
            const channel = input[ch] ?? input[0];
            if (this.bypass && channel) {
                output[ch].set(channel);
            } else {
                const base = this.outBase[ch];
                for (let i = 0; i < n; ++i) output[ch][i] = this.mem[base + i];
            }
        }

        if ((++this.quantum & 7) === 0) {
            this.postDisplay();
        }

        this.loadElapsedMs += Math.max(0, nowMs() - startMs);
        this.loadFrames += n;
        if (this.loadFrames >= sampleRate * LOAD_REPORT_SECONDS) {
            const budgetMs = this.loadFrames * 1000 / sampleRate;
            this.port.postMessage({ type: 'audio-load', percent: 100 * this.loadElapsedMs / budgetMs });
            this.loadElapsedMs = 0;
            this.loadFrames = 0;
        }
        return true;
    }

    postDisplay() {
        const ex = this.wasm.exports;
        const mem = this.mem;
        const envPtr = ex.env_ptr();
        const envBase = envPtr >> 2;
        const cols = ex.columns();
        const env = new Float32Array(cols * 2);
        for (let i = 0; i < cols * 2; ++i) env[i] = mem[envBase + i];

        const markCount = ex.mark_count();
        const marks = new Float64Array(32);
        const dv = new DataView(ex.memory.buffer);
        const mp = ex.marks_ptr();
        for (let i = 0; i < 32; ++i) marks[i] = dv.getFloat64(mp + i * 8, true);

        this.port.postMessage({
            type: 'display',
            env: env,
            position: ex.position(),
            colIndex: ex.col_index(),
            totalColumns: ex.total_columns(),
            marks: marks,
            markCount: markCount,
            displaySize: ex.display_size(),
            columns: cols,
            hop: ex.hop(),
            window: this.windowType,
            ratio: ex.ratio(),
        });
    }
}

registerProcessor('pghi-processor', PghiProcessor);
