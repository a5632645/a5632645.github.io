const dspPages = [
  {
    update_date: "2026-7-13",
    title: "DSP collection",
    href: "dsp/dsp/index.html",
  },
  {
    update_date: "2025-12-11",
    title: "滤波器设计学习",
    href: "dsp/filter-design/main.html",
    img: "dsp/filter-design/pzmap-analog-cheb2.png"
  },
  {
    update_date: "2025-12-28",
    title: "TPT滤波器设计总结",
    href: "dsp/tpt-filter/index.html",
    img: "dsp/tpt-filter/1pole.png"
  },
  {
    update_date: "2025-11-1",
    title: "另一种频率响应计算",
    href: "dsp/another_frequency_responce/another_filter_responce.html",
    img: "dsp/another_frequency_responce/match_biquad_calc.png",
  },
  {
    update_date: "2026-4-25",
    title: "IIR滤波器的线性相位补偿",
    href: "dsp/reverse_iir/index.html",
  },
  {
    update_date: "2025-6-1",
    title: "实时Burg线性预测",
    href: "dsp/burg/burg.html",
  },
];

const mcuPages = [
  {
    update_date: "2026-5-5",
    title: "玩 rtthread titan mini",
    href: "mcu/titan_mini/index.html",
    img: "mcu/titan_mini/program_gui.png"
  },
  {
    update_date: "2026-5-13",
    title: "mcu工程模板",
    href: "mcu/mcu_template/index.html",
  },
  {
    update_date: "2026-1-10",
    title: "usb学习记录",
    href: "mcu/usb/index.html",
  },
  {
    update_date: "2025-12-15",
    title: "gd32h757hzmt6 IPA调教",
    href: "mcu/gd32_ipa/index.html",
    img: "mcu/gd32_ipa/lvgl_file.png"
  },
  {
    update_date: "2025-7-1",
    title: "制作一个usb-midi转换器",
    href: "mcu/usb-midi/main.html",
    img: "mcu/usb-midi/midi-rx.png"
  },
  {
    update_date: "2025-7-1",
    title: "单片机",
    href: "mcu/mcu/mcu.html",
  },
];

const othersPages = [
  {
    update_date: "2025-11-1",
    title: "zed cmake 任务脚本",
    href: "others/zed_cmake_script/index.html",
    img: "others/zed_cmake_script/debug.png",
  },
  {
    update_date: "2026-8-4",
    title: "windows & vscode",
    href: "others/tricks/index.html",
    img: "others/tricks/vscode_bg.png"
  },
];

function renderCards(containerId, items) {
  const grid = document.getElementById(containerId);
  const sorted = [...items].sort((a, b) => {
    const [ay, am, ad] = a.update_date.split("-").map(Number);
    const [by, bm, bd] = b.update_date.split("-").map(Number);
    return (by - ay) || (bm - am) || (bd - ad);
  });

  for (const item of sorted) {
    const card = document.createElement("a");
    card.className = "dsp-card";
    card.href = item.href;

    const imgDiv = document.createElement("div");
    imgDiv.className = "dsp-card-img";
    if (item.img) {
      const img = document.createElement("img");
      img.src = item.img;
      img.alt = item.title;
      imgDiv.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "dsp-card-img-ph";
      ph.textContent = "no img";
      imgDiv.appendChild(ph);
    }
    card.appendChild(imgDiv);

    const body = document.createElement("div");
    body.className = "dsp-card-body";

    const name = document.createElement("div");
    name.className = "dsp-card-name";
    name.textContent = item.title;
    body.appendChild(name);

    const date = document.createElement("div");
    date.className = "dsp-card-date";
    date.textContent = item.update_date;
    body.appendChild(date);

    card.appendChild(body);
    grid.appendChild(card);
  }
}

renderCards("dsp-grid", dspPages);
renderCards("mcu-grid", mcuPages);
renderCards("others-grid", othersPages);
