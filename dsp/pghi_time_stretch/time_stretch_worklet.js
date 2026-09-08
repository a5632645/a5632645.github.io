/*
 * time_stretch_worklet.js — AudioWorklet 处理器（wasm 桥接，时间拉伸版）
 *
 * DSP 核心在 pghi_time_stretch.wasm（C++ 编译，clang wasm32，无 emscripten）。
 * 与移调器 worklet 的关键区别：
 *   * 输入不再是 AudioBufferSourceNode 的实时流，而是主线程解码后一次性写入
 *     wasm 源缓冲（source_ptr），由 DSP 自身按速度从缓冲拉取分析帧；
 *   * process() 只把 wasm 输出拷回（无输入拷贝）；
 *   * 播放/暂停/停止/循环由 worklet 转发给 wasm，文件播放进度取自 wasm。
 *
 * 窗类型映射：0=hann  1=blackman-harris 3-term  2=blackman-harris 4-term
 */

'use strict';

const WINDOW_INDEX = { 'hann': 0, 'blackman-harris-3term': 1, 'blackman-harris': 2 };

class TimeStretchProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.wasm = null;
        this.mem = null;      // Float32Array 视图
        this.outPtr = 0;
        this.srcPtr = 0;
        this.srcCap = 0;
        this.speed = 1.0;
        this.mode = 1;        // DSPark
        this.bypass = false;
        this.hop = 512;
        this.windowType = 'blackman-harris-3term';
        this.quantum = 0;
        this.wasPlaying = false;
        this.pending = [];    // wasm 就绪前到达的 source / params / transport 消息
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
        // wasm 尚未实例化：先入队，initWasm 完成后按序重放，避免丢样本/参数
        if (!this.wasm) {
            this.pending.push(m);
            return;
        }
        const ex = this.wasm.exports;

        if (m.type === 'source') {
            // 整段单声道样本写入 wasm 源缓冲
            const n = Math.min(m.length, this.srcCap);
            this.mem.set(m.data.subarray(0, n), this.srcPtr >> 2);
            ex.set_source(n);
            this.wasPlaying = false;
            this.port.postMessage({ type: 'source-loaded', length: n });
            return;
        }

        if (m.type === 'transport') {
            if (m.action === 'play') ex.play();
            else if (m.action === 'pause') ex.pause();
            else if (m.action === 'stop') ex.stop();
            else if (m.action === 'loop') ex.set_loop(m.value ? 1 : 0);
            else if (m.action === 'reset') ex.reset();
            this.wasPlaying = false;
            return;
        }

        if (m.type !== 'params') return;
        if (typeof m.speed === 'number') {
            this.speed = m.speed;
            ex.set_speed(this.speed);
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
            ex.set_bypass(this.bypass ? 1 : 0);
        }
        if (typeof m.loop === 'boolean') {
            ex.set_loop(m.loop ? 1 : 0);
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
        this.outPtr = ex.out_ptr();
        this.srcPtr = ex.source_ptr();
        this.srcCap = ex.source_capacity();
        ex.init(sampleRate, this.hop, WINDOW_INDEX[this.windowType]);
        ex.set_transient_mode(this.mode);
        ex.set_cooldown_ms(64);
        this.port.postMessage({ type: 'wasm-ready', sourceCapacity: this.srcCap });
        // 重放就绪前入队的消息（source 写入、参数、传输命令），保持到达顺序
        const queued = this.pending;
        this.pending = [];
        for (const q of queued) this.onMessage(q);
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

        ex.process(n);

        const base = this.outPtr >> 2;
        for (let i = 0; i < n; ++i) output[i] = this.mem[base + i];

        // 播放状态变化时上报（主线程据此更新按钮/进度）
        const playing = ex.is_playing() === 1;
        if (playing !== this.wasPlaying) {
            this.wasPlaying = playing;
            this.port.postMessage({ type: 'state', playing: playing });
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
            speed: ex.speed(),
            sourceLength: ex.source_length(),
            playing: ex.is_playing() === 1,
            bypass: ex.is_bypass() === 1,
            mode: this.mode,
        });
    }
}

registerProcessor('time-stretch-processor', TimeStretchProcessor);
