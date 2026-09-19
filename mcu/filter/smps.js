"use strict";

        const PI2 = 2 * Math.PI;

        // 各物理量的可选单位（下拉框）。{v} 乘数，{n} 显示名
        const UNITS = {
            V:   [{ v: 1, n: "V" }, { v: 1e-3, n: "mV" }],
            A:   [{ v: 1e-3, n: "mA" }, { v: 1, n: "A" }],
            Hz:  [{ v: 1, n: "Hz" }, { v: 1e3, n: "kHz" }, { v: 1e6, n: "MHz" }],
            ohm: [{ v: 1, n: "Ω" }, { v: 1e3, n: "kΩ" }, { v: 1e6, n: "MΩ" }],
            F:   [{ v: 1e-12, n: "pF" }, { v: 1e-9, n: "nF" }, { v: 1e-6, n: "µF" }, { v: 1e-3, n: "mF" }, { v: 1, n: "F" }],
            H:   [{ v: 1e-9, n: "nH" }, { v: 1e-6, n: "µH" }, { v: 1e-3, n: "mH" }, { v: 1, n: "H" }],
            Pct: [{ v: 0.01, n: "%" }, { v: 1, n: "比例" }],
        };

        // 结果格式化所用量表（按量纲选择）
        const ENG = {
            H: [{ v: 1, n: "H" }, { v: 1e-3, n: "mH" }, { v: 1e-6, n: "µH" }, { v: 1e-9, n: "nH" }],
            F: [{ v: 1, n: "F" }, { v: 1e-3, n: "mF" }, { v: 1e-6, n: "µF" }, { v: 1e-9, n: "nF" }, { v: 1e-12, n: "pF" }],
            A: [{ v: 1, n: "A" }, { v: 1e-3, n: "mA" }],
            V: [{ v: 1, n: "V" }, { v: 1e-3, n: "mV" }],
            ohm: [{ v: 1e6, n: "MΩ" }, { v: 1e3, n: "kΩ" }, { v: 1, n: "Ω" }],
        };

        function fmtEng(x, units) {
            if (!isFinite(x) || x <= 0) return "--";
            for (const u of units) {
                if (x >= u.v) {
                    const s = x / u.v >= 100 ? (x / u.v).toPrecision(4) : (x / u.v).toPrecision(3);
                    return s + " " + u.n;
                }
            }
            return x.toPrecision(3) + " " + units[units.length - 1].n;
        }

        function fmtPct(d) {
            if (!isFinite(d)) return "--";
            return (d * 100).toFixed(1) + "%";
        }

        function fmtGain(x) {
            if (!isFinite(x) || x <= 0) return "--";
            return (x >= 100 ? x.toPrecision(4) : x.toPrecision(3)) + " ×";
        }

        function fmtDb(x) {
            if (!isFinite(x)) return "--";
            return x.toFixed(1) + " dB";
        }

        function fmtVal(x, fmt) {
            if (fmt === "pct") return fmtPct(x);
            if (fmt === "x") return fmtGain(x);
            if (fmt === "dB") return fmtDb(x);
            return fmtEng(x, ENG[fmt]);
        }

        function readVal(id, idUnit) {
            const v = parseFloat(document.getElementById(id).value);
            const mul = parseFloat(document.getElementById(idUnit).value);
            if (!isFinite(v) || !isFinite(mul) || v <= 0) return NaN;
            return v * mul;
        }

        function readPlain(id) {
            const v = parseFloat(document.getElementById(id).value);
            return isFinite(v) && v > 0 ? v : NaN;
        }

        function fmtHz(f) {
            if (!isFinite(f) || f <= 0) return "--";
            const units = [
                { v: 1e9, n: "GHz" }, { v: 1e6, n: "MHz" }, { v: 1e3, n: "kHz" }, { v: 1, n: "Hz" },
            ];
            for (const u of units) {
                if (f >= u.v) {
                    const x = f / u.v;
                    const s = x >= 100 ? x.toPrecision(4) : x.toPrecision(3);
                    return s + " " + u.n;
                }
            }
            return f.toPrecision(3) + " Hz";
        }

        /* ---------------- 滤波器（手写，结构单一） ---------------- */

        function calcRC() {
            const R = readVal("rc-R", "rc-R-unit");
            const C = readVal("rc-C", "rc-C-unit");
            const out = document.getElementById("rc-out");
            out.textContent = (isFinite(R) && isFinite(C)) ? fmtHz(1 / (PI2 * R * C)) : "--";
        }

        function calcCLC() {
            const C1 = readVal("clc-C1", "clc-C1-unit");
            const L = readVal("clc-L", "clc-L-unit");
            const C2 = readVal("clc-C2", "clc-C2-unit");
            const outSeries = document.getElementById("clc-out-series");
            const outPara = document.getElementById("clc-out-para");
            if (!isFinite(C1) || !isFinite(L) || !isFinite(C2)) {
                outSeries.textContent = "--";
                outPara.textContent = "--";
                return;
            }
            const Cser = (C1 * C2) / (C1 + C2);
            outSeries.textContent = fmtHz(1 / (PI2 * Math.sqrt(L * Cser)));
            outPara.textContent = fmtHz(1 / (PI2 * Math.sqrt(L * (C1 + C2))));
        }

        /* ---------------- 数据驱动的电路工具（本文件：电源拓扑） ---------------- */
        // 每个工具对象：{ id, title, desc, formula, note, inputs, rows, calc(vals) }
        // inputs:
        //   { label, id, type:'unit'|'percent'|'plain', unit?, def, defUnit?, suffix?, min?, optional? }
        //   type 'unit'    -> 数值 + 单位下拉（引用 UNITS[unit]）
        //   type 'percent' -> 数值 + %/比例下拉（引用 UNITS.Pct）
        //   type 'plain'   -> 仅数值（无单位），如 r、裕量系数、目标增益
        //   optional:true  -> 为空时不阻断整体计算（该输入相关的输出单独显示 --）
        // rows:
        //   { label, key, fmt:'pct'|'x'|'dB'|'H'|'F'|'A'|'V'|'ohm', margin?:true }
        //   任一行 margin:true 时表格渲染「计算值 / 裕量后」三列，否则两列
        // calc(vals) 返回 { key: 数值 }，缺项或 NaN 的行显示 --
        const SMPS = [
            {
                id: "bt", title: "Boost 升压电路设计",
                desc: "CCM 连续导通模式，输出功率按芯片效率 η 折算到输入侧设计：",
                formula:
                    "\\[D=1-\\frac{V_{in}}{V_{out}},\\quad " +
                    "I_{in}=\\frac{V_{out}I_{out}}{\\eta V_{in}},\\quad I_{L}=I_{in},\\quad " +
                    "I_{pk}=I_{L}+\\frac{\\Delta I_{L}}{2},\\quad " +
                    "L=\\frac{V_{in}D}{\\Delta I_{L}f_{sw}},\\quad C_{out}=\\frac{I_{out}D}{\\Delta V_{out}f_{sw}}\\]",
                note: "纹波电流 \\(\\Delta I_{L}=r\\cdot I_{L}\\)（r 为纹波系数），开关管/二极管耐压 \\(V_{out}\\)。η=100% 时退化为理想变换器公式。",
                inputs: [
                    { label: "V<sub>in</sub>",  id: "Vin",  type: "unit",  unit: "V",   def: 12,           defUnit: 0 },
                    { label: "V<sub>out</sub>", id: "Vout", type: "unit",  unit: "V",   def: 24,           defUnit: 0 },
                    { label: "I<sub>out</sub>", id: "Iout", type: "unit",  unit: "A",   def: 1,            defUnit: 1 },
                    { label: "f<sub>sw</sub>",  id: "fsw",  type: "unit",  unit: "Hz",  def: 100,          defUnit: 1 },
                    { label: "r",               id: "r",    type: "plain", def: 0.3,   suffix: "ΔI<sub>L</sub>/I<sub>L</sub>" },
                    { label: "ΔV<sub>out</sub>", id: "dV",  type: "unit",  unit: "V",   def: 50,           defUnit: 1, mV: true },
                    { label: "η 效率",          id: "eta",  type: "percent", unit: "Pct", def: 90,        defUnit: 0 },
                    { label: "裕量系数",        id: "margin", type: "plain", def: 1.2,  suffix: "×", min: 1 },
                ],
                rows: [
                    { label: "占空比 D",                  key: "D",   fmt: "pct", margin: false },
                    { label: "电感 L",                    key: "L",   fmt: "H",   margin: true },
                    { label: "电感平均电流 I<sub>L</sub>", key: "IL",  fmt: "A",   margin: true },
                    { label: "电感峰值电流 I<sub>pk</sub>", key: "Ipk", fmt: "A",  margin: true },
                    { label: "输出电容 C<sub>out</sub>",   key: "C",   fmt: "F",   margin: true },
                    { label: "开关管/二极管耐压 = V<sub>out</sub>", key: "V", fmt: "V", margin: true },
                ],
                calc(o) {
                    const D = 1 - o.Vin / o.Vout;
                    const ok = [o.Vin, o.Vout, o.Iout, o.fsw, o.r, o.dV, o.eta].every(isFinite) && D > 0 && D < 1;
                    if (!ok) return null;
                    const IL = o.Vout * o.Iout / (o.eta * o.Vin);  // 输入侧电感电流，含效率
                    const dIL = o.r * IL;
                    return {
                        D, L: o.Vin * D / (dIL * o.fsw),
                        IL, Ipk: IL + dIL / 2,
                        C: o.Iout * D / (o.dV * o.fsw),
                        V: o.Vout,
                    };
                },
            },
            {
                id: "sp", title: "SEPIC 电路设计",
                desc: "CCM 连续导通模式，输出功率按芯片效率 η 折算到输入侧设计：",
                formula:
                    "\\[D=\\frac{V_{out}}{V_{out}+V_{in}},\\quad " +
                    "I_{L1}=\\frac{V_{out}I_{out}}{\\eta V_{in}},\\quad I_{L2}=I_{out},\\quad " +
                    "I_{pk}=I_{L}+\\frac{\\Delta I_{L}}{2},\\quad " +
                    "L_{1}=\\frac{V_{in}D}{\\Delta I_{L1}f_{sw}},\\quad L_{2}=\\frac{V_{in}D}{\\Delta I_{L2}f_{sw}},\\quad " +
                    "C_{1}=\\frac{I_{out}D}{\\Delta V_{C1}f_{sw}},\\quad C_{2}=\\frac{I_{out}D}{\\Delta V_{out}f_{sw}}\\]",
                note: "纹波电流 \\(\\Delta I_{L}=r\\cdot I_{L}\\)，开关管/二极管耐压 \\(V_{in}+V_{out}\\)。η=100% 时退化为理想变换器公式。",
                inputs: [
                    { label: "V<sub>in</sub>",      id: "Vin",   type: "unit", unit: "V",   def: 12,   defUnit: 0 },
                    { label: "V<sub>out</sub>",     id: "Vout",  type: "unit", unit: "V",   def: 12,   defUnit: 0 },
                    { label: "I<sub>out</sub>",     id: "Iout",  type: "unit", unit: "A",   def: 1,    defUnit: 1 },
                    { label: "f<sub>sw</sub>",      id: "fsw",   type: "unit", unit: "Hz",  def: 100,  defUnit: 1 },
                    { label: "r",                   id: "r",     type: "plain", def: 0.3,  suffix: "ΔI<sub>L</sub>/I<sub>L</sub>" },
                    { label: "ΔV<sub>out</sub>",    id: "dV",    type: "unit", unit: "V",   def: 50,   defUnit: 1, mV: true },
                    { label: "ΔV<sub>C1</sub>",     id: "dVc",   type: "unit", unit: "V",   def: 100,  defUnit: 1, mV: true },
                    { label: "η 效率",              id: "eta",   type: "percent", unit: "Pct", def: 90, defUnit: 0 },
                    { label: "裕量系数",            id: "margin", type: "plain", def: 1.2,  suffix: "×", min: 1 },
                ],
                rows: [
                    { label: "占空比 D",                  key: "D",   fmt: "pct", margin: false },
                    { label: "电感 L1",                   key: "L1",  fmt: "H",   margin: true },
                    { label: "电感 L2",                   key: "L2",  fmt: "H",   margin: true },
                    { label: "耦合电容 C1",               key: "C1",  fmt: "F",   margin: true },
                    { label: "输出电容 C2",               key: "C2",  fmt: "F",   margin: true },
                    { label: "L1 峰值电流",               key: "Ipk1", fmt: "A",  margin: true },
                    { label: "L2 峰值电流",               key: "Ipk2", fmt: "A",  margin: true },
                    { label: "开关管/二极管耐压 = V<sub>in</sub>+V<sub>out</sub>", key: "V", fmt: "V", margin: true },
                ],
                calc(o) {
                    const D = o.Vout / (o.Vout + o.Vin);
                    const ok = [o.Vin, o.Vout, o.Iout, o.fsw, o.r, o.dV, o.dVc, o.eta].every(isFinite) && D > 0 && D < 1;
                    if (!ok) return null;
                    const IL1 = o.Vout * o.Iout / (o.eta * o.Vin);  // 输入侧电感
                    const IL2 = o.Iout;                              // 输出侧电感
                    const dIL1 = o.r * IL1;
                    const dIL2 = o.r * IL2;
                    return {
                        D, L1: o.Vin * D / (dIL1 * o.fsw), L2: o.Vin * D / (dIL2 * o.fsw),
                        C1: o.Iout * D / (o.dVc * o.fsw), C2: o.Iout * D / (o.dV * o.fsw),
                        Ipk1: IL1 + dIL1 / 2, Ipk2: IL2 + dIL2 / 2,
                        V: o.Vin + o.Vout,
                    };
                },
            },
            {
                id: "bk", title: "Buck 降压电路设计",
                desc: "CCM 连续导通模式，输出功率按芯片效率 η 折算到输入侧设计：",
                formula:
                    "\\[D=\\frac{V_{out}}{V_{in}},\\quad " +
                    "I_{L}=I_{out},\\quad I_{in}=\\frac{V_{out}I_{out}}{\\eta V_{in}},\\quad " +
                    "I_{pk}=I_{L}+\\frac{\\Delta I_{L}}{2},\\quad " +
                    "L=\\frac{(V_{in}-V_{out})D}{\\Delta I_{L}f_{sw}},\\quad C_{out}=\\frac{\\Delta I_{L}}{8\\Delta V_{out}f_{sw}}\\]",
                note: "Buck 的电感在输出侧，纹波电流 \\(\\Delta I_{L}=r\\cdot I_{L}\\)。输入电流 \\(I_{in}\\) 由效率折算，用于估算输入侧要求；开关管/二极管耐压 \\(V_{in}\\)。η=100% 时退化为理想变换器公式。",
                inputs: [
                    { label: "V<sub>in</sub>",  id: "Vin",  type: "unit",  unit: "V",   def: 12,  defUnit: 0 },
                    { label: "V<sub>out</sub>", id: "Vout", type: "unit",  unit: "V",   def: 5,   defUnit: 0 },
                    { label: "I<sub>out</sub>", id: "Iout", type: "unit",  unit: "A",   def: 2,   defUnit: 1 },
                    { label: "f<sub>sw</sub>",  id: "fsw",  type: "unit",  unit: "Hz",  def: 100, defUnit: 1 },
                    { label: "r",               id: "r",    type: "plain", def: 0.3,   suffix: "ΔI<sub>L</sub>/I<sub>L</sub>" },
                    { label: "ΔV<sub>out</sub>", id: "dV",  type: "unit",  unit: "V",   def: 50,  defUnit: 1, mV: true },
                    { label: "η 效率",          id: "eta",  type: "percent", unit: "Pct", def: 90, defUnit: 0 },
                    { label: "裕量系数",        id: "margin", type: "plain", def: 1.2,  suffix: "×", min: 1 },
                ],
                rows: [
                    { label: "占空比 D",                   key: "D",   fmt: "pct", margin: false },
                    { label: "电感 L",                     key: "L",   fmt: "H",   margin: true },
                    { label: "电感平均电流 I<sub>L</sub>", key: "IL",  fmt: "A",   margin: true },
                    { label: "电感峰值电流 I<sub>pk</sub>", key: "Ipk", fmt: "A",  margin: true },
                    { label: "输入平均电流 I<sub>in</sub>", key: "Iin", fmt: "A",  margin: true },
                    { label: "输出电容 C<sub>out</sub>",   key: "C",   fmt: "F",   margin: true },
                    { label: "开关管/二极管耐压 = V<sub>in</sub>", key: "V", fmt: "V", margin: true },
                ],
                calc(o) {
                    const D = o.Vout / o.Vin;
                    const ok = [o.Vin, o.Vout, o.Iout, o.fsw, o.r, o.dV, o.eta].every(isFinite) && D > 0 && D < 1;
                    if (!ok) return null;
                    const IL = o.Iout;                    // 输出侧电感，与效率无关
                    const dIL = o.r * IL;
                    const Iin = o.Vout * o.Iout / (o.eta * o.Vin);  // 输入侧电流，含效率
                    return {
                        D, L: (o.Vin - o.Vout) * D / (dIL * o.fsw),
                        IL, Ipk: IL + dIL / 2, Iin,
                        C: dIL / (8 * o.fsw * o.dV),
                        V: o.Vin,
                    };
                },
            },
            {
                id: "bb", title: "Buck-Boost 电路设计",
                desc: "CCM 连续导通模式、反相输出（V<sub>out</sub> 取幅值），输出功率按芯片效率 η 折算到输入侧设计：",
                formula:
                    "\\[D=\\frac{V_{out}}{V_{out}+V_{in}},\\quad " +
                    "I_{L}=\\frac{V_{out}I_{out}}{\\eta V_{in}},\\quad " +
                    "I_{pk}=I_{L}+\\frac{\\Delta I_{L}}{2},\\quad " +
                    "L=\\frac{V_{in}D}{\\Delta I_{L}f_{sw}},\\quad C_{out}=\\frac{I_{out}D}{\\Delta V_{out}f_{sw}}\\]",
                note: "电感平均电流 \\(I_{L}=\\dfrac{V_{out}I_{out}}{\\eta V_{in}}\\)，纹波电流 \\(\\Delta I_{L}=r\\cdot I_{L}\\)，开关管/二极管耐压 \\(V_{in}+V_{out}\\)。η=100% 时退化为理想变换器公式。",
                inputs: [
                    { label: "V<sub>in</sub>",  id: "Vin",  type: "unit",  unit: "V",   def: 12,   defUnit: 0 },
                    { label: "V<sub>out</sub>", id: "Vout", type: "unit",  unit: "V",   def: 12,   defUnit: 0 },
                    { label: "I<sub>out</sub>", id: "Iout", type: "unit",  unit: "A",   def: 1,    defUnit: 1 },
                    { label: "f<sub>sw</sub>",  id: "fsw",  type: "unit",  unit: "Hz",  def: 100,  defUnit: 1 },
                    { label: "r",               id: "r",    type: "plain", def: 0.3,   suffix: "ΔI<sub>L</sub>/I<sub>L</sub>" },
                    { label: "ΔV<sub>out</sub>", id: "dV",  type: "unit",  unit: "V",   def: 50,   defUnit: 1, mV: true },
                    { label: "η 效率",          id: "eta",  type: "percent", unit: "Pct", def: 90,  defUnit: 0 },
                    { label: "裕量系数",        id: "margin", type: "plain", def: 1.2,  suffix: "×", min: 1 },
                ],
                rows: [
                    { label: "占空比 D",                   key: "D",   fmt: "pct", margin: false },
                    { label: "电感 L",                     key: "L",   fmt: "H",   margin: true },
                    { label: "电感平均电流 I<sub>L</sub>", key: "IL",  fmt: "A",   margin: true },
                    { label: "电感峰值电流 I<sub>pk</sub>", key: "Ipk", fmt: "A",  margin: true },
                    { label: "输出电容 C<sub>out</sub>",   key: "C",   fmt: "F",   margin: true },
                    { label: "开关管/二极管耐压 = V<sub>in</sub>+V<sub>out</sub>", key: "V", fmt: "V", margin: true },
                ],
                calc(o) {
                    const D = o.Vout / (o.Vout + o.Vin);
                    const ok = [o.Vin, o.Vout, o.Iout, o.fsw, o.r, o.dV, o.eta].every(isFinite) && D > 0 && D < 1;
                    if (!ok) return null;
                    const IL = o.Vout * o.Iout / (o.eta * o.Vin);  // 输入侧电感电流，含效率
                    const dIL = o.r * IL;
                    return {
                        D, L: o.Vin * D / (dIL * o.fsw),
                        IL, Ipk: IL + dIL / 2,
                        C: o.Iout * D / (o.dV * o.fsw),
                        V: o.Vin + o.Vout,
                    };
                },
            },
            {
                id: "ck", title: "Cuk 电路设计",
                desc: "CCM 连续导通模式、反相输出（V<sub>out</sub> 取幅值），输出功率按芯片效率 η 折算到输入侧设计：",
                formula:
                    "\\[D=\\frac{V_{out}}{V_{out}+V_{in}},\\quad " +
                    "I_{L1}=\\frac{V_{out}I_{out}}{\\eta V_{in}},\\quad I_{L2}=I_{out},\\quad " +
                    "I_{pk}=I_{L}+\\frac{\\Delta I_{L}}{2},\\quad " +
                    "L_{1}=\\frac{V_{in}D}{\\Delta I_{L1}f_{sw}},\\quad L_{2}=\\frac{V_{in}D}{\\Delta I_{L2}f_{sw}},\\quad " +
                    "C_{1}=\\frac{I_{out}D}{\\Delta V_{C1}f_{sw}},\\quad C_{2}=\\frac{I_{out}D}{\\Delta V_{out}f_{sw}}\\]",
                note: "纹波电流 \\(\\Delta I_{L}=r\\cdot I_{L}\\)，开关管/二极管耐压 \\(V_{in}+V_{out}\\)。η=100% 时退化为理想变换器公式。",
                inputs: [
                    { label: "V<sub>in</sub>",      id: "Vin",   type: "unit", unit: "V",   def: 12,   defUnit: 0 },
                    { label: "V<sub>out</sub>",     id: "Vout",  type: "unit", unit: "V",   def: 12,   defUnit: 0 },
                    { label: "I<sub>out</sub>",     id: "Iout",  type: "unit", unit: "A",   def: 1,    defUnit: 1 },
                    { label: "f<sub>sw</sub>",      id: "fsw",   type: "unit", unit: "Hz",  def: 100,  defUnit: 1 },
                    { label: "r",                   id: "r",     type: "plain", def: 0.3,  suffix: "ΔI<sub>L</sub>/I<sub>L</sub>" },
                    { label: "ΔV<sub>out</sub>",    id: "dV",    type: "unit", unit: "V",   def: 50,   defUnit: 1, mV: true },
                    { label: "ΔV<sub>C1</sub>",     id: "dVc",   type: "unit", unit: "V",   def: 100,  defUnit: 1, mV: true },
                    { label: "η 效率",              id: "eta",   type: "percent", unit: "Pct", def: 90, defUnit: 0 },
                    { label: "裕量系数",            id: "margin", type: "plain", def: 1.2,  suffix: "×", min: 1 },
                ],
                rows: [
                    { label: "占空比 D",                  key: "D",   fmt: "pct", margin: false },
                    { label: "电感 L1",                   key: "L1",  fmt: "H",   margin: true },
                    { label: "电感 L2",                   key: "L2",  fmt: "H",   margin: true },
                    { label: "耦合电容 C1",               key: "C1",  fmt: "F",   margin: true },
                    { label: "输出电容 C2",               key: "C2",  fmt: "F",   margin: true },
                    { label: "L1 峰值电流",               key: "Ipk1", fmt: "A",  margin: true },
                    { label: "L2 峰值电流",               key: "Ipk2", fmt: "A",  margin: true },
                    { label: "开关管/二极管耐压 = V<sub>in</sub>+V<sub>out</sub>", key: "V", fmt: "V", margin: true },
                ],
                calc(o) {
                    const D = o.Vout / (o.Vout + o.Vin);
                    const ok = [o.Vin, o.Vout, o.Iout, o.fsw, o.r, o.dV, o.dVc, o.eta].every(isFinite) && D > 0 && D < 1;
                    if (!ok) return null;
                    const IL1 = o.Vout * o.Iout / (o.eta * o.Vin);  // 输入侧电感
                    const IL2 = o.Iout;                              // 输出侧电感
                    const dIL1 = o.r * IL1;
                    const dIL2 = o.r * IL2;
                    return {
                        D, L1: o.Vin * D / (dIL1 * o.fsw), L2: o.Vin * D / (dIL2 * o.fsw),
                        C1: o.Iout * D / (o.dVc * o.fsw), C2: o.Iout * D / (o.dV * o.fsw),
                        Ipk1: IL1 + dIL1 / 2, Ipk2: IL2 + dIL2 / 2,
                        V: o.Vin + o.Vout,
                    };
                },
            },
        ];

        /* ---------------- 通用渲染器 ---------------- */

        function unitOptions(key, idx) {
            return UNITS[key].map((o, i) =>
                `<option value="${o.v}"${i === idx ? " selected" : ""}>${o.n}</option>`).join("");
        }

        function fieldHtml(c, f) {
            const id = c.id + "-" + f.id;
            if (f.type === "plain") {
                return `<div class="calc-row"><label>${f.label}</label>
                    <input class="calc-input" id="${id}" type="number" value="${f.def}" min="${f.min ?? 0}" step="any" inputmode="decimal">
                    <span class="calc-unit" style="cursor: default;">${f.suffix || ""}</span></div>`;
            }
            if (f.type === "percent") {
                return `<div class="calc-row"><label>${f.label}</label>
                    <input class="calc-input" id="${id}" type="number" value="${f.def}" min="0" step="any" inputmode="decimal">
                    <select class="calc-unit" id="${id}-unit">${unitOptions(f.unit, f.defUnit)}</select></div>`;
            }
            // type === "unit"
            return `<div class="calc-row"><label>${f.label}</label>
                <input class="calc-input" id="${id}" type="number" value="${f.def}" min="0" step="any" inputmode="decimal">
                <select class="calc-unit" id="${id}-unit">${unitOptions(f.unit, f.defUnit)}</select></div>`;
        }

        // 只要有一个输出行声明 margin，该工具的表格就带「裕量后」列（三列）；否则两列
        function hasMarginCol(c) {
            return c.rows.some(r => r.margin);
        }

        function rowHtml(c, r, withMargin) {
            const id = c.id + "-" + r.key;
            const vCell = `<td><b id="${id}">--</b></td>`;
            let extra = "";
            if (withMargin) {
                extra = r.margin ? `<td><b id="${id}-M">--</b></td>` : "<td>—</td>";
            }
            return `<tr><td>${r.label}</td>${vCell}${extra}</tr>`;
        }

        function buildSection(c) {
            const s = document.createElement("section");
            const withMargin = hasMarginCol(c);
            const inputsHtml = c.inputs.map(f => fieldHtml(c, f)).join("");
            const header = withMargin
                ? `<tr><th>参数</th><th>计算值</th><th>裕量后</th></tr>`
                : `<tr><th>参数</th><th>数值</th></tr>`;
            const rowsHtml = c.rows.map(r => rowHtml(c, r, withMargin)).join("");
            s.innerHTML = `
                <h3 class="section-title">${c.title}</h3>
                <div class="section_content">
                    <p>${c.desc}</p>
                    <p>${c.formula}</p>
                    <p class="centered">${c.note}</p>
                    <hr>
                    ${inputsHtml}
                    <hr>
                    <table>${header}${rowsHtml}</table>
                </div>`;
            return s;
        }

        function readField(c, f) {
            const id = c.id + "-" + f.id;
            return f.type === "plain" ? readPlain(id) : readVal(id, id + "-unit");
        }

        function runTool(c) {
            const vals = {};
            let ok = true;
            for (const f of c.inputs) {
                vals[f.id] = readField(c, f);
                if (!f.optional && !isFinite(vals[f.id])) ok = false;  // 可选输入（如目标增益）为空不阻断
            }
            const margin = isFinite(vals.margin) ? vals.margin : 1;
            const res = ok ? c.calc(vals) : null;
            const withMargin = hasMarginCol(c);
            for (const r of c.rows) {
                const el = document.getElementById(c.id + "-" + r.key);
                if (!el) continue;
                const elM = (withMargin && r.margin) ? document.getElementById(c.id + "-" + r.key + "-M") : null;
                if (!res) { el.textContent = "--"; if (elM) elM.textContent = "--"; continue; }
                el.textContent = fmtVal(res[r.key], r.fmt);
                if (elM) elM.textContent = fmtVal(res[r.key] * margin, r.fmt);
            }
        }

        // 通用注册：把一个工具定义数组渲染进 rootId 容器，绑定输入并首次计算。
        // 供本文件与其它模块（如 amp.js）复用。
        function registerCircuits(defs, rootId) {
            const root = document.getElementById(rootId);
            if (!root) return;
            for (const c of defs) {
                root.appendChild(buildSection(c));
                c.inputs.forEach(f => {
                    const id = c.id + "-" + f.id;
                    document.getElementById(id).addEventListener("input", () => runTool(c));
                    document.getElementById(id).addEventListener("change", () => runTool(c));
                    if (f.type !== "plain") {
                        const u = document.getElementById(id + "-unit");
                        u.addEventListener("input", () => runTool(c));
                        u.addEventListener("change", () => runTool(c));
                    }
                });
                runTool(c);
            }
            // 重新排版动态注入的公式
            if (window.MathJax && MathJax.typesetPromise) {
                MathJax.typesetPromise([root]);
            }
        }

        function init() {
            // 滤波器（手写）
            const filterBind = (ids, fn) => ids.forEach(id => {
                const el = document.getElementById(id);
                el.addEventListener("input", fn);
                el.addEventListener("change", fn);
            });
            filterBind(["rc-R", "rc-R-unit", "rc-C", "rc-C-unit"], calcRC);
            filterBind(["clc-C1", "clc-C1-unit", "clc-L", "clc-L-unit", "clc-C2", "clc-C2-unit"], calcCLC);
            calcRC();
            calcCLC();

            // 电源拓扑（数据驱动）
            registerCircuits(SMPS, "smps-root");
        }

        init();
