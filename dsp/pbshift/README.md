# pbshift 浏览器 Demo

页面通过 AudioWorklet 调用 pbshift 的双声道实时引擎。用 HTTPS 或 localhost 访问，选择本地文件或启动麦克风即可试听。移调范围为 ±24 半音，文件和麦克风都保持原有速度。

## 重新构建 WebAssembly

使用 Emscripten 4.0.23。先按 [pbshift 的依赖目录结构](https://github.com/pbtechlab/pbshift#building)检出以下版本。

| 组件 | 提交 |
| --- | --- |
| pbshift | `fe4314bae720c844a0d009e94cf330c7772b82f1` |
| pffft | `fbe9c2b96530ce274f12e008336a8202e15b859b` |
| Signalsmith Linear | `de55e6a50ffcf6f8f43f649692d94691c7025151` |

启用 Emscripten 环境后，在 PowerShell 中运行以下命令。脚本会在页面目录生成 `pbshift.wasm`。目标浏览器需要支持 WebAssembly SIMD。

```powershell
./dsp/pbshift/build.ps1 -PbshiftSource C:/src/pbshift
```

授权信息见 [pbshift LICENSE](LICENSE)、[第三方声明](THIRD_PARTY_NOTICES.md)和 [pffft LICENSE](PFFFT-LICENSE.txt)。
