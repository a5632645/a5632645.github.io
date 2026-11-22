const blockSize = 128;

class PbshiftProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.engine = null;
        this.active = false;
        this.port.onmessage = ({ data }) => this.handle(data);
    }

    async handle(message) {
        try {
            if (message.type === 'init') {
                const { instance } = await WebAssembly.instantiate(message.bytes, {
                    wasi_snapshot_preview1: {
                        proc_exit: code => { throw new Error('pbshift exited: ' + code); },
                        fd_write: () => 8,
                        fd_close: () => 8,
                        fd_seek: () => 8,
                        environ_sizes_get: (count, size) => {
                            const memory = new DataView(this.engine.memory.buffer);
                            memory.setUint32(count, 0, true);
                            memory.setUint32(size, 0, true);
                            return 0;
                        },
                        environ_get: () => 0,
                    },
                    env: {
                        emscripten_notify_memory_growth: () => {},
                    },
                });
                this.engine = instance.exports;
                this.engine._initialize();
                this.apply(message.params);
                this.port.postMessage({ type: 'ready' });
            } else if (message.type === 'params') {
                this.apply(message.params);
            } else if (message.type === 'reset') {
                this.engine.pb_reset();
                this.active = false;
                this.draining = false;
                this.apply(this.params);
            }
        } catch (error) {
            this.port.postMessage({ type: 'error', message: error.message });
        }
    }

    apply(params) {
        const previous = this.params;
        const engine = this.engine;
        if (!previous || previous.mode !== params.mode || previous.tier !== params.tier) {
            const latency = engine.pb_configure(sampleRate, params.mode, params.tier);
            this.active = false;
            this.draining = false;
            this.port.postMessage({ type: 'latency', samples: latency });
            engine.pb_formants(params.formants);
        } else if (previous.formants !== params.formants) {
            engine.pb_formants(params.formants);
        }
        engine.pb_pitch(params.pitch);
        this.params = params;
    }

    process(inputs, outputs) {
        if (!this.engine) return true;
        const input = inputs[0];
        const output = outputs[0];
        const engine = this.engine;

        for (let offset = 0; offset < output[0].length; offset += blockSize) {
            const frames = Math.min(blockSize, output[0].length - offset);
            if (input.length) {
                const memory = new Float32Array(engine.memory.buffer);
                const start = engine.pb_input() / 4;
                for (let channel = 0; channel < output.length; channel++) {
                    const samples = input[channel] || input[0];
                    memory.set(samples.subarray(offset, offset + frames), start + channel * blockSize);
                }
                engine.pb_feed(frames);
                this.active = true;
            } else if (this.active) {
                engine.pb_finish();
                this.active = false;
                this.draining = true;
            }

            if (!this.active && !this.draining) continue;
            const written = engine.pb_read(frames);
            if (this.draining && written < frames) {
                this.draining = false;
                this.port.postMessage({ type: 'drained' });
            }
            const memory = new Float32Array(engine.memory.buffer);
            const start = engine.pb_output() / 4;
            for (let channel = 0; channel < output.length; channel++) {
                if (this.params.bypass && input.length) {
                    output[channel].set((input[channel] || input[0]).subarray(offset, offset + frames), offset);
                } else if (!this.params.bypass) {
                    const position = start + channel * blockSize;
                    output[channel].set(memory.subarray(position, position + written), offset);
                }
            }
        }
        return true;
    }
}

registerProcessor('pbshift-processor', PbshiftProcessor);
