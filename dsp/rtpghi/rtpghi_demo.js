/* RTPGHI demo: pipeline, rendering and animation. */
'use strict';

(function () {
    const R = window.RTPGHI;
    const $ = (id) => document.getElementById(id);
    const TAU = 2 * Math.PI;
    const DEFAULT_RATE = 48000;
    const DISPLAY_HZ = 12000;
    const RATE_TOLERANCE = 1e-6;

    const STAGES = [
        { name: '分析 STFT', dur: 1600 },
        { name: '相位差分', dur: 2000 },
        { name: '瞬态锚点', dur: 1600 },
        { name: '堆积分', dur: 5200 },
        { name: 'WOLA 合成', dur: 2200 },
    ];
    const TOTAL_MS = STAGES.reduce((sum, s) => sum + s.dur, 0);
    const INTEGRATE_START = STAGES.slice(0, 3).reduce((sum, s) => sum + s.dur, 0);

    /* ------------------------------------------------------------------ */
    /* small helpers                                                       */
    /* ------------------------------------------------------------------ */

    const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const countFinite = (array) => {
        let count = 0;
        for (let i = 0; i < array.length; i++) if (Number.isFinite(array[i])) count++;
        return count;
    };
    const fmt = (x, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : '—');
    const dbLabel = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');

    function chooseStep(max, count) {
        if (!(max > 0)) return 1;
        const raw = max / count;
        const power = Math.pow(10, Math.floor(Math.log10(raw)));
        const mantissa = raw / power;
        const nice = mantissa < 1.5 ? 1 : mantissa < 3 ? 2 : mantissa < 7 ? 5 : 10;
        return nice * power;
    }

    function fitCanvas(canvas) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const width = Math.max(320, canvas.clientWidth || 320);
        const height = Math.max(120, canvas.clientHeight || 200);
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx, width, height };
    }

    function text(ctx, value, x, y, color, align = 'left', baseline = 'alphabetic') {
        ctx.fillStyle = color;
        ctx.textAlign = align;
        ctx.textBaseline = baseline;
        ctx.fillText(value, x, y);
    }

    function roundRect(ctx, x, y, w, h, radius) {
        const r = Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    /* ------------------------------------------------------------------ */
    /* colour maps                                                         */
    /* ------------------------------------------------------------------ */

    const MAG_STOPS = [
        [0.00, [8, 11, 16]],
        [0.28, [20, 31, 45]],
        [0.55, [48, 78, 101]],
        [0.78, [132, 172, 194]],
        [1.00, [239, 247, 252]],
    ];

    const MAG_LUT = (() => {
        const lut = new Uint8Array(256 * 3);
        for (let i = 0; i < 256; i++) {
            const t = i / 255;
            let a = MAG_STOPS[0];
            let b = MAG_STOPS[MAG_STOPS.length - 1];
            for (let s = 0; s < MAG_STOPS.length - 1; s++) {
                if (t >= MAG_STOPS[s][0] && t <= MAG_STOPS[s + 1][0]) {
                    a = MAG_STOPS[s];
                    b = MAG_STOPS[s + 1];
                    break;
                }
            }
            const u = (t - a[0]) / Math.max(1e-9, b[0] - a[0]);
            for (let c = 0; c < 3; c++) {
                lut[i * 3 + c] = Math.round(a[1][c] + (b[1][c] - a[1][c]) * u);
            }
        }
        return lut;
    })();

    function hslToRgb(h, s, l) {
        const hue = ((h % 1) + 1) % 1;
        if (s === 0) {
            const value = Math.round(l * 255);
            return [value, value, value];
        }
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        const channel = (t) => {
            let x = t;
            if (x < 0) x += 1;
            if (x > 1) x -= 1;
            if (x < 1 / 6) return p + (q - p) * 6 * x;
            if (x < 1 / 2) return q;
            if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
            return p;
        };
        return [Math.round(channel(hue + 1 / 3) * 255),
                Math.round(channel(hue) * 255),
                Math.round(channel(hue - 1 / 3) * 255)];
    }

    const PHASE_LUT = (() => {
        const lut = new Uint8Array(360 * 3);
        for (let i = 0; i < 360; i++) {
            const rgb = hslToRgb(i / 360, 0.82, 0.56);
            lut[i * 3] = rgb[0];
            lut[i * 3 + 1] = rgb[1];
            lut[i * 3 + 2] = rgb[2];
        }
        return lut;
    })();

    function phaseRgb(phase, lightness) {
        const h = (((phase + Math.PI) / TAU) % 1 + 1) % 1;
        return hslToRgb(h, 0.68, lightness);
    }

    function magT(magnitude, peak) {
        const db = 20 * Math.log10(magnitude / Math.max(1e-30, peak) + 1e-12);
        return clamp((db + 88) / 88, 0, 1);
    }

    /* ------------------------------------------------------------------ */
    /* signal generation (mirrors experiment.py)                           */
    /* ------------------------------------------------------------------ */

    function buildBuiltinSignal(kind, rate) {
        const n = Math.round(0.46 * rate);
        const onset = Math.round(0.22 * rate) + 37;
        const signal = new Float64Array(n);

        if (kind === 'impulse') {
            signal[onset] = 0.8;
            return { signal, onsets: [onset], duration: 1, name: '单冲激' };
        }

        const duration = Math.round(0.007 * rate);
        const rand = R.rng(42);
        const burst = new Float64Array(n);
        for (let i = 0; i < duration; i++) {
            burst[onset + i] = 0.32 * (2 * rand() - 1) * Math.exp(-5 * i / duration);
        }
        burst[onset] = 0.8;

        if (kind === 'burst') {
            return { signal: burst, onsets: [onset], duration, name: '噪声突发' };
        }

        const t = new Float64Array(n);
        for (let i = 0; i < n; i++) t[i] = i / rate;
        const tone = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const fade = Math.min(1, Math.min(t[i], n / rate - t[i]) / 0.03);
            tone[i] = (0.09 * Math.sin(TAU * 441 * t[i]) + 0.04 * Math.sin(TAU * 882 * t[i] + 0.3)) * fade;
        }

        if (kind === 'tone') {
            return { signal: tone, onsets: [], duration: 1, name: '持续音' };
        }

        const second = onset + Math.round(0.020 * rate);
        const mixed = new Float64Array(n);
        for (let i = 0; i < n; i++) mixed[i] = tone[i] + 0.85 * burst[i];
        for (let i = 0; i < duration; i++) mixed[second + i] += 0.6 * burst[onset + i];
        return { signal: mixed, onsets: [onset, second], duration, name: '持续音 + 两个起音' };
    }

    /* ------------------------------------------------------------------ */
    /* state                                                               */
    /* ------------------------------------------------------------------ */

    const state = {
        data: null,
        busy: false,
        dirty: true,
        play: { active: false, t: TOTAL_MS, last: 0, speed: 1 },
        hover: null,
        selected: null,
        focus: null,
        file: null,
        useFile: false,
        detected: null,
        audio: { ctx: null, source: null, which: null, start: 0, duration: 0, raf: null },
        overlay: { key: '', canvas: null, image: null, ctx: null },
        images: null,
    };

    function readConfig() {
        const requested = parseFloat($('ratioRange').value);
        const windowSize = parseInt($('windowSel').value, 10);
        const fftSize = windowSize * 2;
        const synthesisHop = parseInt($('hopSel').value, 10);
        const analysisHop = clamp(R.pyRound(synthesisHop / requested), 1, windowSize >> 1);
        const ratio = synthesisHop / analysisHop;
        return {
            requested,
            windowSize,
            fftSize,
            synthesisHop,
            analysisHop,
            ratio,
            radius: Math.floor((windowSize - 1) / synthesisHop),
            tolerance: RATE_TOLERANCE,
            edgeScheme: $('edgeSel').value,
            anchorMode: $('anchorSel').value,
            method: $('methodSel').value,
        };
    }

    function methodRecordKey(method) {
        if (method === 'causal-centered') return 'centered';
        if (method === 'causal-direct') return 'direct';
        return method;
    }

    function updateParamLabels() {
        const config = readConfig();
        $('fftVal').textContent = String(config.fftSize);
        const requested = config.requested.toFixed(3);
        const actual = config.ratio.toFixed(3);
        $('ratioVal').textContent = Math.abs(config.ratio - config.requested) < 0.001
            ? `${requested}×`
            : `${requested}× → ${actual}×`;
        $('paramSummary').textContent =
            `M=${config.windowSize} · FFT=${config.fftSize} · Ha=${config.analysisHop} · ` +
            `Hs=${config.synthesisHop} · α=${actual} · 半径=${config.radius} 帧`;
    }

    function setStatus(message, kind) {
        $('statusText').textContent = message;
        const dot = $('statusDot');
        dot.className = 'status-dot ' + (kind === 'on' ? 'status-on' : kind === 'err' ? 'status-err' : 'status-off');
    }

    function setBusy(busy, message) {
        state.busy = busy;
        $('runBtn').disabled = busy;
        $('playBtn').disabled = busy;
        $('busyTrack').style.display = busy ? 'block' : 'none';
        if (busy) {
            setStatus(message || '计算中…', '');
            $('busyFill').style.width = '2%';
        }
    }

    function progress(fraction, message) {
        $('busyFill').style.width = `${Math.round(clamp(fraction, 0, 1) * 100)}%`;
        if (message) setStatus(message, '');
    }

    function markDirty(message) {
        state.dirty = true;
        $('runNote').textContent = '参数已修改';
        setStatus(message || '参数已更改，点击“运行 / 重算”', '');
    }

    /* ------------------------------------------------------------------ */
    /* pipeline                                                            */
    /* ------------------------------------------------------------------ */

    function resolveInput(config) {
        if (state.useFile && state.file) {
            return {
                signal: state.file.signal,
                rate: state.file.rate,
                onsets: [],
                duration: Math.round(0.007 * state.file.rate),
                name: state.file.name,
                isFile: true,
            };
        }
        const kind = $('caseSel').value;
        const builtIn = buildBuiltinSignal(kind, DEFAULT_RATE);
        return { ...builtIn, rate: DEFAULT_RATE, isFile: false };
    }

    function buildGridContext(config, input) {
        const signal = input.signal;
        const rate = input.rate;
        const length = R.pyRound(signal.length * config.ratio);
        const rows = Math.max(2, 1 + Math.ceil(length / config.synthesisHop));
        const centers = new Int32Array(rows);
        const outCenters = new Int32Array(rows);
        for (let r = 0; r < rows; r++) {
            centers[r] = r * config.analysisHop;
            outCenters[r] = r * config.synthesisHop;
        }
        const spectrum = R.analyze(signal, config.windowSize, config.fftSize, centers);
        const bins = spectrum.bins;
        const peak = (() => {
            let value = 0;
            for (let i = 0; i < spectrum.magnitude.length; i++) {
                if (spectrum.magnitude[i] > value) value = spectrum.magnitude[i];
            }
            return value;
        })();
        const edges = {
            centered: R.phaseEdges(spectrum.phase, rows, bins, config, true),
            direct: R.phaseEdges(spectrum.phase, rows, bins, config, false),
        };
        const loops = {
            centered: R.measureLoops(spectrum.magnitude, edges.centered, rows, bins, config.tolerance),
            direct: R.measureLoops(spectrum.magnitude, edges.direct, rows, bins, config.tolerance),
        };
        return {
            config, input, signal, rate, duration: input.duration, rows, bins, length,
            centers, outCenters, spectrum, peak, edges, loops,
            plotSamples: rows * config.synthesisHop,
        };
    }

    function resolveOnsets(ctx, detected) {
        const mode = ctx.config.anchorMode;
        if (mode === 'none') return [];
        if (mode === 'detected') return detected || [];
        if (ctx.input.isFile) return detected || [];
        return ctx.input.onsets;
    }

    function fillPhase(phase, analysisPhase) {
        // Same strategy as experiment.py: unvisited bins keep a fixed-seed
        // random phase. (The lab uses PCG64(0); the sequences differ here.)
        const filled = new Float64Array(phase.length);
        const random = R.rng(0x6a09e667);
        for (let i = 0; i < phase.length; i++) {
            filled[i] = Number.isFinite(phase[i]) ? phase[i] : random() * TAU - Math.PI;
        }
        void analysisPhase;
        return filled;
    }

    function buildRecord(ctx, result, kind, meta) {
        const filled = fillPhase(result.phase, ctx.spectrum.phase);
        const output = R.wola(ctx.spectrum.magnitude, filled, ctx.config, ctx.length);
        const observed = R.analyze(output, ctx.config.windowSize, ctx.config.fftSize, ctx.outCenters);
        const residual = R.stftResidual(observed, ctx.spectrum.magnitude, filled, ctx.rows, ctx.bins);
        const metrics = ctx.onsets.map((onset) => R.transientMetrics(
            output, onset, ctx.config.ratio, ctx.config.windowSize, ctx.duration, ctx.rate));
        const coverage = meta.coverage !== undefined ? meta.coverage
            : kind === 'local' ? result.coverage
                : kind === 'grid' ? countFinite(result.phase)
                    : result.visitCount + meta.anchorBins;
        return {
            ...result,
            ...meta,
            kind,
            filled,
            output,
            residual,
            metrics,
            coverage,
        };
    }

    /**
     * Local forward/bidirectional propagation, mirroring experiment.py:
     * the propagated bins become fixed phases for the per-frame causal fill.
     * Visit order = local propagation first, then the causal fill.
     */
    function combineLocal(ctx, propagation, scheme) {
        const combined = R.causalGrid(ctx.spectrum.magnitude, ctx.spectrum.phase,
            ctx.edges[scheme], propagation.phase, ctx.rows, ctx.bins, ctx.config.tolerance, 0);
        const total = ctx.rows * ctx.bins;
        const order = new Int32Array(total).fill(-1);
        const parent = new Int32Array(total).fill(-1);
        const propagationVisits = propagation.visitCount;
        const visitCells = new Int32Array(propagationVisits + combined.visitCount);
        let coverage = 0;
        for (let i = 0; i < total; i++) {
            if (Number.isFinite(propagation.phase[i])) coverage++;
        }
        for (let n = 0; n < propagationVisits; n++) {
            const index = propagation.visitCells[n];
            visitCells[n] = index;
            order[index] = n;
            parent[index] = propagation.parent[index];
        }
        let count = propagationVisits;
        for (let n = 0; n < combined.visitCount; n++) {
            const index = combined.visitCells[n];
            if (order[index] >= 0) continue;
            order[index] = count;
            parent[index] = combined.parent[index];
            visitCells[count++] = index;
        }
        return {
            phase: combined.phase,
            order,
            parent,
            visitCells: visitCells.subarray(0, count),
            visitCount: count,
            propagationVisits,
            coverage,
            rowStarts: combined.rowStarts,
            weakSeeds: combined.weakSeeds,
            seedCount: 0,
            strength: propagation.strength,
            distance: propagation.distance,
        };
    }

    async function computeAll() {
        if (state.busy) return;
        if (state.audio.source) stopAudio();
        state.play.active = false;
        $('playBtn').textContent = '播放流程';
        setStatus('计算中…', '');
        setBusy(true, '准备输入…');
        try {
            progress(0.04, '生成信号…');
            await tick();
            const config = readConfig();
            if (!(config.ratio > 0)) throw new Error('拉伸率无效');

            const input = resolveInput(config);
            const ctx = buildGridContext(config, input);
            progress(0.18, '分析 STFT 完成，计算相位差分…');
            await tick();

            let detected = null;
            if (config.anchorMode === 'detected' || (input.isFile && config.anchorMode !== 'none')) {
                detected = R.detectOnsets(ctx.signal, ctx.rate);
                if (input.isFile && !detected.length) {
                    let peakIndex = 0;
                    let peakValue = 0;
                    for (let i = 0; i < ctx.signal.length; i++) {
                        const value = Math.abs(ctx.signal[i]);
                        if (value > peakValue) { peakValue = value; peakIndex = i; }
                    }
                    detected = [peakIndex];
                }
            }
            ctx.detected = detected;
            ctx.onsets = resolveOnsets(ctx, detected);
            progress(0.3, '计算瞬态锚点…');
            await tick();

            ctx.anchors = R.phaseAnchors(ctx.signal, ctx.spectrum, ctx.config, ctx.onsets, ctx.rate, config.tolerance);
            ctx.anchorBins = countFinite(ctx.anchors);
            ctx.anchorRows = [];
            for (let r = 0; r < ctx.rows; r++) {
                let has = false;
                for (let k = 0; k < ctx.bins; k++) {
                    if (Number.isFinite(ctx.anchors[r * ctx.bins + k])) { has = true; break; }
                }
                if (has) ctx.anchorRows.push(r);
            }

            const emptyAnchors = new Float64Array(ctx.rows * ctx.bins).fill(NaN);
            const edgeForMethod = ctx.edges[config.edgeScheme];
            const records = {};

            progress(0.4, '逐帧 direct 基线…');
            await tick();
            records.direct = buildRecord(ctx,
                R.causalGrid(ctx.spectrum.magnitude, ctx.spectrum.phase, ctx.edges.direct, emptyAnchors,
                    ctx.rows, ctx.bins, config.tolerance),
                'causal', { label: '逐帧 direct', scheme: 'direct', anchorBins: 0, method: 'causal-direct' });

            progress(0.5, '逐帧 centered 基线…');
            await tick();
            records.centered = buildRecord(ctx,
                R.causalGrid(ctx.spectrum.magnitude, ctx.spectrum.phase, ctx.edges.centered, emptyAnchors,
                    ctx.rows, ctx.bins, config.tolerance),
                'causal', { label: '逐帧 centered', scheme: 'centered', anchorBins: 0, method: 'causal-centered' });

            progress(0.6, '锚点重置传播…');
            await tick();
            records.reset = buildRecord(ctx,
                R.causalGrid(ctx.spectrum.magnitude, ctx.spectrum.phase, edgeForMethod, ctx.anchors,
                    ctx.rows, ctx.bins, config.tolerance),
                'causal', { label: '逐帧 + 锚点重置', scheme: config.edgeScheme, anchorBins: ctx.anchorBins, method: 'reset' });

            progress(0.7, '局部前向传播…');
            await tick();
            const forwardProp = R.propagate(ctx.spectrum.magnitude, ctx.spectrum.phase, edgeForMethod,
                ctx.anchors, ctx.rows, ctx.bins, config.radius, config.tolerance, false);
            records.forward = buildRecord(ctx, combineLocal(ctx, forwardProp, config.edgeScheme),
                'local', { label: '局部前向', scheme: config.edgeScheme, anchorBins: ctx.anchorBins, method: 'forward' });

            progress(0.8, '局部双向传播…');
            await tick();
            const bidirectionalProp = R.propagate(ctx.spectrum.magnitude, ctx.spectrum.phase, edgeForMethod,
                ctx.anchors, ctx.rows, ctx.bins, config.radius, config.tolerance, true);
            records.bidirectional = buildRecord(ctx, combineLocal(ctx, bidirectionalProp, config.edgeScheme),
                'local', { label: '局部双向', scheme: config.edgeScheme, anchorBins: ctx.anchorBins, method: 'bidirectional' });

            const key = methodRecordKey(config.method);
            if (key === 'global' || key === 'global-magnitude') {
                progress(0.88, '全 STFT 堆积分…');
                await tick();
                records[key] = buildGlobalRecord(ctx, key);
            }

            const data = {
                ...ctx,
                records,
                selectedKey: records[key] ? key : 'bidirectional',
                runId: (state.runId = (state.runId || 0) + 1),
            };
            finishData(data);
            progress(1, '完成');
            $('runNote').textContent = `已计算 · ${data.input.name}`;
            state.dirty = false;
            setStatus(`就绪 · ${data.input.name} · ${data.rows} 帧 × ${data.bins} bins`, 'on');
        } catch (error) {
            console.error(error);
            setStatus(`计算失败：${error && error.message ? error.message : error}`, 'err');
        } finally {
            state.busy = false;
            $('runBtn').disabled = false;
            $('playBtn').disabled = false;
            $('busyTrack').style.display = 'none';
        }
    }

    function buildGlobalRecord(ctx, key) {
        const result = R.propagateGlobal(ctx.spectrum.magnitude, ctx.spectrum.phase,
            ctx.edges[ctx.config.edgeScheme], ctx.anchors, ctx.rows, ctx.bins,
            ctx.config.tolerance, key === 'global');
        return buildRecord(ctx, result, 'grid', {
            label: key === 'global' ? '全 STFT 堆 · 路径最弱' : '全 STFT 堆 · 幅度优先',
            scheme: ctx.config.edgeScheme,
            anchorBins: ctx.anchorBins,
            method: key,
        });
    }

    function finishData(data) {
        state.data = data;
        state.play.active = false;
        state.play.t = TOTAL_MS;
        state.hover = null;
        state.selected = null;
        state.focus = null;

        const focus = chooseFocus(data);
        state.focus = focus;
        state.selected = { ...focus };
        state.images = buildImages(data);
        state.overlay.key = '';
        buildTable(data);
        renderStats(data);
        updateDataLabels(data);
        $('playInBtn').disabled = false;
        $('playOutBtn').disabled = false;
        $('stopAudioBtn').disabled = false;
        draw();
    }

    function chooseFocus(data) {
        const binHz = data.rate / data.config.fftSize;
        const maxBin = Math.max(1, Math.min(data.bins - 1,
            Math.round(Math.min(data.rate / 2, DISPLAY_HZ) / binHz)));
        let row = 1;
        let bin = Math.min(maxBin, Math.floor(data.bins / 4));
        if (data.anchorRows.length) {
            row = data.anchorRows[0];
            let best = -1;
            for (let k = 0; k <= maxBin; k++) {
                const index = row * data.bins + k;
                if (!Number.isFinite(data.anchors[index])) continue;
                if (data.spectrum.magnitude[index] > best) {
                    best = data.spectrum.magnitude[index];
                    bin = k;
                }
            }
            if (best < 0) bin = Math.min(maxBin, Math.floor(data.bins / 4));
        } else {
            let best = -1;
            for (let r = 1; r < data.rows; r++) {
                for (let k = 1; k <= maxBin; k++) {
                    const m = data.spectrum.magnitude[r * data.bins + k];
                    if (m > best) { best = m; row = r; bin = k; }
                }
            }
        }
        const half = data.rows >= 15 ? 7 : Math.max(1, (data.rows - 1) >> 1);
        row = clamp(row, half, data.rows - 1 - half);
        return { row, bin: clamp(bin, 0, maxBin) };
    }

    /* ------------------------------------------------------------------ */
    /* images                                                              */
    /* ------------------------------------------------------------------ */

    function buildImages(data) {
        const { rows, bins, spectrum, rate, fftSize } = data;
        const nyquist = rate / 2;
        const dispHz = Math.min(nyquist, DISPLAY_HZ);
        const dispBins = Math.max(16, Math.min(bins, Math.round(dispHz / nyquist * (bins - 1)) + 1));

        // dispBins is the bin count up to dispHz, so display index b is bin b.
        const base = new ImageData(rows, dispBins);
        for (let b = 0; b < dispBins; b++) {
            const k = b;
            const y = dispBins - 1 - b;
            for (let r = 0; r < rows; r++) {
                const m = spectrum.magnitude[r * bins + k];
                const t = Math.pow(magT(m, data.peak), 0.85);
                const lut = Math.min(255, Math.round(t * 255)) * 3;
                const o = (y * rows + r) * 4;
                base.data[o] = MAG_LUT[lut];
                base.data[o + 1] = MAG_LUT[lut + 1];
                base.data[o + 2] = MAG_LUT[lut + 2];
                base.data[o + 3] = 255;
            }
        }
        const baseCanvas = document.createElement('canvas');
        baseCanvas.width = rows;
        baseCanvas.height = dispBins;
        baseCanvas.getContext('2d').putImageData(base, 0, 0);

        if (!state.overlay.canvas || state.overlay.canvas.width !== rows || state.overlay.canvas.height !== dispBins) {
            const overlayCanvas = document.createElement('canvas');
            overlayCanvas.width = rows;
            overlayCanvas.height = dispBins;
            state.overlay.canvas = overlayCanvas;
            state.overlay.ctx = overlayCanvas.getContext('2d');
            state.overlay.image = state.overlay.ctx.createImageData(rows, dispBins);
            state.overlay.key = '';
        }
        return { dispBins, dispHz, baseCanvas };
    }

    /* ------------------------------------------------------------------ */
    /* table / stats                                                       */
    /* ------------------------------------------------------------------ */

    function renderStats(data) {
        const rec = data.records[data.selectedKey];
        const scheme = data.config.edgeScheme;
        const loop = data.loops[scheme];
        const anchorRows = data.anchorRows.length;
        const weak = rec && rec.weakSeeds
            ? Array.from(rec.weakSeeds).reduce((a, b) => a + b, 0)
            : null;
        const items = [
            ['拉伸率 α', `${data.config.ratio.toFixed(4)}×`],
            ['分析 / 合成 hop', `${data.config.analysisHop} / ${data.config.synthesisHop}`],
            ['STFT 网格', `${data.rows} × ${data.bins}`],
            ['锚点', anchorRows ? `${data.anchorBins} bin / ${anchorRows} 帧` : '无'],
            ['小格闭环 RMS', loop.rms === null ? '—' : `${loop.rms.toExponential(2)} rad`],
            ['弱旧帧入口', weak === null ? '—' : String(weak)],
            ['当前方法覆盖', rec ? `${rec.coverage} bin` : '—'],
            ['STFT 残差', rec ? rec.residual.toFixed(3) : '—'],
        ];
        $('stats').innerHTML = items.map(([name, value]) =>
            `<div class="stat-card"><span>${name}</span><b>${value}</b></div>`).join('');
        $('loopInfo').textContent =
            `centered ${loopValue(data.loops.centered)}，direct ${loopValue(data.loops.direct)}`;
    }

    function loopValue(loop) {
        return loop.rms === null ? '—' : `${loop.rms.toExponential(2)} rad`;
    }

    function buildTable(data) {
        const rows = [
            { key: 'direct', label: '逐帧 direct', scheme: 'direct', note: '无锚点 · 直接边' },
            { key: 'centered', label: '逐帧 centered', scheme: 'centered', note: '无锚点 · 中心差分' },
            { key: 'reset', label: '逐帧 + 锚点重置', scheme: data.config.edgeScheme, note: `锚点 ${data.anchorBins} bin` },
            { key: 'forward', label: '局部前向', scheme: data.config.edgeScheme, note: `±${data.config.radius} 帧` },
            { key: 'bidirectional', label: '局部双向', scheme: data.config.edgeScheme, note: `±${data.config.radius} 帧` },
        ];
        if (data.records.global) {
            rows.push({ key: 'global', label: '全 STFT 堆 · 路径最弱', scheme: data.config.edgeScheme, note: '锚点 + 全网格' });
        }
        if (data.records['global-magnitude']) {
            rows.push({ key: 'global-magnitude', label: '全 STFT 堆 · 幅度优先', scheme: data.config.edgeScheme, note: '锚点 + 全网格' });
        }

        $('metricBody').innerHTML = rows.map((row) => {
            const record = data.records[row.key];
            if (!record) return '';
            const metric = record.metrics[0];
            const pre = metric ? dbLabel(metric.preDb) : '—';
            const post = metric ? dbLabel(metric.postDb) : '—';
            const offset = metric ? `${metric.peakOffset > 0 ? '+' : ''}${metric.peakOffset}` : '—';
            const selected = row.key === data.selectedKey ? ' class="selected"' : '';
            const note = row.key === 'reset'
                ? `弱入口 ${record.weakSeeds ? Array.from(record.weakSeeds).reduce((a, b) => a + b, 0) : 0}`
                : row.key === 'direct' || row.key === 'centered'
                    ? '无锚点'
                    : row.key === 'forward' || row.key === 'bidirectional'
                        ? `覆盖 ${record.coverage} bin`
                        : `种子 ${record.seedCount ?? 0} · 覆盖 ${record.coverage} bin`;
            return `<tr${selected}>` +
                `<td>${row.label}</td><td>${row.scheme}</td>` +
                `<td>${pre}</td><td>${post}</td><td>${offset}</td>` +
                `<td>${record.residual.toFixed(3)}</td><td>${note}</td></tr>`;
        }).join('');
    }

    /* ------------------------------------------------------------------ */
    /* labels                                                              */
    /* ------------------------------------------------------------------ */

    function updateDataLabels(data) {
        const inSeconds = data.signal.length / data.rate;
        const outSeconds = data.length / data.rate;
        const first = data.onsets.length ? data.onsets[0] : null;
        $('waveInfo').textContent = first === null
            ? `输入 ${inSeconds.toFixed(2)} s · 输出 ${outSeconds.toFixed(2)} s`
            : `输入 ${inSeconds.toFixed(2)} s · 输出 ${outSeconds.toFixed(2)} s · 起音 ${first} → ${Math.round(first * data.config.ratio)}`;
        $('tfInfo').textContent =
            `${data.rows} 帧 × ${data.bins} bins · 显示 0–${(state.images.dispHz / 1000).toFixed(0)} kHz`;
        if (data.anchorRows.length) {
            $('zoomInfo').textContent =
                `锚点帧 ${data.anchorRows[0]} (${(data.anchorRows[0] * data.config.synthesisHop / data.rate * 1000).toFixed(1)} ms)`;
        } else {
            $('zoomInfo').textContent = '无锚点';
        }
    }

    /* ------------------------------------------------------------------ */
    /* animation state                                                     */
    /* ------------------------------------------------------------------ */

    function stageAt(t) {
        let start = 0;
        for (let i = 0; i < STAGES.length; i++) {
            const end = start + STAGES[i].dur;
            if (t < end || i === STAGES.length - 1) {
                return { index: i, p: clamp((t - start) / STAGES[i].dur, 0, 1) };
            }
            start = end;
        }
        return { index: STAGES.length - 1, p: 1 };
    }

    function revealInfo() {
        const info = stageAt(state.play.t);
        let count = 0;
        if (state.data) {
            const rec = state.data.records[state.data.selectedKey];
            if (info.index >= 3) {
                count = info.index > 3 ? rec.visitCount : Math.floor(info.p * rec.visitCount);
            }
        }
        return { ...info, count };
    }

    function setStage(index, autoplay) {
        if (!state.data) return;
        let start = 0;
        for (let i = 0; i < index; i++) start += STAGES[i].dur;
        state.play.t = index === 4 ? TOTAL_MS : start;
        state.play.active = false;
        draw();
        if (autoplay && index < 4) {
            startPlay(start);
        }
    }

    function startPlay(fromTime = 0) {
        if (!state.data) return;
        state.play.t = clamp(fromTime, 0, TOTAL_MS);
        state.play.active = true;
        state.play.last = performance.now();
        $('playBtn').textContent = '暂停流程';
        requestAnimationFrame(stepPlay);
    }

    function stepPlay(now) {
        if (!state.play.active) return;
        const dt = Math.min(80, now - state.play.last);
        state.play.last = now;
        state.play.t += dt * state.play.speed;
        if (state.play.t >= TOTAL_MS) {
            state.play.t = TOTAL_MS;
            state.play.active = false;
            $('playBtn').textContent = '播放流程';
        }
        draw();
        if (state.play.active) requestAnimationFrame(stepPlay);
    }

    function togglePlay() {
        if (!state.data) {
            computeAll().then(() => { startPlay(); });
            return;
        }
        if (state.play.active) {
            state.play.active = false;
            $('playBtn').textContent = '播放流程';
            return;
        }
        startPlay(state.play.t >= TOTAL_MS - 1 ? 0 : state.play.t);
    }

    /* ------------------------------------------------------------------ */
    /* rendering: waveform                                                 */
    /* ------------------------------------------------------------------ */

    function drawWave() {
        const { ctx, width, height } = fitCanvas($('waveCanvas'));
        ctx.clearRect(0, 0, width, height);
        const left = 46;
        const right = 12;
        const top = 16;
        const bottom = 22;
        const gap = 14;
        const laneH = Math.max(30, (height - top - bottom - gap) / 2);
        const plotW = width - left - right;
        const plotSamples = state.data ? state.data.plotSamples : 1;

        ctx.font = '11px Consolas, monospace';
        ctx.fillStyle = '#0b0f14';
        ctx.fillRect(0, 0, width, height);

        const lanes = [
            { y: top, label: '输入 x[n]', color: '#6fa8d8' },
            { y: top + laneH + gap, label: '输出 y[n]', color: '#ffb066' },
        ];
        for (let i = 0; i < 2; i++) {
            const lane = lanes[i];
            ctx.fillStyle = '#0e141b';
            ctx.fillRect(left, lane.y, plotW, laneH);
            ctx.strokeStyle = '#1d2732';
            ctx.beginPath();
            ctx.moveTo(left, lane.y + laneH / 2);
            ctx.lineTo(left + plotW, lane.y + laneH / 2);
            ctx.stroke();
            ctx.fillStyle = lane.color;
            ctx.fillRect(left, lane.y, 2, laneH);
            text(ctx, lane.label, 6, lane.y + laneH / 2, lane.color, 'left', 'middle');
        }

        if (!state.data) {
            text(ctx, '计算中…', width / 2, height / 2, '#8a9aa8', 'center', 'middle');
            return;
        }

        const data = state.data;
        const info = revealInfo();
        const maxTime = plotSamples / data.rate;
        const xOfSample = (s) => left + (s / plotSamples) * plotW;

        // input onsets (behind the waveform so a one-sample impulse stays visible)
        ctx.setLineDash([3, 3]);
        for (const onset of data.onsets) {
            const x = xOfSample(onset);
            ctx.strokeStyle = 'rgba(120, 210, 255, 0.55)';
            ctx.beginPath();
            ctx.moveTo(x, lanes[0].y);
            ctx.lineTo(x, lanes[0].y + laneH);
            ctx.stroke();
        }
        ctx.setLineDash([]);

        // input lane
        const inputEndX = Math.min(left + plotW, xOfSample(data.signal.length));
        if (inputEndX > left) {
            const cols = Math.round(inputEndX - left);
            const mid = lanes[0].y + laneH / 2;
            const scale = laneH * 0.44;
            ctx.fillStyle = '#6fa8d8';
            for (let c = 0; c < cols; c++) {
                const t0 = c / plotW * maxTime;
                const t1 = (c + 1) / plotW * maxTime;
                const s0 = Math.max(0, Math.floor(t0 * data.rate));
                const s1 = Math.min(data.signal.length, Math.max(s0 + 1, Math.ceil(t1 * data.rate)));
                let lo = 0;
                let hi = 0;
                for (let s = s0; s < s1; s++) {
                    const v = data.signal[s];
                    if (v < lo) lo = v;
                    if (v > hi) hi = v;
                }
                const y0 = mid - hi * scale;
                const y1 = mid - lo * scale;
                ctx.fillRect(left + c, y0, 1.5, Math.max(1, y1 - y0));
            }
        }

        // target onset and pre-ringing region
        if (data.onsets.length) {
            const onset = data.onsets[0];
            const target = Math.min(data.length - 1, Math.round(onset * data.config.ratio));
            const halfWindow = data.config.windowSize / 2;
            const preLeft = clamp(target - halfWindow, 0, plotSamples);
            const preRight = clamp(target, 0, plotSamples);
            const x0 = xOfSample(preLeft);
            const x1 = xOfSample(preRight);
            if (x1 > x0) {
                ctx.fillStyle = 'rgba(210, 90, 90, 0.16)';
                ctx.fillRect(x0, lanes[1].y, x1 - x0, laneH);
                ctx.strokeStyle = 'rgba(235, 120, 120, 0.55)';
                ctx.setLineDash([2, 2]);
                ctx.strokeRect(x0 + 0.5, lanes[1].y + 0.5, Math.max(1, x1 - x0 - 1), laneH - 1);
                ctx.setLineDash([]);
                text(ctx, '前振铃区', (x0 + x1) / 2, lanes[1].y + 10, 'rgba(245, 160, 160, 0.9)', 'center');
            }
            const xTarget = xOfSample(target);
            ctx.strokeStyle = 'rgba(255, 190, 120, 0.8)';
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(xTarget, lanes[1].y);
            ctx.lineTo(xTarget, lanes[1].y + laneH);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // output lane
        const outMid = lanes[1].y + laneH / 2;
        const outScale = laneH * 0.44;
        const outCols = Math.round(plotW);
        const revealX = info.index >= 4 ? left + plotW * info.p : left;
        const drawEnvelope = (xStart, xEnd, alpha) => {
            ctx.globalAlpha = alpha;
            ctx.fillStyle = '#ffb066';
            const from = Math.max(0, Math.round(xStart - left));
            const to = Math.min(outCols, Math.round(xEnd - left));
            for (let c = from; c < to; c++) {
                const t0 = c / plotW * maxTime;
                const t1 = (c + 1) / plotW * maxTime;
                const s0 = Math.max(0, Math.floor(t0 * data.rate));
                const s1 = Math.min(data.length, Math.max(s0 + 1, Math.ceil(t1 * data.rate)));
                let lo = 0;
                let hi = 0;
                for (let s = s0; s < s1; s++) {
                    const v = data.records[data.selectedKey].output[s];
                    if (v < lo) lo = v;
                    if (v > hi) hi = v;
                }
                const y0 = outMid - hi * outScale;
                const y1 = outMid - lo * outScale;
                ctx.fillRect(left + c, y0, 1.5, Math.max(1, y1 - y0));
            }
            ctx.globalAlpha = 1;
        };
        drawEnvelope(left, left + plotW, 0.24);
        if (revealX > left) drawEnvelope(left, revealX, 0.95);


        // analysis frame during the analyse stage
        if (info.index === 0) {
            const row = Math.round(info.p * (data.rows - 1));
            const center = row * data.config.analysisHop;
            const x0 = xOfSample(Math.max(0, center - data.config.windowSize / 2));
            const x1 = xOfSample(Math.min(data.plotSamples, center + data.config.windowSize / 2));
            ctx.fillStyle = 'rgba(150, 210, 255, 0.12)';
            ctx.fillRect(x0, lanes[0].y, x1 - x0, laneH);
            ctx.strokeStyle = 'rgba(160, 220, 255, 0.7)';
            ctx.strokeRect(x0 + 0.5, lanes[0].y + 0.5, Math.max(1, x1 - x0 - 1), laneH - 1);
            ctx.beginPath();
            const steps = 48;
            for (let i = 0; i <= steps; i++) {
                const u = i / steps;
                const x = x0 + u * (x1 - x0);
                const w = 0.5 - 0.5 * Math.cos(TAU * u);
                const y = lanes[0].y + laneH - 4 - w * (laneH * 0.26);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = 'rgba(160, 220, 255, 0.45)';
            ctx.stroke();
            text(ctx, `第 ${row} 帧 · ha=${data.config.analysisHop}`, x0 + 3, lanes[0].y + 11, 'rgba(200, 230, 250, 0.9)');
        }

        // time axis
        const step = chooseStep(maxTime, 6);
        ctx.strokeStyle = '#2b3540';
        for (let t = 0; t <= maxTime + 1e-9; t += step) {
            const x = left + (t / maxTime) * plotW;
            ctx.beginPath();
            ctx.moveTo(x, lanes[1].y + laneH);
            ctx.lineTo(x, lanes[1].y + laneH + 4);
            ctx.stroke();
            text(ctx, `${(t * 1000).toFixed(0)}`, x, height - 7, '#7d8d9c', 'center');
        }
        text(ctx, '时间 / ms', width - right, height - 7, '#556774', 'right');

        // optional audio cursor
        if (state.audio.source && state.audio.ctx) {
            const elapsed = state.audio.ctx.currentTime - state.audio.start;
            if (elapsed >= 0 && elapsed <= maxTime) {
                const x = left + (elapsed / maxTime) * plotW;
                const lane = state.audio.which === 'in' ? lanes[0] : lanes[1];
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
                ctx.beginPath();
                ctx.moveTo(x, lane.y);
                ctx.lineTo(x, lane.y + laneH);
                ctx.stroke();
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* rendering: time-frequency plane                                     */
    /* ------------------------------------------------------------------ */

    function tfLayout(width, height) {
        const plot = { x: 46, y: 8, w: Math.max(10, width - 58), h: Math.max(10, height - 34) };
        return { plot };
    }

    function cellKnown(record, index, row, anchors) {
        if (Number.isFinite(anchors[index])) return true;
        if (record.kind === 'causal') {
            if (row === 0) return true;
            return record.order[index] >= 0;
        }
        return Number.isFinite(record.phase[index]);
    }

    function rebuildOverlay(data, info) {
        const { rows, bins, spectrum, anchors, records, selectedKey } = data;
        const record = records[selectedKey];
        const dispBins = state.images.dispBins;
        const image = state.overlay.image;
        image.data.fill(0);
        const stage = info.index;
        const analysisMode = stage >= 1 && stage <= 2;
        const count = info.count;
        const threshold = 1e-4 * data.peak;

        for (let r = 0; r < rows; r++) {
            for (let b = 0; b < dispBins; b++) {
                const k = b;
                const index = r * bins + k;
                const magnitude = spectrum.magnitude[index];
                if (magnitude < threshold) continue;

                let phase = null;
                let alpha = 0;
                if (analysisMode) {
                    phase = spectrum.phase[index];
                    alpha = magnitude > 0.02 * data.peak ? 148 : 64;
                } else if (stage >= 3) {
                    if (record.order[index] >= 0 ? record.order[index] < count : Number.isFinite(anchors[index])) {
                        if (cellKnown(record, index, r, anchors)) {
                            phase = record.phase[index];
                            alpha = 218;
                        }
                    }
                }
                if (phase === null) continue;
                const hue = ((phase + Math.PI) / TAU) % 1;
                const lut = Math.floor(hue * 359) * 3;
                const y = dispBins - 1 - b;
                const o = (y * rows + r) * 4;
                image.data[o] = PHASE_LUT[lut];
                image.data[o + 1] = PHASE_LUT[lut + 1];
                image.data[o + 2] = PHASE_LUT[lut + 2];
                image.data[o + 3] = alpha;
            }
        }
        state.overlay.ctx.putImageData(image, 0, 0);
    }

    function drawTF() {
        const { ctx, width, height } = fitCanvas($('tfCanvas'));
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#0b0f14';
        ctx.fillRect(0, 0, width, height);

        if (!state.data || !state.images) {
            text(ctx, '计算中…', width / 2, height / 2, '#8a9aa8', 'center', 'middle');
            return;
        }

        const data = state.data;
        const images = state.images;
        const info = revealInfo();
        const { plot } = tfLayout(width, height);
        const rec = data.records[data.selectedKey];

        // background frame
        ctx.fillStyle = '#111820';
        ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

        // base magnitude image (clipped during the analysis stage)
        ctx.imageSmoothingEnabled = true;
        const baseWidth = info.index === 0 ? plot.w * info.p : plot.w;
        if (baseWidth > 0.5) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(plot.x, plot.y, baseWidth, plot.h);
            ctx.clip();
            ctx.drawImage(images.baseCanvas, 0, 0, data.rows, images.dispBins,
                plot.x, plot.y, plot.w, plot.h);
            ctx.restore();
        }
        if (info.index === 0 && baseWidth < plot.w - 0.5) {
            ctx.strokeStyle = 'rgba(150, 210, 255, 0.65)';
            ctx.beginPath();
            ctx.moveTo(plot.x + baseWidth, plot.y);
            ctx.lineTo(plot.x + baseWidth, plot.y + plot.h);
            ctx.stroke();
        }

        // phase overlay
        if (info.index >= 1) {
            const key = `${data.runId}-${info.index}-${info.count}-${data.selectedKey}`;
            if (state.overlay.key !== key) {
                rebuildOverlay(data, info);
                state.overlay.key = key;
            }
            ctx.save();
            ctx.beginPath();
            ctx.rect(plot.x, plot.y, plot.w, plot.h);
            ctx.clip();
            ctx.imageSmoothingEnabled = false;
            ctx.globalAlpha = info.index === 1 || info.index === 2 ? 0.9 : 1;
            ctx.drawImage(state.overlay.canvas, 0, 0, data.rows, images.dispBins,
                plot.x, plot.y, plot.w, plot.h);
            ctx.globalAlpha = 1;
            ctx.restore();
            ctx.imageSmoothingEnabled = true;
        }

        const xOfRow = (row) => plot.x + (row / data.rows) * plot.w;
        const yOfBin = (bin) => plot.y + (1 - bin / Math.max(1, images.dispBins - 1)) * plot.h;

        // anchor bins
        if (data.anchorBins && info.index >= 2) {
            ctx.setLineDash([2, 3]);
            ctx.strokeStyle = 'rgba(56, 225, 208, 0.6)';
            for (const r of data.anchorRows) {
                const x = xOfRow(r + 0.5);
                ctx.beginPath();
                ctx.moveTo(x, plot.y);
                ctx.lineTo(x, plot.y + plot.h);
                ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(56, 225, 208, 0.72)';
            for (let r = 0; r < data.rows; r++) {
                for (let k = 0; k < Math.min(data.bins, images.dispBins); k++) {
                    if (!Number.isFinite(data.anchors[r * data.bins + k])) continue;
                    ctx.fillRect(xOfRow(r + 0.5), yOfBin(k) - 1, 1.6, 2);
                }
            }
        }

        // target onset line
        if (data.onsets.length) {
            const target = Math.round(data.onsets[0] * data.config.ratio);
            const x = plot.x + (target / data.plotSamples) * plot.w;
            ctx.strokeStyle = 'rgba(255, 170, 120, 0.55)';
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(x, plot.y);
            ctx.lineTo(x, plot.y + plot.h);
            ctx.stroke();
            ctx.setLineDash([]);
            text(ctx, 'target', x + 3, plot.y + 11, 'rgba(255, 190, 140, 0.8)');
        }

        // current integration marker / frontier
        if (info.index === 3) {
            if (rec.kind === 'causal' || rec.kind === 'local') {
                const offset = rec.kind === 'local' ? rec.propagationVisits : 0;
                if (info.count > offset) {
                    let lo = 1;
                    let hi = data.rows;
                    while (lo < hi) {
                        const mid = (lo + hi) >> 1;
                        if (rec.rowStarts[mid] + offset <= info.count) lo = mid + 1;
                        else hi = mid;
                    }
                    const row = clamp(lo - 1, 1, data.rows - 1);
                    const x = xOfRow(row + 0.5);
                    ctx.strokeStyle = 'rgba(255, 211, 77, 0.45)';
                    ctx.beginPath();
                    ctx.moveTo(x, plot.y);
                    ctx.lineTo(x, plot.y + plot.h);
                    ctx.stroke();
                }
            }
            if (info.count > 0) {
                const styles = [];
                for (let n = Math.max(0, info.count - 18); n < info.count; n++) styles.push(rec.visitCells[n]);
                for (const index of styles) {
                    const row = Math.floor(index / data.bins);
                    const bin = index - row * data.bins;
                    if (bin >= images.dispBins) continue;
                    ctx.fillStyle = 'rgba(255, 211, 77, 0.7)';
                    ctx.fillRect(xOfRow(row + 0.5) - 1, yOfBin(bin) - 1, 2, 2);
                }
                const last = rec.visitCells[info.count - 1];
                const row = Math.floor(last / data.bins);
                const bin = last - row * data.bins;
                if (bin < images.dispBins) {
                    ctx.strokeStyle = '#ffd34d';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(xOfRow(row + 0.5), yOfBin(bin), 5, 0, TAU);
                    ctx.stroke();
                    ctx.lineWidth = 1;
                }
            }
        }

        // selected / hovered markers
        const mark = state.hover || state.selected;
        const drawMarker = (cell, color, style) => {
            if (!cell) return;
            const x = xOfRow(cell.row + 0.5);
            const y = yOfBin(cell.bin);
            if (x < plot.x || x > plot.x + plot.w || y < plot.y || y > plot.y + plot.h) return;
            ctx.strokeStyle = color;
            ctx.setLineDash(style);
            ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
            ctx.setLineDash([]);
        };
        drawMarker(state.selected, 'rgba(255,255,255,0.9)', []);
        if (state.hover && (!state.selected || state.hover.row !== state.selected.row || state.hover.bin !== state.selected.bin)) {
            drawMarker(state.hover, 'rgba(255,255,255,0.45)', [2, 2]);
        }

        // axes
        ctx.font = '10px Consolas, monospace';
        const freqMax = Math.min(data.rate / 2, DISPLAY_HZ);
        const freqStep = chooseStep(freqMax, 4);
        for (let f = 0; f <= freqMax + 1e-9; f += freqStep) {
            const y = plot.y + (1 - f / freqMax) * plot.h;
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            ctx.beginPath();
            ctx.moveTo(plot.x, y);
            ctx.lineTo(plot.x + plot.w, y);
            ctx.stroke();
            text(ctx, `${(f / 1000).toFixed(1)}k`, plot.x - 6, y + 3, '#7d8d9c', 'right');
        }
        const totalTime = data.plotSamples / data.rate;
        const timeStep = chooseStep(totalTime, 6);
        for (let tms = 0; tms <= totalTime * 1000 + 1e-9; tms += timeStep * 1000) {
            const x = plot.x + (tms / (totalTime * 1000)) * plot.w;
            ctx.strokeStyle = 'rgba(255,255,255,0.06)';
            ctx.beginPath();
            ctx.moveTo(x, plot.y);
            ctx.lineTo(x, plot.y + plot.h);
            ctx.stroke();
            text(ctx, `${(tms / 1000).toFixed(2)}s`, x, plot.y + plot.h + 14, '#7d8d9c', 'center');
        }
        text(ctx, '频率', 6, plot.y + 10, '#5d6f7e');
        text(ctx, '合成时间', plot.x + plot.w, plot.y + plot.h + 27, '#5d6f7e', 'right');
    }

    /* ------------------------------------------------------------------ */
    /* rendering: zoom lattice                                             */
    /* ------------------------------------------------------------------ */

    function zoomLayout(width, height, focus) {
        const data = state.data;
        if (!data) return null;
        const plot = { x: 66, y: 30, w: Math.max(20, width - 80), h: Math.max(20, height - 58) };
        const rowsWanted = 15;
        const colsWanted = clamp(Math.floor(plot.w / 25), 24, 56);
        const rows = Math.min(data.rows, rowsWanted);
        const cols = Math.min(data.bins, colsWanted);
        let row0 = focus.row - Math.floor(rows / 2);
        let bin0 = focus.bin - Math.floor(cols / 2);
        row0 = clamp(row0, 0, Math.max(0, data.rows - rows));
        bin0 = clamp(bin0, 0, Math.max(0, data.bins - cols));
        const cellW = plot.w / cols;
        const cellH = plot.h / rows;
        return { plot, rows, cols, row0, bin0, cellW, cellH };
    }

    function drawZoom() {
        const { ctx, width, height } = fitCanvas($('zoomCanvas'));
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#0b0f14';
        ctx.fillRect(0, 0, width, height);

        if (!state.data) {
            text(ctx, '计算中…', width / 2, height / 2, '#8a9aa8', 'center', 'middle');
            return;
        }

        const data = state.data;
        const info = revealInfo();
        const rec = data.records[data.selectedKey];
        const focus = state.focus || chooseFocus(data);
        const layout = zoomLayout(width, height, focus);
        if (!layout) return;
        const { plot, rows, cols, row0, bin0, cellW, cellH } = layout;

        const stage = info.index;
        const analysisMode = stage <= 2;
        const count = info.count;
        const scheme = data.edges[data.config.edgeScheme];

        ctx.font = '10px Consolas, monospace';
        text(ctx, `帧 ${row0}…${row0 + rows - 1} · bin ${bin0}…${bin0 + cols - 1}`, plot.x, plot.y - 12, '#7d8d9c');
        text(ctx, `${(data.config.analysisHop / data.rate * 1000).toFixed(2)} ms / 帧 · ${(data.rate / data.config.fftSize).toFixed(1)} Hz / bin`,
            plot.x + plot.w, plot.y - 12, '#5d6f7e', 'right');

        // cell fills
        for (let vr = 0; vr < rows; vr++) {
            const r = row0 + vr;
            for (let vc = 0; vc < cols; vc++) {
                const k = bin0 + vc;
                const index = r * data.bins + k;
                const x = plot.x + vc * cellW;
                const y = plot.y + vr * cellH;
                const v = Math.pow(magT(data.spectrum.magnitude[index], data.peak), 0.85);
                const gray = Math.round(20 + v * 190);
                ctx.fillStyle = `rgb(${gray},${gray},${Math.min(255, gray + 12)})`;
                ctx.fillRect(x, y, cellW - 1, cellH - 1);

                let phase = null;
                if (analysisMode) {
                    if (v > 0.02) phase = data.spectrum.phase[index];
                } else {
                    const revealed = rec.order[index] >= 0
                        ? rec.order[index] < count
                        : Number.isFinite(data.anchors[index]);
                    if (revealed && cellKnown(rec, index, r, data.anchors)) {
                        phase = Number.isFinite(rec.phase[index]) ? rec.phase[index] : data.spectrum.phase[index];
                    }
                }
                if (phase !== null) {
                    const rgb = phaseRgb(phase, 0.16 + 0.40 * v);
                    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
                    ctx.fillRect(x + 1, y + 1, Math.max(1, cellW - 3), Math.max(1, cellH - 3));
                }

                // magnitude bar
                ctx.fillStyle = `rgba(255,255,255,${0.12 + 0.45 * v})`;
                ctx.fillRect(x + 3, y + cellH - 6, Math.max(1, (cellW - 8) * v), 2);

                // border
                ctx.strokeStyle = 'rgba(255,255,255,0.07)';
                ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);

                // anchor marker
                if (Number.isFinite(data.anchors[index])) {
                    ctx.strokeStyle = '#38e1d0';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    const cx = x + cellW / 2;
                    const cy = y + cellH / 2;
                    const size = Math.min(cellW, cellH) * 0.22;
                    ctx.moveTo(cx, cy - size);
                    ctx.lineTo(cx + size, cy);
                    ctx.lineTo(cx, cy + size);
                    ctx.lineTo(cx - size, cy);
                    ctx.closePath();
                    ctx.stroke();
                    ctx.lineWidth = 1;
                } else if (rec.kind === 'grid' && rec.order[index] >= 0 && rec.parent[index] === -1) {
                    // seeded component
                    ctx.strokeStyle = '#c98bff';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(x + cellW / 2, y + cellH / 2, Math.min(cellW, cellH) * 0.16, 0, TAU);
                    ctx.stroke();
                    ctx.lineWidth = 1;
                }
            }
        }

        // gradient arrows
        const showEdges = $('edgeChk').checked;
        if (showEdges && stage >= 1) {
            for (let vr = 0; vr < rows; vr++) {
                const r = row0 + vr;
                for (let vc = 0; vc < cols; vc++) {
                    const k = bin0 + vc;
                    const index = r * data.bins + k;
                    if (data.spectrum.magnitude[index] < 0.004 * data.peak) continue;
                    const x = plot.x + vc * cellW + cellW / 2;
                    const y = plot.y + vr * cellH + cellH / 2;
                    if (k + 1 < data.bins) {
                        const e = scheme.frequency[r * (data.bins - 1) + k];
                        drawArrow(ctx, x + cellW * 0.1, y - cellH * 0.14,
                            clamp(e / Math.PI, -1, 1) * cellW * 0.24, 0,
                            e >= 0 ? 'rgba(159,227,107,0.55)' : 'rgba(224,123,255,0.55)', 1);
                    }
                    if (r + 1 < data.rows) {
                        const e = scheme.time[r * data.bins + k];
                        drawArrow(ctx, x + cellW * 0.14, y + cellH * 0.02,
                            0, clamp(e / Math.PI, -1, 1) * cellH * 0.24,
                            e >= 0 ? 'rgba(84,200,255,0.55)' : 'rgba(255,154,85,0.55)', 1);
                    }
                }
            }
        }

        // parent chain from the selected cell
        if ($('parentChk').checked) {
            const selected = state.hover || state.selected;
            if (selected) {
                const chain = [];
                let index = selected.row * data.bins + selected.bin;
                for (let n = 0; n < 80; n++) {
                    chain.push(index);
                    const parent = rec.parent ? rec.parent[index] : -1;
                    if (parent < 0) break;
                    index = parent;
                }
                if (chain.length > 1) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(plot.x, plot.y, plot.w, plot.h);
                    ctx.clip();
                    ctx.strokeStyle = 'rgba(255,239,138,0.85)';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    for (let n = 0; n < chain.length; n++) {
                        const row = Math.floor(chain[n] / data.bins);
                        const bin = chain[n] - row * data.bins;
                        const x = plot.x + (bin - bin0 + 0.5) * cellW;
                        const y = plot.y + (row - row0 + 0.5) * cellH;
                        if (n === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                    }
                    ctx.stroke();
                    ctx.restore();
                    ctx.lineWidth = 1;
                }
            }
        }

        // selected & hovered cells
        const drawCellOutline = (cell, color, dash, lineWidth) => {
            if (!cell) return;
            if (cell.row < row0 || cell.row >= row0 + rows || cell.bin < bin0 || cell.bin >= bin0 + cols) return;
            const x = plot.x + (cell.bin - bin0) * cellW;
            const y = plot.y + (cell.row - row0) * cellH;
            ctx.strokeStyle = color;
            ctx.lineWidth = lineWidth;
            ctx.setLineDash(dash);
            ctx.strokeRect(x + 1.5, y + 1.5, cellW - 4, cellH - 4);
            ctx.setLineDash([]);
            ctx.lineWidth = 1;
        };
        drawCellOutline(state.selected, '#ffffff', [], 2);
        if (state.hover && (!state.selected || state.hover.row !== state.selected.row || state.hover.bin !== state.selected.bin)) {
            drawCellOutline(state.hover, 'rgba(255,255,255,0.55)', [3, 2], 1);
        }

        // edge arrows and labels for the selected/hovered cell
        const active = state.hover || state.selected;
        if (active && showEdges) {
            const r = active.row;
            const k = active.bin;
            if (r < row0 || r >= row0 + rows || k < bin0 || k >= bin0 + cols) {
                // still show the readout, but no arrows
            } else {
                const x = plot.x + (k - bin0) * cellW + cellW / 2;
                const y = plot.y + (r - row0) * cellH + cellH / 2;
                ctx.lineWidth = 2;
                if (k + 1 < data.bins) {
                    const e = scheme.frequency[r * (data.bins - 1) + k];
                    drawArrow(ctx, x, y - 5, clamp(e / Math.PI, -1, 1) * cellW * 0.44, 0,
                        e >= 0 ? '#9fe36b' : '#e07bff', 2);
                    edgeLabel(ctx, `Δf ${e >= 0 ? '+' : ''}${e.toFixed(2)}`, x + 5, y - 6, '#cfe6bb');
                }
                if (r + 1 < data.rows) {
                    const e = scheme.time[r * data.bins + k];
                    drawArrow(ctx, x - cellW * 0.16, y, 0, clamp(e / Math.PI, -1, 1) * cellH * 0.44,
                        e >= 0 ? '#54c8ff' : '#ff9a55', 2);
                    edgeLabel(ctx, `Δt ${e >= 0 ? '+' : ''}${e.toFixed(2)}`, x + 5, y + 10, '#c7e7f7');
                }
                ctx.lineWidth = 1;
            }
        }

        // axes labels
        ctx.font = '10px Consolas, monospace';
        for (let vc = 0; vc < cols; vc += 4) {
            const k = bin0 + vc;
            const x = plot.x + vc * cellW + 2;
            text(ctx, `k${k}`, x, plot.y - 2, '#5d6f7e');
        }
        ctx.font = '9px Consolas, monospace';
        for (let vr = 0; vr < rows; vr += 2) {
            const r = row0 + vr;
            const y = plot.y + vr * cellH + cellH * 0.62;
            text(ctx, `r${r}  ${(r * data.config.synthesisHop / data.rate * 1000).toFixed(0)}ms`,
                plot.x - 8, y, '#5d6f7e', 'right');
        }
        ctx.font = '10px Consolas, monospace';

        // title / footer
        const center = state.hover || state.selected;
        if (center) {
            const freq = center.bin * data.rate / data.config.fftSize;
            const time = center.row * data.config.synthesisHop / data.rate * 1000;
            text(ctx, `r=${center.row} · ${time.toFixed(1)} ms · k=${center.bin} · ${freq.toFixed(1)} Hz`,
                plot.x + plot.w, height - 8, '#9fb0c0', 'right');
        }
    }

    function drawArrow(ctx, x, y, dx, dy, color, width) {
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + dx, y + dy);
        ctx.stroke();
        const angle = Math.atan2(dy, dx);
        const head = Math.max(2.5, width * 1.8);
        ctx.beginPath();
        ctx.moveTo(x + dx, y + dy);
        ctx.lineTo(x + dx - head * Math.cos(angle - 0.45), y + dy - head * Math.sin(angle - 0.45));
        ctx.lineTo(x + dx - head * Math.cos(angle + 0.45), y + dy - head * Math.sin(angle + 0.45));
        ctx.closePath();
        ctx.fill();
        ctx.lineWidth = 1;
    }

    function edgeLabel(ctx, value, x, y, color) {
        ctx.font = '10px Consolas, monospace';
        const width = ctx.measureText(value).width + 4;
        ctx.fillStyle = 'rgba(6,10,14,0.78)';
        ctx.fillRect(x, y - 9, width, 12);
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(value, x + 2, y);
    }

    /* ------------------------------------------------------------------ */
    /* readout                                                             */
    /* ------------------------------------------------------------------ */

    function drawReadout() {
        const node = $('zoomReadout');
        if (!state.data) {
            node.textContent = '计算中…';
            return;
        }
        const data = state.data;
        const info = revealInfo();
        const rec = data.records[data.selectedKey];
        const cell = state.hover || state.selected;
        if (!cell) {
            node.textContent = '移动鼠标查看格子…';
            return;
        }
        const r = cell.row;
        const k = cell.bin;
        const index = r * data.bins + k;
        const magnitude = data.spectrum.magnitude[index];
        const freq = k * data.rate / data.config.fftSize;
        const scheme = data.edges[data.config.edgeScheme];
        const timeEdge = r < data.rows - 1 ? scheme.time[r * data.bins + k] : NaN;
        const freqEdge = k < data.bins - 1 ? scheme.frequency[r * (data.bins - 1) + k] : NaN;
        const anchor = Number.isFinite(data.anchors[index]);
        const revealed = rec.order[index] >= 0
            ? rec.order[index] < info.count
            : anchor || (rec.kind === 'causal' && r === 0);
        const known = revealed && cellKnown(rec, index, r, data.anchors);
        const synthPhase = known ? rec.phase[index] : NaN;
        const order = rec.order[index];
        const isSeed = !anchor && order >= 0 && rec.kind === 'grid' && rec.seedCount > 0
            && (!rec.parent || rec.parent[index] < 0);
        const distance = rec.distance ? rec.distance[index] : null;
        const strength = rec.strength ? rec.strength[index] : null;
        const status = anchor ? '锚点（锁定相位）'
            : isSeed ? '种子（分析相位初始化）'
                : known ? (info.index === 3 ? '本帧前沿' : '已积分')
                    : '未访问（合成时用固定种子随机初相填充）';

        const parts = [
            `格 <b>r=${r}, k=${k}</b> · <b>${(r * data.config.synthesisHop / data.rate * 1000).toFixed(1)} ms</b> · <b>${freq.toFixed(1)} Hz</b>`,
            `|X| <b>${dbLabel(20 * Math.log10(magnitude / Math.max(1e-30, data.peak)))} dB</b> · 分析相位 <b>${data.spectrum.phase[index].toFixed(2)}</b> rad`,
            `合成相位 <b>${Number.isFinite(synthPhase) ? synthPhase.toFixed(2) : '—'}</b> rad · ${status}`,
            `Δt <b>${fmt(timeEdge, 2)}</b> rad/合成步（分析 ${fmt(timeEdge / data.config.ratio, 2)}） · Δf <b>${fmt(freqEdge, 2)}</b> rad/bin`,
        ];
        const magnitudePriority = rec.method === 'global-magnitude';
        const inPropagation = !anchor && ((rec.kind === 'grid' && !isSeed && !magnitudePriority) ||
            (rec.kind === 'local' && order >= 0 && order < rec.propagationVisits));
        if (order >= 0) {
            parts.push(`访问序号 <b>#${order}</b>` +
                (inPropagation && distance !== null ? ` · 路径长 <b>${distance}</b>` : '') +
                (inPropagation && Number.isFinite(strength) ? ` · 路径最弱 <b>${strength.toFixed(4)}</b>` : '') +
                (rec.kind === 'local' && order >= rec.propagationVisits ? ' · 逐帧填充' : '') +
                (isSeed ? ' · 种子' : ''));
        }
        const parent = rec.parent ? rec.parent[index] : -1;
        if (parent >= 0) {
            const pr = Math.floor(parent / data.bins);
            const pk = parent - pr * data.bins;
            parts.push(`父格 <b>r=${pr}, k=${pk}</b>`);
        }
        if ((rec.kind === 'causal' || rec.kind === 'local') && rec.weakSeeds && r < rec.weakSeeds.length) {
            parts.push(`本帧弱旧帧入口 <b>${rec.weakSeeds[r]}</b>`);
        }
        if (rec.kind !== 'causal' && Number.isFinite(data.anchors[index])) {
            parts.push(`锚点相位 <b>${data.anchors[index].toFixed(2)}</b> rad`);
        }

        node.innerHTML = parts.map((part) => `<span>${part}</span>`).join('');
    }

    /* ------------------------------------------------------------------ */
    /* flow / caption                                                      */
    /* ------------------------------------------------------------------ */

    function buildFlow() {
        $('flowStrip').innerHTML = STAGES.map((stage, index) =>
            `<div class="flow-step" data-stage="${index}"><span class="num">${index + 1}</span>${stage.name}</div>`).join('');
        document.querySelectorAll('.flow-step').forEach((node) => {
            node.addEventListener('click', () => {
                const index = Number(node.dataset.stage);
                if (!state.data) return;
                setStage(index, index < 4);
            });
        });
    }

    function updateFlow(info) {
        const steps = document.querySelectorAll('.flow-step');
        for (let i = 0; i < steps.length; i++) {
            steps[i].classList.toggle('on', i === info.index);
            steps[i].classList.toggle('done', i < info.index);
        }

        if (!state.data) {
            $('caption').textContent = '点击“运行 / 重算”开始。';
            return;
        }
        const data = state.data;
        const rec = data.records[data.selectedKey];
        const stage = info.index;
        let caption = '';
        if (stage === 0) {
            const row = Math.round(info.p * (data.rows - 1));
            caption = `<b>分析 STFT</b>：${data.rows} 帧 × ${data.bins} bins，` +
                `窗长 ${data.config.windowSize}、FFT ${data.config.fftSize}，分析 hop ${data.config.analysisHop}，` +
                `合成 hop ${data.config.synthesisHop}，α=${data.config.ratio.toFixed(4)}。` +
                `当前正在为第 ${row} 帧加 Hann 窗并做 FFT。`;
        } else if (stage === 1) {
            const loop = data.loops[data.config.edgeScheme];
            caption = `<b>相位差分</b>：当前使用 <b>${data.config.edgeScheme}</b> 边。` +
                `时间边先扣除 ${data.config.analysisHop} 样本 hop 对应的载波，再解缠并乘以 α；` +
                `中心差分把相邻前向边平均成节点梯度。小格闭环 RMS = ` +
                `<b>${loop.rms === null ? '—' : loop.rms.toExponential(2)} rad</b>。`;
        } else if (stage === 2) {
            const first = data.onsets.length ? data.onsets[0] : null;
            const targets = first === null ? '无起音' : `${first} → ${Math.round(first * data.config.ratio)} 样点`;
            const source = data.input.isFile ? '自动检测（文件）'
                : data.config.anchorMode === 'detected' ? '自动检测' : '给定起音';
            caption = `<b>瞬态锚点</b>（${source}）：${data.onsets.length} 个起音，固定 <b>${data.anchorBins}</b> 个 bin` +
                `（${data.anchorRows.length} 帧）。锚点相位按 −2πkΔ/M 平移到输出时间；` +
                `${data.input.name}：${targets}。${first === null ? '持续音没有锚点，积分不会被瞬态相位约束。' : ''}`;
        } else if (stage === 3) {
            const mode = rec.kind === 'causal' ? '算法 1 逐帧'
                : rec.kind === 'local' ? `锚点局部传播 ${rec.propagationVisits} bin + 逐帧填充`
                    : (rec.seedCount === 0 ? '锚点连通域' : `全网格 · 种子 ${rec.seedCount}`);
            const priorityText = rec.method === 'global-magnitude'
                ? '堆按当前 bin 幅度出队，首次到达即定相位'
                : rec.kind === 'local'
                    ? '局部传播按路径最弱幅度排序，之后用逐帧堆填充其余格子'
                    : rec.kind === 'causal'
                        ? (rec.anchorBins ? '锚点作为额外堆入口；其余按旧帧／当前帧幅度出队'
                            : '堆按旧帧／当前帧幅度出队，同幅度先处理旧帧')
                        : '堆按路径最弱幅度排序，相同优先级先走短路径';
            const frontier = !state.hover && info.count > 0
                ? { row: Math.floor(rec.visitCells[info.count - 1] / data.bins), bin: rec.visitCells[info.count - 1] % data.bins }
                : state.hover;
            caption = `<b>堆积分</b>：${rec.label}（${mode}）。已揭示 <b>${info.count}</b> / ${rec.visitCount} 个访问` +
                (rec.kind === 'grid' || rec.kind === 'local' ? `，传播域覆盖 ${rec.coverage} bin` : '') +
                `。${priorityText}。当前格 ${frontier ? `r=${frontier.row}, k=${frontier.bin}` : '—'}。`;
        } else {
            const metric = rec.metrics[0];
            caption = `<b>WOLA 合成</b>：${rec.label}。` +
                (metric
                    ? `前振铃 <b>${dbLabel(metric.preDb)} dB</b>，后能量 <b>${dbLabel(metric.postDb)} dB</b>，` +
                      `主峰偏移 <b>${metric.peakOffset > 0 ? '+' : ''}${metric.peakOffset}</b> 样点。`
                    : '当前信号没有起音，无法测量前振铃。') +
                ` STFT 残差 <b>${rec.residual.toFixed(3)}</b>。`;
        }
        $('caption').innerHTML = caption;

        // reveal slider mirror
        const slider = $('revealRange');
        if (stage === 3) {
            slider.value = String(Math.round(info.p * 1000));
            $('revealLabel').textContent = `${info.count} / ${rec.visitCount}`;
        } else if (stage > 3) {
            slider.value = '1000';
            $('revealLabel').textContent = `${rec.visitCount} / ${rec.visitCount}`;
        } else {
            slider.value = '0';
            $('revealLabel').textContent = `0 / ${rec.visitCount}`;
        }
    }

    /* ------------------------------------------------------------------ */
    /* top-level draw                                                      */
    /* ------------------------------------------------------------------ */

    function draw() {
        drawWave();
        drawTF();
        drawZoom();
        drawReadout();
        if (state.data) {
            const rec = state.data.records[state.data.selectedKey];
            const shown = state.dirty ? readConfig() : state.data.config;
            $('paramSummary').textContent =
                `M=${shown.windowSize} · FFT=${shown.fftSize} · ` +
                `Ha=${shown.analysisHop} · Hs=${shown.synthesisHop} · ` +
                `α=${shown.ratio.toFixed(3)} · 半径=${shown.radius} 帧`;
            if (rec) {
                const anchors = state.data.anchorRows.length ? ` · 锚点帧 ${state.data.anchorRows.join(', ')}` : '';
                $('zoomInfo').textContent = `${rec.label} · ${rec.scheme}${anchors}`;
            }
        }
        updateFlow(revealInfo());
    }

    /* ------------------------------------------------------------------ */
    /* extra global method computation                                     */
    /* ------------------------------------------------------------------ */

    async function handleMethodChange() {
        const key = methodRecordKey($('methodSel').value);
        if (!state.data || state.dirty) {
            markDirty();
            return;
        }
        if (state.data.records[key]) {
            state.data.selectedKey = key;
            state.play.t = TOTAL_MS;
            buildTable(state.data);
            renderStats(state.data);
            draw();
            return;
        }
        if (key === 'global' || key === 'global-magnitude') {
            if (state.busy) return;
            setBusy(true, '计算全 STFT 堆…');
            await tick();
            try {
                const data = state.data;
                data.records[key] = buildGlobalRecord(data, key);
                data.selectedKey = key;
                buildTable(data);
                renderStats(data);
                state.play.t = TOTAL_MS;
                draw();
                setStatus(`就绪 · 已补算 ${key === 'global' ? '路径最弱' : '幅度优先'} 全堆`, 'on');
            } catch (error) {
                console.error(error);
                setStatus(`计算失败：${error.message}`, 'err');
            } finally {
                setBusy(false);
                $('busyTrack').style.display = 'none';
            }
        } else {
            markDirty();
        }
    }

    /* ------------------------------------------------------------------ */
    /* file input / audio                                                  */
    /* ------------------------------------------------------------------ */

    async function handleFile(file) {
        if (!file) return;
        try {
            setStatus(`解码 ${file.name}…`, '');
            const arrayBuffer = await file.arrayBuffer();
            const AudioCtor = window.AudioContext || window.webkitAudioContext;
            const decoder = new AudioCtor();
            const buffer = await decoder.decodeAudioData(arrayBuffer);
            const rate = buffer.sampleRate;
            const maxSamples = Math.min(buffer.length, Math.round(0.8 * rate));
            const signal = new Float64Array(maxSamples);
            for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
                const samples = buffer.getChannelData(channel);
                for (let i = 0; i < maxSamples; i++) signal[i] += samples[i] / buffer.numberOfChannels;
            }
            await decoder.close();
            state.file = { signal, rate, name: file.name };
            state.useFile = true;
            markDirty(`已载入 ${file.name}，点击“运行 / 重算”`);
            await computeAll();
        } catch (error) {
            console.error(error);
            setStatus(`无法解码音频：${error.message}`, 'err');
        }
    }

    function stopAudio() {
        if (state.audio.source) {
            try { state.audio.source.stop(); } catch (error) { void error; }
            state.audio.source = null;
        }
        if (state.audio.raf) cancelAnimationFrame(state.audio.raf);
        state.audio.raf = null;
        state.audio.which = null;
        $('audioInfo').textContent = '';
        draw();
    }

    function playAudio(which) {
        if (!state.data) return;
        stopAudio();
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (!state.audio.ctx) state.audio.ctx = new AudioCtor();
        const ctx = state.audio.ctx;
        ctx.resume();
        const data = state.data;
        const source = which === 'in' ? data.signal : data.records[data.selectedKey].output;
        const buffer = ctx.createBuffer(1, source.length, data.rate);
        buffer.copyToChannel(Float32Array.from(source), 0);
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = 0.8;
        node.connect(gain);
        gain.connect(ctx.destination);
        state.audio.source = node;
        state.audio.which = which;
        state.audio.start = ctx.currentTime;
        state.audio.duration = source.length / data.rate;
        $('audioInfo').textContent = which === 'in' ? '播放输入…' : '播放拉伸输出…';
        node.onended = () => {
            if (state.audio.source === node) {
                state.audio.source = null;
                $('audioInfo').textContent = '';
                drawWave();
            }
        };
        node.start();
        drawWave();
        if (state.audio.raf) cancelAnimationFrame(state.audio.raf);
        const cursor = () => {
            if (!state.audio.source) { state.audio.raf = null; drawWave(); return; }
            drawWave();
            state.audio.raf = requestAnimationFrame(cursor);
        };
        state.audio.raf = requestAnimationFrame(cursor);
    }

    /* ------------------------------------------------------------------ */
    /* init / events                                                       */
    /* ------------------------------------------------------------------ */

    function bind() {
        $('runBtn').addEventListener('click', () => { computeAll(); });
        $('playBtn').addEventListener('click', togglePlay);
        $('speedSel').addEventListener('change', () => {
            state.play.speed = parseFloat($('speedSel').value);
        });

        for (const id of ['caseSel', 'windowSel', 'hopSel', 'edgeSel', 'anchorSel']) {
            $(id).addEventListener('change', () => {
                if (id === 'caseSel') state.useFile = false;
                updateParamLabels();
                markDirty();
            });
        }
        $('ratioRange').addEventListener('input', () => {
            updateParamLabels();
            markDirty();
        });
        $('methodSel').addEventListener('change', handleMethodChange);
        $('fileInput').addEventListener('change', (event) => {
            const file = event.target.files && event.target.files[0];
            if (file) handleFile(file);
        });

        $('edgeChk').addEventListener('change', draw);
        $('parentChk').addEventListener('change', draw);

        $('revealRange').addEventListener('input', () => {
            if (!state.data) return;
            state.play.active = false;
            $('playBtn').textContent = '播放流程';
            const p = Number($('revealRange').value) / 1000;
            state.play.t = INTEGRATE_START + clamp(p, 0, 0.999) * STAGES[3].dur;
            draw();
        });

        $('playInBtn').addEventListener('click', () => playAudio('in'));
        $('playOutBtn').addEventListener('click', () => playAudio('out'));
        $('stopAudioBtn').addEventListener('click', stopAudio);

        const tf = $('tfCanvas');
        const tfCellFromEvent = (event) => {
            if (!state.data) return null;
            const rect = tf.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            const { plot } = tfLayout(rect.width, rect.height);
            if (x < plot.x || x > plot.x + plot.w || y < plot.y || y > plot.y + plot.h) return null;
            const data = state.data;
            const row = clamp(Math.round((x - plot.x) / plot.w * (data.rows - 1)), 0, data.rows - 1);
            const freq = (1 - (y - plot.y) / plot.h) * Math.min(data.rate / 2, DISPLAY_HZ);
            const bin = clamp(Math.round(freq / (data.rate / data.config.fftSize)), 0, data.bins - 1);
            return { row, bin };
        };
        tf.addEventListener('mousemove', (event) => {
            if (!state.data) return;
            state.hover = tfCellFromEvent(event);
            draw();
        });
        tf.addEventListener('mouseleave', () => {
            if (!state.data) return;
            state.hover = null;
            draw();
        });
        tf.addEventListener('click', (event) => {
            const cell = tfCellFromEvent(event);
            if (!cell) return;
            state.hover = cell;
            state.selected = { ...cell };
            state.focus = { ...cell };
            draw();
        });

        const zoom = $('zoomCanvas');
        const zoomCellFromEvent = (event) => {
            if (!state.data) return null;
            const rect = zoom.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            const layout = zoomLayout(rect.width, rect.height, state.focus || chooseFocus(state.data));
            if (!layout) return null;
            const { plot, row0, bin0, cellW, cellH, rows, cols } = layout;
            if (x < plot.x || x > plot.x + plot.w || y < plot.y || y > plot.y + plot.h) return null;
            const col = clamp(Math.floor((x - plot.x) / cellW), 0, cols - 1);
            const row = clamp(Math.floor((y - plot.y) / cellH), 0, rows - 1);
            return { row: row0 + row, bin: bin0 + col };
        };
        zoom.addEventListener('mousemove', (event) => {
            if (!state.data) return;
            const cell = zoomCellFromEvent(event);
            if (!cell) return;
            state.hover = cell;
            draw();
        });
        zoom.addEventListener('mouseleave', () => {
            if (!state.data) return;
            state.hover = null;
            draw();
        });
        zoom.addEventListener('click', (event) => {
            const cell = zoomCellFromEvent(event);
            if (!cell) return;
            state.hover = cell;
            state.selected = { ...cell };
            draw();
        });

        window.addEventListener('resize', () => {
            if (state.data) draw();
        });

        $('playInBtn').disabled = true;
        $('playOutBtn').disabled = true;
        $('stopAudioBtn').disabled = true;
    }

    function init() {
        const query = new URLSearchParams(window.location.search);
        const cases = ['impulse', 'burst', 'mixed', 'tone'];
        if (cases.includes(query.get('case'))) $('caseSel').value = query.get('case');
        const methods = ['bidirectional', 'forward', 'reset', 'causal-centered', 'causal-direct', 'global', 'global-magnitude'];
        if (methods.includes(query.get('method'))) $('methodSel').value = query.get('method');
        const ratio = parseFloat(query.get('ratio'));
        if (Number.isFinite(ratio) && ratio >= 1 && ratio <= 3) $('ratioRange').value = String(ratio);
        buildFlow();
        bind();
        updateParamLabels();
        setStatus('准备计算默认样例…', '');
        computeAll();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
