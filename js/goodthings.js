const goodthings = [
  {
    title: "C++ memory order以及cpu真正结构",
    href: "https://zhuanlan.zhihu.com/p/682286231",
  },
  {
    title: "VA滤波器设计.pdf",
    href: "https://www.native-instruments.com/fileadmin/ni_media/downloads/pdf/VAFilterDesign_2.1.2.pdf",
  },
  {
    title: "katjaas dsp",
    href: "https://www.katjaas.nl/home/home.html",
  },
  {
    title: "MPEX时间拉伸/音高移动，见识一下相位保留完好的",
    href: "http://mpex.prosoniq.com/",
  },
  {
    title: "开源Autotune",
    href: "https://github.com/liuanlin-mx/MXTune",
  },
  {
    title: "早期的音高移动/时间拉伸算法大比拼",
    href: "https://web.archive.org/web/20260120145824/https://fr.audiofanzine.com/pitch-shifter-time-stretcher/editorial/dossiers/de-l-etirement-et-de-la-hauteur-partie-1.html",
  },
];

const goodthings_tbody = document.getElementById("goodthings-tbody");
for (const item of goodthings) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  const a = document.createElement("a");
  a.href = item.href;
  a.target = "_blank";
  a.textContent = item.title;
  td.appendChild(a);
  tr.appendChild(td);
  goodthings_tbody.appendChild(tr);
}
