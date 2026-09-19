"use strict";

/*
 * 放大器电路计算（数据驱动），复用 smps.js 中的通用引擎：
 *   registerCircuits(defs, rootId)、UNITS / ENG、字段与格式化辅助函数。
 * 加载顺序必须在 smps.js 之后（见 index.html）。
 *
 * 公式依据：Analog Devices MT-062（双运放）、MT-063 / AD620（三运放）、
 * MT-061（差放 CMRR 与电阻容差关系）。均为 CCM 之外的小信号增益设计。
 */

const AMPS = [
    {
        id: "ia3", title: "标准三运放仪表放大器设计",
        desc: "经典三运放仪表放大器（AD620 结构）：第一级两个缓冲运放承担差分增益，第二级差放消除共模。",
        formula:
            "\\[G=\\left(1+\\frac{2R_1}{R_g}\\right)\\frac{R_3}{R_2},\\qquad " +
            "R_g=\\frac{2R_1}{G\\,R_2/R_3-1}\\]",
        note: "第二级增益为 \\(R_3/R_2\\)，工程上通常取 \\(R_2=R_3\\) 使其为单位增益，此时 \\(G=1+2R_1/R_g\\)（AD620 即 \\(G=1+49.4\\,\\mathrm{k}\\Omega/R_g\\)）。共模抑制比由第二级电阻容差决定：\\(\\mathrm{CMRR}\\approx\\dfrac{1+G_2}{4t}\\)。",
        inputs: [
            { label: "R<sub>1</sub>", id: "R1", type: "unit", unit: "ohm", def: 25, defUnit: 1 },
            { label: "R<sub>g</sub>", id: "Rg", type: "unit", unit: "ohm", def: 500, defUnit: 0 },
            { label: "R<sub>2</sub>", id: "R2", type: "unit", unit: "ohm", def: 10, defUnit: 1 },
            { label: "R<sub>3</sub>", id: "R3", type: "unit", unit: "ohm", def: 10, defUnit: 1 },
            { label: "电阻容差 t", id: "tol", type: "percent", unit: "Pct", def: 1, defUnit: 0 },
            { label: "目标增益", id: "Gt", type: "plain", def: 100, suffix: "×", optional: true },
        ],
        rows: [
            { label: "第二级增益 R<sub>3</sub>/R<sub>2</sub>", key: "G2", fmt: "x" },
            { label: "总增益 G", key: "G", fmt: "x" },
            { label: "总增益", key: "GdB", fmt: "dB" },
            { label: "达到目标增益所需 R<sub>g</sub>", key: "RgReq", fmt: "ohm" },
            { label: "CMRR 下限（受电阻容差限制）", key: "CMRR", fmt: "dB" },
        ],
        calc(o) {
            const ok = [o.R1, o.Rg, o.R2, o.R3, o.tol].every(isFinite);
            if (!ok) return null;
            const G2 = o.R3 / o.R2;
            const G = (1 + 2 * o.R1 / o.Rg) * G2;
            const GdB = 20 * Math.log10(G);
            // 由目标增益反解 Rg：G = (1 + 2R1/Rg)·G2  →  Rg = 2R1 / (G/G2 - 1)
            const RgReq = isFinite(o.Gt) && o.Gt > G2 ? 2 * o.R1 / (o.Gt / G2 - 1) : NaN;
            const CMRR = 20 * Math.log10((1 + G2) / (4 * o.tol));
            return { G2, G, GdB, RgReq, CMRR };
        },
    },
    {
        id: "ia2", title: "双运放仪表放大器设计",
        desc: "经典双运放仪表放大器（ADI MT-062 结构）：A<sub>1</sub> 同相端接 V<sub>1</sub>、A<sub>2</sub> 同相端接 V<sub>2</sub>，R<sub>g</sub> 跨接在 A<sub>1</sub>、A<sub>2</sub> 的反相端之间；两级电阻比例须严格匹配。",
        formula:
            "\\[G=1+\\frac{R_2}{R_1}+\\frac{2R_2}{R_g},\\qquad " +
            "R_g=\\frac{2R_2}{G-1-R_2/R_1}\\]",
        note: "R_g 开路时增益下限为 \\(1+R_2/R_1\\)，故该拓扑不能衰减、增益恒大于 1（ADI 建议最低增益取 5）。共模抑制比受两级比例失配 m 限制：\\(\\mathrm{CMRR}\\approx 20\\log_{10}(G/m)\\)，故交流 CMRR 明显弱于三运放结构。",
        inputs: [
            { label: "R<sub>1</sub>", id: "R1", type: "unit", unit: "ohm", def: 10, defUnit: 1 },
            { label: "R<sub>2</sub>", id: "R2", type: "unit", unit: "ohm", def: 10, defUnit: 1 },
            { label: "R<sub>g</sub>", id: "Rg", type: "unit", unit: "ohm", def: 2, defUnit: 1 },
            { label: "比例失配 m", id: "mis", type: "percent", unit: "Pct", def: 0.1, defUnit: 0 },
            { label: "目标增益", id: "Gt", type: "plain", def: 10, suffix: "×", optional: true },
        ],
        rows: [
            { label: "增益下限（R<sub>g</sub> 开路）", key: "Gmin", fmt: "x" },
            { label: "总增益 G", key: "G", fmt: "x" },
            { label: "总增益", key: "GdB", fmt: "dB" },
            { label: "达到目标增益所需 R<sub>g</sub>", key: "RgReq", fmt: "ohm" },
            { label: "CMRR 下限（受比例失配限制）", key: "CMRR", fmt: "dB" },
        ],
        calc(o) {
            const ok = [o.R1, o.R2, o.Rg, o.mis].every(isFinite);
            if (!ok) return null;
            const Gmin = 1 + o.R2 / o.R1;
            const G = Gmin + 2 * o.R2 / o.Rg;
            const GdB = 20 * Math.log10(G);
            // 由目标增益反解 Rg：G = 1 + R2/R1 + 2R2/Rg  →  Rg = 2R2 / (G - 1 - R2/R1)
            const RgReq = isFinite(o.Gt) && o.Gt > Gmin ? 2 * o.R2 / (o.Gt - Gmin) : NaN;
            const CMRR = 20 * Math.log10(G / o.mis);
            return { Gmin, G, GdB, RgReq, CMRR };
        },
    },
];

registerCircuits(AMPS, "amp-root");
