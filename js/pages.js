const pages = [
  {
    create_date: "2026-5-4",
    update_date: "2026-5-5",
    title: "玩 rtthread titan mini",
    href: "2026/titan_mini/index.html"
  },
  {
    create_date: "2026-4-25",
    update_date: "2026-4-25",
    title: "IIR滤波器的线性相位补偿",
    href: "2026/reverse_iir/index.html",
  },
  {
    create_date: "2026-4-11",
    update_date: "2026-5-13",
    title: "mcu工程模板",
    href: "2026/mcu_template/index.html",
  },
  {
    create_date: "2025-12-17",
    update_date: "2026-1-10",
    title: "usb学习记录",
    href: "2025/usb/index.html",
  },
  {
    create_date: "2025-12-07",
    update_date: "2025-12-15",
    title: "gd32h757hzmt6 IPA调教",
    href: "2025/gd32_ipa/index.html",
  },
  {
    create_date: "2025-11-1",
    update_date: "2025-11-1",
    title: "zed cmake 任务脚本",
    href: "2025/zed_cmake_script/index.html",
  },
  {
    create_date: "2025-11-1",
    update_date: "2025-11-1",
    title: "另一种频率响应计算",
    href: "2025/another_frequency_responce/another_filter_responce.html",
  },
  {
    create_date: "2025-11-1",
    update_date: "2025-12-28",
    title: "TPT滤波器设计总结",
    href: "2025/tpt-filter/index.html",
  },
  {
    create_date: "2025-8-1",
    update_date: "2025-12-11",
    title: "滤波器设计学习",
    href: "2025/filter-design/main.html",
  },
  {
    create_date: "2025-7-1",
    update_date: "2025-7-1",
    title: "制作一个usb-midi转换器",
    href: "2025/usb-midi/main.html",
  },
  {
    create_date: "2025-7-1",
    update_date: "2025-7-1",
    title: "单片机",
    href: "2025/mcu/mcu.html",
  },
  {
    create_date: "2025-7-1",
    update_date: "2025-7-1",
    title: "Legacy DSP",
    href: "2025/dsp/dsp.html",
  },
  {
    create_date: "2025-6-1",
    update_date: "2025-6-1",
    title: "windows技巧",
    href: "2025/windows/windows.html",
  },
  {
    create_date: "2025-6-1",
    update_date: "2025-6-1",
    title: "实时Burg线性预测",
    href: "2025/burg/burg.html",
  },
];

const pages_tbody = document.getElementById("pages-tbody");

for (const item of pages) {
  const tr = document.createElement("tr");

  const td_create = document.createElement("td");
  td_create.textContent = item.create_date;
  tr.appendChild(td_create);

  const td_update = document.createElement("td");
  td_update.textContent = item.update_date;
  tr.appendChild(td_update);

  const td_desc = document.createElement("td");
  const a = document.createElement("a");
  a.href = item.href;
  a.textContent = item.title;
  td_desc.appendChild(a);
  tr.appendChild(td_desc);

  const td_delta = document.createElement("td");
  const date_arr = item.update_date.split("-");
  const year = date_arr[0];
  const month = date_arr[1];
  const day = date_arr[2];
  const date = new Date(year, month - 1, day);
  const current_date = new Date();
  const delta_date = Math.abs(current_date.getTime() - date.getTime());
  const delta_days = Math.floor(delta_date / (1000 * 60 * 60 * 24));
  td_delta.textContent = `${delta_days} days`;
  if (delta_days < 30) {
    td_delta.style.color = "green";
  } else if (delta_days < 60) {
    td_delta.style.color = "#806610";
  } else if (delta_days < 90) {
    td_delta.style.color = "grey";
  } else {
    td_delta.style.color = "black";
  }
  tr.appendChild(td_delta);

  pages_tbody.appendChild(tr);
}

const rows = Array.from(pages_tbody.querySelectorAll("tr"));
rows.sort((a, b) => {
  const delta_a = parseInt(a.children[3].textContent);
  const delta_b = parseInt(b.children[3].textContent);
  return delta_a - delta_b;
});
pages_tbody.innerHTML = "";
for (const row of rows) {
  pages_tbody.appendChild(row);
}
