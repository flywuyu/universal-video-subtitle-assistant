# 通用视频字幕助手 · Universal Video Subtitle Assistant

优先读取平台已有字幕；没有独立字幕时，再用本机语音模型逐段转写。适用于 Chrome / Edge 的 Manifest V3 侧边栏扩展。

[![Tests](https://github.com/flywuyu/universal-video-subtitle-assistant/actions/workflows/tests.yml/badge.svg)](https://github.com/flywuyu/universal-video-subtitle-assistant/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 功能

- B 站 BV / 分 P、YouTube / Shorts、抖音当前视频的页面适配；兼容普通 HTML5 字幕轨。
- YouTube 网页字幕与可选 Supadata 通道并行，先成功先显示。
- 无字幕时使用 Whisper Turbo；模型冷启动先出 Tiny 草稿，再替换为高质量首段。
- 搜索、点击时间跳转、复制全文、导出 TXT / SRT / VTT。
- 可选 DeepSeek 中文翻译、双语阅读、概览；本地时间戳笔记与字幕缓存。

“通用”表示支持多种读取方式，不保证任意网站或受限视频均可提取。画面压制字幕的全片 OCR 暂未实现。

## 快速安装

### 浏览器扩展

1. [下载源码](https://github.com/flywuyu/universal-video-subtitle-assistant/releases)并解压，或克隆仓库。
2. 打开 `edge://extensions` 或 `chrome://extensions`，开启开发人员模式。
3. 选择「加载已解压的扩展」，选择仓库中的 **extension** 文件夹。
4. 刷新视频页，点击插件图标打开侧边栏。

网页已有字幕的读取不需要 Python。公开 manifest key 用来固定扩展 ID，以匹配本地连接；它不是 API 密钥或私钥。

### 可选：本机语音识别（Windows）

需要 Windows 10/11、Python 3.11 或更高版本，以及下载依赖和模型的网络连接。

双击 **安装或修复.bat**。安装程序会创建项目 `.venv`、安装缺少的依赖、编译本地连接，并为当前 Windows 用户注册 Edge / Chrome 自动启动连接。无需管理员权限。完成后重新加载扩展。

```powershell
# 等效命令
python local_service/setup_service.py
```

首次识别会下载 Whisper 模型，消耗磁盘空间并需要等待。CPU 可运行；支持 CUDA 的 PyTorch 和 NVIDIA 显卡可加速。模型缓存不随源码发布。移动项目后重新运行安装入口；`启动本地服务.bat` 可手动启动。

当前自动启动安装器仅支持 Windows，其他系统尚未完成运行验收。

### 可选：API 设置

在插件右上角「设置」填写，保存后回到视频点击「读取本页字幕」。

| 配置 | 用途 | 必需吗 |
| --- | --- | --- |
| Supadata API Key | 平台原生字幕服务，补充 YouTube 网页读取 | 网页读取受限时建议配置 |
| DeepSeek API Key | 中文翻译、双语和概览 | 仅这些 AI 功能需要 |
| 云端音频转写 | Supadata 按视频时长计费的生成通道 | 默认关闭，需自行启用 |

本机识别不需要 Key。Key 自行保存在浏览器扩展本地存储，调用时发送给对应服务。项目不提供 API 额度或开发者运营的字幕服务器。不要提交 Key、Cookie 或浏览器配置。

## 平台支持与验证范围

| 场景 | 读取方式 | 当前验证范围 |
| --- | --- | --- |
| B 站已有字幕 | BV / CID、平台字幕接口、新版地址转换 | 已验证真实长视频全文和 SRT 导出 |
| B 站无字幕 | 当前音轨 + 本机转写 | 已验证真实 25 分钟视频 |
| 抖音网页版 | 当前视频页面元数据 / 字幕 / 媒体 + 转写 | 已验证真实语音样本 |
| YouTube / Shorts | 网页字幕、完整转写接口、Supadata | 适配与接口测试通过；Supadata 真账号效果待验证 |
| TikTok / Instagram / X / Facebook | Supadata 平台通道 | 已接入，未逐站真实账号验收 |
| 普通 HTML5 视频 | `<track>` / 播放声音转写 | 字幕轨通过浏览器测试页验证 |

国内抖音与 TikTok 是两个平台。Supadata 官方支持清单不包括 B 站和国内抖音，这两者使用自己的网页适配器。登录限制、网络和网站改版可能影响读取；受限不等同于视频没有字幕。

## 工作方式

```text
当前视频 → 缓存 / 平台字幕 / 可选 Supadata → 完整时间轴
                  ↓ 确认没有独立字幕
          直接音轨 → 本机逐段转写
                  ↓ 无法取得媒体地址
          用户点击播放声音识别 → 随播放补充
```

平台字幕与语音生成内容会标明来源。DeepSeek 译文与原文分别保存，不改写原字幕。播放声音模式先收集约 6 秒音频，模型加载和推理另需时间；保持侧边栏打开并播放视频。

画面中的字可能已压进图像，不是独立字幕。英文原声配中文字幕时，语音转写得到的是原声；无声视频仅有画面文字时，本版无法靠语音生成字幕。

## 历史样本性能

2026-10-26，RTX 5070 Laptop 上的具体观测值，不是通用速度或准确率承诺：

| 样本 | 首次可见结果 | 完成 | 来源 |
| --- | --- | --- | --- |
| B 站访谈，47:09 | 1.088 秒，1136 条全文 | 同时完成；缓存 0.106 秒 | 平台自动字幕 |
| 抖音视频，1:57 | 2.462 秒 | 11.940 秒，72 条 | 已加载的 Turbo |
| B 站访谈，25:27 | 约 2.429 秒 | 后端 86.811 秒，377 条 | 已加载的 Turbo |
| 服务关闭后读取网络短音频 | 18.413 秒首稿 | 32.092 秒完成校正 | 含启动、网络和模型加载 |

平台 AI 字幕和本机转写均可能有错词，人名和数字需核对。未进行人工标注的准确率评测。第三方完整字幕、截图、录音和本机测试输出不上传。

## 开发与测试

JavaScript 核心测试无 npm 依赖：

```powershell
npm test
```

Python 单元测试只需 NumPy，不加载模型或访问视频网站：

```powershell
python -m pip install numpy
python -m unittest discover -s tests -p "*_test.py"
```

浏览器测试需额外安装 Playwright 和 Chromium：

```powershell
python -m pip install playwright
python -m playwright install chromium
python tests/browser_smoke.py
```

`provider_ui_smoke.py` 明确模拟外部 API，检验界面与协议，不代表真账号效果。`*_real_e2e.py`、`platforms_real_probe.py` 等需手动运行，会访问真实网站，部分会调用模型或重启本项目空闲服务。录音测试需自行提供 `tests/fixtures/speech_zh.wav`、`speech_en.wav`。

## 目录

```text
extension/       浏览器侧边栏、网页适配、提供商与设置
local_service/   本机语音服务与 Windows 自动启动连接源码
tests/           单元测试与手动集成测试
.github/         持续集成与问题模板
```

贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，权限、数据流和漏洞报告见 [SECURITY.md](SECURITY.md)。

## 开源与致谢

使用 [MIT License](LICENSE)，维护者 [@flywuyu](https://github.com/flywuyu)。

- [YouTube Digest](https://github.com/zarazhangrui/youtube-digest)：参考其字幕服务与 AI 阅读功能分离的设计，保留 [MIT 版权声明](extension/THIRD_PARTY_NOTICES.md)。
- [OpenAI Whisper](https://github.com/openai/whisper)、[yt-dlp](https://github.com/yt-dlp/yt-dlp)、[youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api)：语音与媒体读取。
- [Supadata 文档](https://docs.supadata.ai/get-transcript)、[DeepSeek 文档](https://api-docs.deepseek.com/api/create-chat-completion/)：可选 API。

第三方依赖、模型和服务遵循各自许可与条款。请处理你有权访问和使用的视频内容。
