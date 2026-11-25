/*
 * RTPGHI core — browser / Node port of qwqdsp/labs/rtpghi/rtpghi.py
 *
 * The numeric layout follows the lab script:
 *   Stft(windowSize, fftSize, analysisHop, synthesisHop)
 *   analyze / wola / phase_edges / causal / propagate / propagate_global
 *   phase_anchors / detect_onsets / phase_loop_residual
 *
 * Notes on the port:
 *   - causalGrid starts from a seeded random phase, like rtpghi.py's
 *     default_rng(0). This file uses a small deterministic PRNG instead of
 *     PCG64, so unvisited-cell outputs are not bit-identical to the lab;
 *   - the grid integrator records visit order / parent / bottleneck values
 *     so the demo can animate and inspect the heap.
 */
(function (global) {
    'use strict';

    const TAU = 2 * Math.PI;

    /* ------------------------------------------------------------------ */
    /* helpers                                                             */
    /* ------------------------------------------------------------------ */

    function wrap(x) {
        const y = (x + Math.PI) % TAU;
        return (y < 0 ? y + TAU : y) - Math.PI;
    }

    /** Python / numpy round-half-to-even (JS Math.round rounds .5 up). */
    function pyRound(x) {
        const floor = Math.floor(x);
        const diff = x - floor;
        if (diff < 0.5) return floor;
        if (diff > 0.5) return floor + 1;
        return floor % 2 === 0 ? floor : floor + 1;
    }

    function hann(size) {
        const w = new Float64Array(size);
        for (let n = 0; n < size; n++) {
            w[n] = 0.5 - 0.5 * Math.cos(TAU * n / size);
        }
        return w;
    }

    /** Small deterministic PRNG (mulberry32) for the test signals. */
    function rng(seed) {
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /* ------------------------------------------------------------------ */
    /* FFT (iterative radix-2, power-of-two sizes)                         */
    /* ------------------------------------------------------------------ */

    const fftCache = new Map();

    function isPowerOfTwo(n) {
        return n > 0 && (n & (n - 1)) === 0;
    }

    /** Direct DFT for the odd short-window sizes used by onset detection. */
    function dftFor(n) {
        let entry = fftCache.get(n);
        if (entry) return entry;
        const cos = new Float64Array(n);
        const sin = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            cos[i] = Math.cos(TAU * i / n);
            sin[i] = Math.sin(TAU * i / n);
        }
        function forward(re, im) {
            const outRe = new Float64Array(n);
            const outIm = new Float64Array(n);
            for (let k = 0; k < n; k++) {
                let sr = 0;
                let si = 0;
                for (let t = 0; t < n; t++) {
                    const w = (k * t) % n;
                    const c = cos[w];
                    const s = sin[w];
                    sr += re[t] * c + im[t] * s;
                    si += im[t] * c - re[t] * s;
                }
                outRe[k] = sr;
                outIm[k] = si;
            }
            re.set(outRe);
            im.set(outIm);
        }
        function inverse(re, im) {
            for (let i = 0; i < n; i++) im[i] = -im[i];
            forward(re, im);
            for (let i = 0; i < n; i++) {
                re[i] /= n;
                im[i] = -im[i] / n;
            }
        }
        entry = { forward, inverse };
        fftCache.set(n, entry);
        return entry;
    }

    function fftFor(n) {
        let entry = fftCache.get(n);
        if (entry) return entry;
        if (!isPowerOfTwo(n)) return dftFor(n);
        const levels = Math.round(Math.log2(n));
        const reverse = new Uint32Array(n);
        for (let i = 0; i < n; i++) {
            let x = i;
            let r = 0;
            for (let b = 0; b < levels; b++) {
                r = (r << 1) | (x & 1);
                x >>>= 1;
            }
            reverse[i] = r;
        }
        const cos = new Float64Array(n / 2);
        const sin = new Float64Array(n / 2);
        for (let i = 0; i < n / 2; i++) {
            cos[i] = Math.cos(TAU * i / n);
            sin[i] = Math.sin(TAU * i / n);
        }

        function forward(re, im) {
            for (let i = 0; i < n; i++) {
                const j = reverse[i];
                if (j > i) {
                    let t = re[i]; re[i] = re[j]; re[j] = t;
                    t = im[i]; im[i] = im[j]; im[j] = t;
                }
            }
            for (let size = 2; size <= n; size <<= 1) {
                const half = size >> 1;
                const step = n / size;
                for (let base = 0; base < n; base += size) {
                    for (let j = 0; j < half; j++) {
                        const w = j * step;
                        const c = cos[w];
                        const s = sin[w];
                        const even = base + j;
                        const odd = even + half;
                        const tr = re[odd] * c + im[odd] * s;
                        const ti = im[odd] * c - re[odd] * s;
                        re[odd] = re[even] - tr;
                        im[odd] = im[even] - ti;
                        re[even] += tr;
                        im[even] += ti;
                    }
                }
            }
        }

        function inverse(re, im) {
            // conj -> forward -> conj / n
            for (let i = 0; i < n; i++) im[i] = -im[i];
            forward(re, im);
            for (let i = 0; i < n; i++) {
                re[i] /= n;
                im[i] = -im[i] / n;
            }
        }

        entry = { forward, inverse };
        fftCache.set(n, entry);
        return entry;
    }

    /* ------------------------------------------------------------------ */
    /* STFT / WOLA                                                          */
    /* ------------------------------------------------------------------ */

    /**
     * Analysis STFT with centered frames, matching rtpghi.analyze().
     * @returns {{rows:number,bins:number,magnitude:Float64Array,phase:Float64Array}}
     */
    function analyze(signal, windowSize, fftSize, centers, weights) {
        const half = windowSize >> 1;
        const bins = (fftSize >> 1) + 1;
        const rows = centers.length;
        const magnitude = new Float64Array(rows * bins);
        const phase = new Float64Array(rows * bins);
        const window = weights || hann(windowSize);
        const fft = fftFor(fftSize);
        const re = new Float64Array(fftSize);
        const im = new Float64Array(fftSize);
        const samples = new Float64Array(windowSize);
        const length = signal.length;

        for (let row = 0; row < rows; row++) {
            const start = centers[row] - half;
            for (let n = 0; n < windowSize; n++) {
                const index = start + n;
                samples[n] = (index >= 0 && index < length) ? signal[index] * window[n] : 0;
            }
            // np.roll(frames, -half) before the FFT
            re.fill(0);
            im.fill(0);
            for (let i = 0; i < fftSize; i++) {
                let src = (i + half) % fftSize;
                if (src < windowSize) re[i] = samples[src];
            }
            fft.forward(re, im);
            const offset = row * bins;
            for (let k = 0; k < bins; k++) {
                magnitude[offset + k] = Math.hypot(re[k], im[k]);
                phase[offset + k] = Math.atan2(im[k], re[k]);
            }
        }
        return { rows, bins, magnitude, phase };
    }

    /** WOLA synthesis from a magnitude/phase grid (matches rtpghi.wola()). */
    function wola(magnitude, phase, config, length, weights) {
        const fftSize = config.fftSize;
        const windowSize = config.windowSize;
        const hop = config.synthesisHop;
        const half = windowSize >> 1;
        const bins = (fftSize >> 1) + 1;
        const rows = Math.floor(magnitude.length / bins);
        const window = weights || hann(windowSize);
        const squares = new Float64Array(windowSize);
        for (let n = 0; n < windowSize; n++) squares[n] = window[n] * window[n];

        const size = Math.max(0, (rows - 1) * hop + windowSize);
        const signal = new Float64Array(size);
        const norm = new Float64Array(size);
        const fft = fftFor(fftSize);
        const re = new Float64Array(fftSize);
        const im = new Float64Array(fftSize);

        for (let row = 0; row < rows; row++) {
            const offset = row * bins;
            for (let k = 0; k < bins; k++) {
                const m = magnitude[offset + k];
                const p = phase[offset + k];
                const real = m * Math.cos(p);
                const imag = (k === 0 || k === bins - 1) ? 0 : m * Math.sin(p);
                re[k] = real;
                im[k] = imag;
                if (k > 0 && k < bins - 1) {
                    re[fftSize - k] = real;
                    im[fftSize - k] = -imag;
                }
            }
            fft.inverse(re, im);
            const start = row * hop;
            for (let n = 0; n < windowSize; n++) {
                const src = (n - half + fftSize) % fftSize;
                signal[start + n] += re[src] * window[n];
                norm[start + n] += squares[n];
            }
        }

        const out = new Float64Array(length);
        for (let n = 0; n < length; n++) {
            const index = half + n;
            if (index < size) out[n] = norm[index] > 0 ? signal[index] / norm[index] : 0;
        }
        return out;
    }

    /* ------------------------------------------------------------------ */
    /* phase gradients                                                      */
    /* ------------------------------------------------------------------ */

    /**
     * Phase steps in radians per synthesis step (time) / per bin (frequency).
     * Returns flat arrays: time [(rows-1)*bins], frequency [rows*(bins-1)].
     */
    function phaseEdges(phase, rows, bins, config, centered) {
        const hop = config.analysisHop;
        const fftSize = config.fftSize;
        const ratio = config.synthesisHop / hop;
        const carrier = new Float64Array(bins);
        for (let k = 0; k < bins; k++) carrier[k] = TAU * hop / fftSize * k;

        const time = new Float64Array((rows - 1) * bins);
        for (let r = 0; r < rows - 1; r++) {
            for (let k = 0; k < bins; k++) {
                time[r * bins + k] = wrap(phase[(r + 1) * bins + k] - phase[r * bins + k] - carrier[k]) + carrier[k];
            }
        }
        const frequency = new Float64Array(rows * (bins - 1));
        for (let r = 0; r < rows; r++) {
            for (let k = 0; k < bins - 1; k++) {
                frequency[r * (bins - 1) + k] = wrap(phase[r * bins + k + 1] - phase[r * bins + k]);
            }
        }

        if (centered) {
            // Node steps: average the two adjacent one-sided differences.
            const dt = new Float64Array(rows * bins);
            for (let k = 0; k < bins; k++) {
                dt[k] = time[k];
                dt[(rows - 1) * bins + k] = time[(rows - 2) * bins + k];
            }
            for (let r = 1; r < rows - 1; r++) {
                for (let k = 0; k < bins; k++) {
                    dt[r * bins + k] = 0.5 * (time[(r - 1) * bins + k] + time[r * bins + k]);
                }
            }
            for (let r = 0; r < rows - 1; r++) {
                for (let k = 0; k < bins; k++) {
                    time[r * bins + k] = 0.5 * (dt[r * bins + k] + dt[(r + 1) * bins + k]);
                }
            }

            const df = new Float64Array(rows * bins);
            for (let r = 0; r < rows; r++) {
                const row = r * (bins - 1);
                const rowOut = r * bins;
                df[rowOut] = frequency[row];
                df[rowOut + bins - 1] = frequency[row + bins - 2];
                for (let k = 1; k < bins - 1; k++) {
                    df[rowOut + k] = 0.5 * (frequency[row + k - 1] + frequency[row + k]);
                }
            }
            for (let r = 0; r < rows; r++) {
                const row = r * (bins - 1);
                const rowOut = r * bins;
                for (let k = 0; k < bins - 1; k++) {
                    frequency[row + k] = 0.5 * (df[rowOut + k] + df[rowOut + k + 1]);
                }
            }
        }

        for (let i = 0; i < time.length; i++) time[i] *= ratio;
        for (let i = 0; i < frequency.length; i++) frequency[i] *= ratio;
        return { time, frequency, ratio };
    }

    /** Wrapped circulation around each elementary time-frequency cell. */
    function phaseLoopResidual(edges, rows, bins) {
        const out = new Float64Array((rows - 1) * (bins - 1));
        for (let r = 0; r < rows - 1; r++) {
            for (let b = 0; b < bins - 1; b++) {
                const value = edges.time[r * bins + b]
                    + edges.frequency[(r + 1) * (bins - 1) + b]
                    - edges.time[r * bins + b + 1]
                    - edges.frequency[r * (bins - 1) + b];
                out[r * (bins - 1) + b] = wrap(value);
            }
        }
        return out;
    }

    function measureLoops(magnitude, edges, rows, bins, tolerance) {
        let peak = 0;
        for (let i = 0; i < magnitude.length; i++) if (magnitude[i] > peak) peak = magnitude[i];
        const residual = phaseLoopResidual(edges, rows, bins);
        let cells = 0;
        let sumWeight = 0;
        let sumSquares = 0;
        let nonClosing = 0;
        for (let r = 0; r < rows - 1; r++) {
            for (let b = 0; b < bins - 1; b++) {
                const a = magnitude[r * bins + b];
                const c = magnitude[r * bins + b + 1];
                const d = magnitude[(r + 1) * bins + b];
                const e = magnitude[(r + 1) * bins + b + 1];
                const strength = Math.min(Math.min(a, c), Math.min(d, e));
                if (!(strength > tolerance * peak)) continue;
                const value = residual[r * (bins - 1) + b];
                const weight = (strength / peak) * (strength / peak);
                cells++;
                sumWeight += weight;
                sumSquares += value * value * weight;
                if (Math.abs(value) > 1e-8) nonClosing++;
            }
        }
        return {
            cells,
            rms: cells ? Math.sqrt(sumSquares / sumWeight) : null,
            nonClosingFraction: cells ? nonClosing / cells : null,
        };
    }

    /* ------------------------------------------------------------------ */
    /* heaps                                                                */
    /* ------------------------------------------------------------------ */

    class Heap {
        constructor(capacity) {
            const cap = Math.max(16, capacity | 0);
            this.p = new Float64Array(cap);
            this.a = new Int32Array(cap);   // type / steps
            this.r = new Int32Array(cap);
            this.k = new Int32Array(cap);
            this.n = 0;
            this.topP = 0;
            this.topA = 0;
            this.topR = 0;
            this.topK = 0;
        }

        clear() { this.n = 0; }

        grow() {
            const cap = this.p.length * 2;
            const p = new Float64Array(cap); p.set(this.p); this.p = p;
            const a = new Int32Array(cap); a.set(this.a); this.a = a;
            const r = new Int32Array(cap); r.set(this.r); this.r = r;
            const k = new Int32Array(cap); k.set(this.k); this.k = k;
        }

        /** Python tuple order: priority, aux, row, bin — all ascending. */
        lessIndex(i, j) {
            if (this.p[i] !== this.p[j]) return this.p[i] < this.p[j];
            if (this.a[i] !== this.a[j]) return this.a[i] < this.a[j];
            if (this.r[i] !== this.r[j]) return this.r[i] < this.r[j];
            return this.k[i] < this.k[j];
        }

        lessValues(p, a, r, k, j) {
            if (p !== this.p[j]) return p < this.p[j];
            if (a !== this.a[j]) return a < this.a[j];
            if (r !== this.r[j]) return r < this.r[j];
            return k < this.k[j];
        }

        copy(from, to) {
            this.p[to] = this.p[from];
            this.a[to] = this.a[from];
            this.r[to] = this.r[from];
            this.k[to] = this.k[from];
        }

        set(i, p, a, r, k) {
            this.p[i] = p;
            this.a[i] = a;
            this.r[i] = r;
            this.k[i] = k;
        }

        push(p, a, r, k) {
            if (this.n === this.p.length) this.grow();
            let i = this.n++;
            while (i > 0) {
                const parent = (i - 1) >> 1;
                if (this.lessValues(p, a, r, k, parent)) {
                    this.copy(parent, i);
                    i = parent;
                } else {
                    break;
                }
            }
            this.set(i, p, a, r, k);
        }

        pop() {
            this.n--;
            this.topP = this.p[0];
            this.topA = this.a[0];
            this.topR = this.r[0];
            this.topK = this.k[0];
            if (this.n === 0) return;

            const p = this.p[this.n];
            const a = this.a[this.n];
            const r = this.r[this.n];
            const k = this.k[this.n];
            let i = 0;
            while (true) {
                const left = 2 * i + 1;
                if (left >= this.n) break;
                const right = left + 1;
                let child = left;
                if (right < this.n && this.lessIndex(right, left)) child = right;
                if (this.lessValues(p, a, r, k, child)) break;
                this.copy(child, i);
                i = child;
            }
            this.set(i, p, a, r, k);
        }
    }

    /* ------------------------------------------------------------------ */
    /* causal integration (Algorithm 1 of the lab code)                     */
    /* ------------------------------------------------------------------ */

    /**
     * @param {Float64Array} magnitude
     * @param {Float64Array} analysisPhase
     * @param {{time:Float64Array,frequency:Float64Array}} edges
     * @param {Float64Array} fixed  anchors (NaN = free)
     */
    function causalGrid(magnitude, analysisPhase, edges, fixed, rows, bins, tolerance, randomSeed) {
        const phase = new Float64Array(rows * bins);
        const random = rng(randomSeed === undefined ? 0 : randomSeed);
        for (let i = 0; i < phase.length; i++) phase[i] = random() * TAU - Math.PI;
        for (let k = 0; k < bins; k++) {
            phase[k] = Number.isFinite(fixed[k]) ? fixed[k] : analysisPhase[k];
        }
        const order = new Int32Array(rows * bins).fill(-1);
        const parent = new Int32Array(rows * bins).fill(-1);
        const visitCells = new Int32Array(rows * bins);
        const rowStarts = new Int32Array(rows + 1);
        const weakSeeds = new Int32Array(rows);
        const peaks = new Float64Array(rows);
        for (let r = 0; r < rows; r++) {
            let peak = 0;
            for (let k = 0; k < bins; k++) {
                const m = magnitude[r * bins + k];
                if (m > peak) peak = m;
            }
            peaks[r] = peak;
        }
        for (let k = 0; k < bins; k++) {
            if (Number.isFinite(fixed[k])) phase[k] = fixed[k];
        }

        const pending = new Uint8Array(bins);
        const heap = new Heap(2 * bins + 16);
        let visit = 0;

        for (let row = 1; row < rows; row++) {
            rowStarts[row] = visit;
            const base = row * bins;
            const prev = (row - 1) * bins;
            const threshold = tolerance * Math.max(peaks[row - 1], peaks[row]);
            let remaining = 0;
            for (let k = 0; k < bins; k++) {
                const anchor = Number.isFinite(fixed[base + k]);
                if (anchor) {
                    phase[base + k] = fixed[base + k];
                    pending[k] = 0;
                } else {
                    const active = magnitude[base + k] > threshold ? 1 : 0;
                    pending[k] = active;
                    if (active) remaining++;
                }
            }

            heap.clear();
            for (let k = 0; k < bins; k++) {
                if (pending[k]) heap.push(-magnitude[prev + k], 0, row - 1, k);
            }
            for (let k = 0; k < bins; k++) {
                if (Number.isFinite(fixed[base + k])) {
                    heap.push(-magnitude[base + k], 1, row, k);
                }
            }

            while (remaining > 0 && heap.n > 0) {
                heap.pop();
                const type = heap.topA;
                const srcRow = type ? row : row - 1;
                const source = srcRow * bins + heap.topK;
                const value = phase[source];

                if (type === 1) {
                    const k = heap.topK;
                    if (k + 1 < bins && pending[k + 1]) {
                        const target = base + k + 1;
                        pending[k + 1] = 0;
                        remaining--;
                        phase[target] = wrap(value + edges.frequency[row * (bins - 1) + k]);
                        visitCells[visit] = target;
                        order[target] = visit++;
                        parent[target] = source;
                        heap.push(-magnitude[target], 1, row, k + 1);
                    }
                    if (k > 0 && pending[k - 1]) {
                        const target = base + k - 1;
                        pending[k - 1] = 0;
                        remaining--;
                        phase[target] = wrap(value - edges.frequency[row * (bins - 1) + k - 1]);
                        visitCells[visit] = target;
                        order[target] = visit++;
                        parent[target] = source;
                        heap.push(-magnitude[target], 1, row, k - 1);
                    }
                } else {
                    const k = heap.topK;
                    if (pending[k]) {
                        pending[k] = 0;
                        remaining--;
                        phase[base + k] = wrap(value + edges.time[(row - 1) * bins + k]);
                        visitCells[visit] = base + k;
                        order[base + k] = visit++;
                        parent[base + k] = source;
                        heap.push(-magnitude[base + k], 1, row, k);
                        if (magnitude[prev + k] < 0.1 * magnitude[base + k]) weakSeeds[row]++;
                    }
                }
            }
        }
        rowStarts[rows] = visit;
        return { phase, order, parent, visitCells, rowStarts, weakSeeds, visitCount: visit };
    }

    /* ------------------------------------------------------------------ */
    /* grid integration (local anchors / whole-STFT heap)                   */
    /* ------------------------------------------------------------------ */

    function anchorFrameRange(anchorRows, radius) {
        const rows = anchorRows.length;
        const active = new Uint8Array(rows);
        for (let r = 0; r < rows; r++) {
            if (!anchorRows[r]) continue;
            const from = Math.max(0, r - radius);
            const to = Math.min(rows - 1, r + radius);
            for (let i = from; i <= to; i++) active[i] = 1;
        }
        return active;
    }

    /**
     * Port of _integrate_grid(). `fixed` is modified in place (NaN = pending).
     */
    function integrateGrid(magnitude, edges, fixed, pending, rows, bins, options) {
        const backward = !!options.backward;
        const bottleneck = options.bottleneck !== false;
        const seedPhase = options.seedPhase || null;

        const strength = new Float64Array(rows * bins);
        const distance = new Int32Array(rows * bins);
        const order = new Int32Array(rows * bins).fill(-1);
        const parent = new Int32Array(rows * bins).fill(-1);
        const visitCells = new Int32Array(rows * bins);
        const heap = new Heap(4096);
        let visit = 0;

        for (let r = 0; r < rows; r++) {
            for (let k = 0; k < bins; k++) {
                const index = r * bins + k;
                if (Number.isFinite(fixed[index])) {
                    heap.push(-magnitude[index], 0, r, k);
                }
            }
        }

        function drain() {
            while (heap.n > 0) {
                heap.pop();
                const priority = heap.topP;
                const steps = heap.topA;
                const row = heap.topR;
                const k = heap.topK;
                const index = row * bins + k;
                if (bottleneck && steps > 0 &&
                    (-priority !== strength[index] || steps !== distance[index])) {
                    continue;
                }
                pending[index] = 0;
                if (order[index] < 0) {
                    visitCells[visit] = index;
                    order[index] = visit++;
                }
                const value = fixed[index];

                // -frequency (left), +frequency (right)
                if (k > 0) expand(row, k - 1, index, steps, priority, value - edges.frequency[row * (bins - 1) + k - 1]);
                if (k + 1 < bins) expand(row, k + 1, index, steps, priority, value + edges.frequency[row * (bins - 1) + k]);
                // +time (down)
                if (row + 1 < rows) expand(row + 1, k, index, steps, priority, value + edges.time[row * bins + k]);
                // -time (up)
                if (backward && row > 0) expand(row - 1, k, index, steps, priority, value - edges.time[(row - 1) * bins + k]);
            }
        }

        function expand(targetRow, targetK, sourceIndex, steps, priority, estimate) {
            const target = targetRow * bins + targetK;
            if (!pending[target]) return;
            const capacity = magnitude[target];
            if (bottleneck) {
                const nextStrength = Math.min(-priority, capacity);
                if (nextStrength < strength[target] ||
                    (nextStrength === strength[target] && steps + 1 >= distance[target])) {
                    return;
                }
                strength[target] = nextStrength;
                distance[target] = steps + 1;
                fixed[target] = wrap(estimate);
                parent[target] = sourceIndex;
                heap.push(-nextStrength, steps + 1, targetRow, targetK);
            } else {
                // PGHI: assign a phase on first discovery, queue by bin magnitude.
                pending[target] = 0;
                fixed[target] = wrap(estimate);
                parent[target] = sourceIndex;
                heap.push(-capacity, steps + 1, targetRow, targetK);
            }
        }

        drain();

        let seedCount = 0;
        if (seedPhase) {
            const candidates = [];
            for (let i = 0; i < rows * bins; i++) if (pending[i]) candidates.push(i);
            candidates.sort((a, b) => (magnitude[b] - magnitude[a]) || (a - b));
            for (let c = 0; c < candidates.length; c++) {
                const index = candidates[c];
                if (!pending[index]) continue;
                const r = Math.floor(index / bins);
                const k = index - r * bins;
                fixed[index] = seedPhase[index];
                visitCells[visit] = index;
                order[index] = visit++;
                parent[index] = -1;
                heap.push(-magnitude[index], 0, r, k);
                seedCount++;
                drain();
            }
        }

        return { order, parent, visitCells, visitCount: visit, seedCount,
                 strength, distance };
    }

    /** Local anchor propagation within ±radius frames. */
    function propagate(magnitude, analysisPhase, edges, anchors, rows, bins, radius, tolerance, backward) {
        const fixed = Float64Array.from(anchors);
        const locked = new Uint8Array(rows * bins);
        const anchorRows = new Uint8Array(rows);
        let peak = 0;
        for (let i = 0; i < magnitude.length; i++) if (magnitude[i] > peak) peak = magnitude[i];
        for (let i = 0; i < fixed.length; i++) {
            if (Number.isFinite(fixed[i])) {
                locked[i] = 1;
                anchorRows[Math.floor(i / bins)] = 1;
            }
        }
        const activeRows = anchorFrameRange(anchorRows, radius);
        const pending = new Uint8Array(rows * bins);
        for (let r = 0; r < rows; r++) {
            if (!activeRows[r]) continue;
            for (let k = 0; k < bins; k++) {
                const index = r * bins + k;
                pending[index] = (!locked[index] && magnitude[index] > tolerance * peak) ? 1 : 0;
            }
        }
        const grid = integrateGrid(magnitude, edges, fixed, pending, rows, bins, {
            backward, bottleneck: true, seedPhase: null,
        });
        return { phase: fixed, ...grid };
    }

    /** Whole-STFT integration; unvisited components are seeded from the analysis phase. */
    function propagateGlobal(magnitude, analysisPhase, edges, anchors, rows, bins, tolerance, bottleneck) {
        const fixed = Float64Array.from(anchors);
        const locked = new Uint8Array(rows * bins);
        let peak = 0;
        for (let i = 0; i < magnitude.length; i++) if (magnitude[i] > peak) peak = magnitude[i];
        for (let i = 0; i < fixed.length; i++) {
            if (Number.isFinite(fixed[i])) locked[i] = 1;
        }
        const pending = new Uint8Array(rows * bins);
        for (let i = 0; i < pending.length; i++) {
            pending[i] = (!locked[i] && magnitude[i] > tolerance * peak) ? 1 : 0;
        }
        const grid = integrateGrid(magnitude, edges, fixed, pending, rows, bins, {
            backward: true, bottleneck: bottleneck, seedPhase: analysisPhase,
        });
        return { phase: fixed, ...grid };
    }

    /* ------------------------------------------------------------------ */
    /* transients / anchors                                                 */
    /* ------------------------------------------------------------------ */

    function findPeaks(values, height, distance) {
        const peaks = [];
        for (let i = 1; i < values.length - 1; i++) {
            if (values[i] > height && values[i] >= values[i - 1] && values[i] > values[i + 1]) {
                peaks.push(i);
            }
        }
        peaks.sort((a, b) => values[b] - values[a]);
        const kept = [];
        for (const peak of peaks) {
            if (kept.every((other) => Math.abs(other - peak) >= distance)) kept.push(peak);
        }
        kept.sort((a, b) => a - b);
        return kept;
    }

    /** Broadband positive spectral flux, refined on the waveform. */
    function detectOnsets(signal, rate) {
        const size = Math.max(32, 2 * pyRound(0.0027 * rate));
        const hop = size >> 2;
        const centers = [];
        for (let c = -hop; c < signal.length + (size >> 1); c += hop) centers.push(c);
        const short = analyze(signal, size, size, Int32Array.from(centers), hann(size));
        const rows = short.rows;
        const bins = short.bins - 1; // drop DC
        const mag = new Float64Array(rows * bins);
        for (let r = 0; r < rows; r++) {
            for (let k = 0; k < bins; k++) mag[r * bins + k] = short.magnitude[r * short.bins + k + 1];
        }
        let peak = 0;
        for (let i = 0; i < mag.length; i++) if (mag[i] > peak) peak = mag[i];
        const flux = new Float64Array(rows);
        for (let r = 1; r < rows; r++) {
            let total = 0;
            let significantCount = 0;
            for (let k = 0; k < bins; k++) {
                const left = k > 0 ? mag[(r - 1) * bins + k - 1] : 0;
                const same = mag[(r - 1) * bins + k];
                const right = k + 1 < bins ? mag[(r - 1) * bins + k + 1] : 0;
                const reference = Math.max(left, same, right);
                const rise = Math.max(mag[r * bins + k] - reference, 0);
                const significant = rise > 0.001 * peak ? 1 : 0;
                significantCount += significant;
                total += rise * significant;
            }
            if (significantCount / bins < 0.12) total = 0;
            flux[r] = total;
        }
        let fluxPeak = 0;
        for (let i = 0; i < flux.length; i++) if (flux[i] > fluxPeak) fluxPeak = flux[i];
        if (fluxPeak <= 0) return [];
        const distance = Math.max(1, pyRound(0.012 * rate / hop));
        const maxima = findPeaks(flux, 0.08 * fluxPeak, distance);
        const attack = new Float64Array(signal.length);
        for (let n = 0; n < signal.length; n++) {
            attack[n] = Math.abs(signal[n] - (n ? signal[n - 1] : 0));
        }
        const onsets = new Set();
        for (const maximum of maxima) {
            const center = centers[maximum];
            const start = Math.max(0, center - (size >> 1));
            const stop = Math.min(signal.length, center + (size >> 1) + 1);
            let localMax = 0;
            for (let n = start; n < stop; n++) if (attack[n] > localMax) localMax = attack[n];
            if (localMax <= 0) continue;
            for (let n = start; n < stop; n++) {
                if (attack[n] >= 0.7 * localMax) {
                    onsets.add(n);
                    break;
                }
            }
        }
        return Array.from(onsets).sort((a, b) => a - b);
    }

    /** Transient-dominated anchor bins with the output-time phase shift. */
    function phaseAnchors(signal, analysis, config, onsets, rate, tolerance) {
        const rows = analysis.rows;
        const bins = analysis.bins;
        const anchors = new Float64Array(rows * bins).fill(NaN);
        const confidence = new Float64Array(rows * bins);
        const shortSize = Math.min(config.windowSize, Math.max(32, 2 * pyRound(0.0027 * rate)));
        const size = shortSize;
        const omega = new Float64Array(bins);
        for (let k = 0; k < bins; k++) omega[k] = TAU / config.fftSize * k;
        const shortWeights = hann(size);

        for (const onset of onsets) {
            const row = Math.min(rows - 1, pyRound(onset / config.analysisHop));
            const outputOnset = pyRound(config.ratio * onset);
            const displacement = outputOnset - row * config.synthesisHop
                - (onset - row * config.analysisHop);
            const short = analyze(signal, size, config.fftSize,
                Int32Array.from([onset - size, onset]), shortWeights);
            const beforeOffset = 0;
            const eventOffset = bins;
            let rowPeak = 0;
            for (let k = 0; k < bins; k++) {
                const m = analysis.magnitude[row * bins + k];
                if (m > rowPeak) rowPeak = m;
            }
            let strengthPeak = 0;
            const strength = new Float64Array(bins);
            for (let k = 0; k < bins; k++) {
                const event = short.magnitude[eventOffset + k];
                const previous = short.magnitude[beforeOffset + k];
                const current = analysis.magnitude[row * bins + k];
                const dominant = event > 2 * previous && event >= 0.5 * current
                    && current > tolerance * rowPeak;
                strength[k] = dominant ? event : 0;
                if (strength[k] > strengthPeak) strengthPeak = strength[k];
            }
            const threshold = 0.15 * strengthPeak;
            for (let k = 0; k < bins; k++) {
                const index = row * bins + k;
                if (strength[k] > threshold && strength[k] > confidence[index]) {
                    anchors[index] = wrap(analysis.phase[index] - omega[k] * displacement);
                    confidence[index] = strength[k];
                }
            }
        }
        return anchors;
    }

    /* ------------------------------------------------------------------ */
    /* measurements                                                         */
    /* ------------------------------------------------------------------ */

    function stftResidual(observed, targetMagnitude, targetPhase, rows, bins) {
        let diff = 0;
        let norm = 0;
        for (let r = 0; r < rows; r++) {
            for (let k = 0; k < bins; k++) {
                const index = r * bins + k;
                const m = targetMagnitude[index];
                const p = targetPhase[index];
                const realD = observed.magnitude[index] * Math.cos(observed.phase[index]) - m * Math.cos(p);
                const imagD = observed.magnitude[index] * Math.sin(observed.phase[index]) - m * Math.sin(p);
                diff += realD * realD + imagD * imagD;
                norm += m * m;
            }
        }
        return Math.sqrt(diff / Math.max(1e-30, norm));
    }

    function energyDb(numerator, denominator) {
        return 10 * Math.log10(Math.max(1e-15, numerator / Math.max(1e-30, denominator)));
    }

    /**
     * Pre/post energy and peak offset around one transient, following
     * experiment.measure().
     */
    function transientMetrics(output, onset, ratio, windowSize, duration, rate) {
        const target = Math.min(output.length - 1, Math.round(onset * ratio));
        const left0 = target - (windowSize >> 1);
        const right0 = target + duration + (windowSize >> 1);
        const left = Math.max(0, Math.min(left0, target));
        const right = Math.max(left + 1, Math.min(output.length, right0));
        const end = Math.min(right, target + duration);
        let total = 0;
        for (let i = left; i < right; i++) total += output[i] * output[i];
        let pre = 0;
        for (let i = left; i < target; i++) pre += output[i] * output[i];
        let post = 0;
        for (let i = end; i < right; i++) post += output[i] * output[i];
        let peak = 0;
        let peakIndex = left;
        for (let i = left; i < right; i++) {
            const value = Math.abs(output[i]);
            if (value > peak) { peak = value; peakIndex = i; }
        }
        return {
            target,
            preDb: energyDb(pre, total),
            postDb: energyDb(post, total),
            peakOffset: peakIndex - target,
            mainPeak: peak,
            left,
            right,
            rate,
        };
    }

    /* ------------------------------------------------------------------ */
    /* public API                                                           */
    /* ------------------------------------------------------------------ */

    const api = {
        TAU,
        wrap,
        hann,
        pyRound,
        rng,
        fftFor,
        analyze,
        wola,
        phaseEdges,
        phaseLoopResidual,
        measureLoops,
        causalGrid,
        propagate,
        propagateGlobal,
        anchorFrameRange,
        detectOnsets,
        phaseAnchors,
        stftResidual,
        energyDb,
        transientMetrics,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        global.RTPGHI = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
