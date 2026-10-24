# Bilibili Downloader (personal-use Chrome extension)

MV3 扩展。在 B 站视频页点击工具栏图标 → 选一个分辨率 → 插件自动下载对应的
视频流+音频流，在浏览器里用 ffmpeg.wasm 把它们 mux 成单个 mp4，直接下到
`~/Downloads/`。**全程在浏览器内完成，不扫描你磁盘上的任何其他文件。**

只做个人使用，不上架 Chrome Web Store，也不要拿去分发。

## 加载

1. Chrome 打开 `chrome://extensions/`
2. 右上角开启 "开发者模式 / Developer mode"
3. "加载已解压的扩展程序 / Load unpacked" → 选这个目录 `bilibili-downloader/`

## 用法

1. 打开任意 B 站视频页 `bilibili.com/video/BVxxxx`、`bilibili.com/bangumi/play/…`，
   或播放列表页 `bilibili.com/list/watchlater?...`（稍后再看 / 收藏夹播放器也支持）
2. 点浏览器工具栏里的扩展图标
3. Popup 列出可用的分辨率 + 编码组合，比如：
   - `1080P · H.264` — 兼容性最好，QuickTime 直接双击能播
   - `1080P · H.265` — 体积小一半，需要 macOS Big Sur+/HEVC 支持
   - `1080P · AV1`   — 最省流量，需要新播放器（VLC / Chrome 都能播）
4. 点 "下载"。插件顺序做这几件事：
   - 下视频流（有进度）
   - 下音频流（有进度，自动选最高质量的音轨）
   - 首次调用 ffmpeg.wasm 会加载 30MB 的 wasm 到内存（后续在同一会话里免加载）
   - `ffmpeg -c copy -movflags +faststart` mux 成 mp4
   - 生成 blob URL，交给 `chrome.downloads` 保存到 Downloads
5. 合并过程即使关掉 popup 也不会中断（跑在 offscreen document 里）。工具栏图标
   会显示进度百分比。完成后弹窗打开会看到 "已保存: xxx.mp4"。

## 字幕

如果视频带字幕，popup 底部会多出一个 **字幕 (SRT)** 区块，列出所有可用语言：

- 人工上传的字幕（比如 UP 主自己加的、社区协作的）
- AI 自动生成的字幕（会带一个 `AI` 小标）

点 "下载" 会把 B 站的字幕 JSON 转成标准 `.srt`，存成 `视频名.语言.srt`
（比如 `xxx.ai-zh.srt`、`xxx.zh-CN.srt`），可以直接喂给播放器或字幕工具。

字幕接口需要登录才能拿到（同样借用你浏览器的 cookie）。没有字幕的视频不显示这个区块。

## 能拿到什么清晰度

- **未登录**：一般到 480P
- **登录**：720P
- **大会员**：1080P+ / 4K / HDR / Dolby Vision（要账号有权限）

插件用 `credentials: 'include'` 调 playurl，等于借用你当前浏览器的 cookie，
所以你在浏览器里登了什么，就能拿到什么。

## 目录结构

```
bilibili-downloader/
├── manifest.json      MV3 清单
├── rules.json         DNR 规则，给 CDN 请求塞 Referer（不加会 403）
├── background.js      Service Worker，协调 popup ↔ offscreen ↔ downloads
├── popup.html/css/js  弹窗 UI
├── offscreen.html/js  Offscreen 页，跑 ffmpeg.wasm 做 mux
└── vendor/
    ├── ffmpeg.js          @ffmpeg/ffmpeg 0.12 UMD 入口
    ├── 814.ffmpeg.js      配套的 worker 脚本
    ├── ffmpeg-core.js     wasm 加载器
    └── ffmpeg-core.wasm   31MB 主 wasm（单线程构建，不需要 SharedArrayBuffer）
```

## 关于内存

一次合并会把整个视频+音频文件读进内存，中间还有 wasm 里的一份拷贝。粗略估算
峰值内存 ≈ (视频+音频文件大小) × 3。1080P 30 分钟的视频大概 300MB，跑的时候
Chrome 会短暂多占 1GB 左右。合并完就释放。

如果你要合并 4K 长视频（> 1.5GB），可能会 OOM。等你真的撞到再说，届时可以
把 fetch 改成分块 + 用 ffmpeg 的 pipe，或者退回到 "各下一份，本地 ffmpeg 合并"。

## 已知限制

- 番剧付费内容需要大会员账号才能拿到高清流
- Widevine DRM 的内容拿不到明文，无解
- 页面切 P 后 `__playinfo__` 不刷新 → 插件自动回退到 API 接口，一般不用管
- 没做多 P 批量下载

## 更新 ffmpeg.wasm

要重新拉最新版：

```bash
cd vendor
curl -L -o ffmpeg.js         https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js
curl -L -o 814.ffmpeg.js     https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/814.ffmpeg.js
curl -L -o ffmpeg-core.js    https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js
curl -L -o ffmpeg-core.wasm  https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm
```
