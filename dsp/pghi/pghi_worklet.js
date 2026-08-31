/*
 * pghi_worklet.js — AudioWorklet 处理器（wasm 桥接）
 *
 * DSP 核心在 pghi_shifter.wasm（C++ 编译，clang wasm32，无 emscripten）。
 * 主线程加载 wasm Module 后通过 port 传入，本处理器在此实例化并逐量子调用：
 *   process(): 输入拷入 wasm 内存 → ex.process(n) → 输出拷回
 *   params:    音高 / 瞬态模式 / 统一冷却时间(ms) / HOP / 窗函数
 *   display:   每 8 个量子从 wasm 读取波形包络与瞬态标记发回主线程
 *
 * 窗类型映射：0=hann  1=blackman-harris 3-term  2=blackman-harris 4-term
 */

'use strict';

const WINDOW_INDEX = { 'hann': 0, 'blackman-harris-3term': 1, 'blackman-harris': 2 };

class PghiProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.wasm = null;
        this.mem = null;      // Float32Array 视图
        this.inPtr = 0;
        this.outPtr = 0;
        this.pitch = 0.0;
        this.mode = 4;        // DSPark
        this.bypass = false;
        this.hop = 512;
        this.windowType = 'blackman-harris-3term';
        this.quantum = 0;
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
        if (typeof m.mode === 'number') {
            this.mode = m.mode;
            ex.set_transient_mode(this.mode);
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
        this.inPtr = ex.in_ptr();
        this.outPtr = ex.out_ptr();
        ex.init(sampleRate, this.hop, WINDOW_INDEX[this.windowType]);
        ex.set_transient_mode(this.mode);
        ex.set_cooldown_ms(64);
        this.port.postMessage({ type: 'wasm-ready' });
    }

    process(inputs, outputs) {
        const output = outputs[0] && outputs[0][0];
        if (!output) return true;
        if (!this.wasm) {
            output.fill(0.0);
            return true;
        }
        const ex = this.wasm.exports;
        const n = output.length;
        const input = inputs[0] && inputs[0][0];

        if (input) {
            // 输入拷入 wasm（指针为字节偏移，Float32Array 索引 = 字节 >> 2）
            for (let i = 0; i < n; ++i) this.mem[(this.inPtr >> 2) + i] = input[i];
        } else {
            for (let i = 0; i < n; ++i) this.mem[(this.inPtr >> 2) + i] = 0.0;
        }

        ex.process(n);

        if (this.bypass && input) {
            output.set(input);
        } else {
            const base = this.outPtr >> 2;
            for (let i = 0; i < n; ++i) output[i] = this.mem[base + i];
        }

        if ((++this.quantum & 7) === 0) {
            this.postDisplay();
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
            mode: this.mode,
        });
    }
}

registerProcessor('pghi-processor', PghiProcessor);
