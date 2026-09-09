# 站内浏览与直接音视频理解

## 可执行路径

- `scripts/browser_media.py`：使用 Python Playwright 和 Chromium，直接打开抖音/B站的站内搜索页或具体视频页。输出页面截图、可见文本、实际发布链接；视频可播放时输出指定时间的画面，还可从播放器录制短音轨。这是获取与观察工具，不做内容语义判断。
- `scripts/bilibili_media.py`：从 B站实际播放器页面或其播放接口响应读取可播放流，使用同一会话获取并合并同步音视频。下载器失败时优先尝试；不改换目标、不复制 cookies，不绕过验证码或权限。输出来源信息及可解码文件，语义仍待核验。
- `scripts/gemini_media.py`：将本地音频或同步视频的指定区间作为真实多模态输入发送给 Gemini。输出台词、音乐/音效描述、时间线与未知；视频模式同时检查动作、剪辑和声音对应。它与纯语音转写不同，但模型报告仍需来源匹配与必要复核，尤其不能凭模型猜测认证歌名、混音或“原版”。

不必等待专门 MCP 注册后才能使用：当前 Agent 可通过本地执行工具调用以上脚本。若需要给其他客户端暴露 MCP，应另按用户要求配置；不要声称已经注册了未注册的 MCP。

## 依赖与浏览器会话

Python 依赖：playwright、requests、keyring；需要 Playwright 对应的 Chromium 和 PATH 中的 FFmpeg。先检查现有安装，不重复下载。通过 `python scripts/doctor.py --check-browser --check-gemini` 检查实际执行环境；Mac 通常使用 python3 或已激活虚拟环境的 python。

Mac/Linux 使用 `~/MemeAssetTools/browser-bilibili` 与 `browser-douyin`。Windows 浏览器会话单独存于 `%LOCALAPPDATA%/MemeAssetTools/browser-bilibili` 与 `browser-douyin`，不复制日常浏览器个人资料或导出 cookies。默认无可见窗口；需要用户登录或完成验证码时使用 `--interactive` 打开可见浏览器。验证码由用户处理，不自动解题、伪装或绕过。一个平台的同一配置目录不能并发打开两次。

```text
python SKILL_DIR/scripts/browser_media.py --platform bilibili --query "隔壁班嘉豪" --sort plays --out WORK_DIR/search
python SKILL_DIR/scripts/browser_media.py --platform douyin --query "是关中王来了" --out WORK_DIR/douyin
python SKILL_DIR/scripts/browser_media.py --platform douyin --query "嘉豪" --interactive --hold 900 --out WORK_DIR/auth
python SKILL_DIR/scripts/browser_media.py --platform bilibili --url VIDEO_URL --times 0 10 20 --start 0 --record-seconds 12 --out WORK_DIR/clip
```

交互窗口保留到指定时间；用户明确完成验证后，可在该输出目录写入名为 `continue` 的空文件结束等待并保存结果。该信号不是自动判定验证成功，结果仍须检查。用户关闭窗口时也应保留失败状态。不要用结束等待代替用户验证。

输出 `result.json`、`page.txt`、`page.png`，以及可用时的 `video-*.png`、`browser-audio.webm`。音频仅录制实际播放器音轨，不拼接候选音乐。检查是否有音轨、是否静音、时长是否符合预期；画面采样和音频录制记录各自的实际时间。默认最多录制 60 秒；需要同步视频语义分析时优先提供已取得的原视频，不能把截图序列当作已完整看过视频。

B站搜索默认点击“最多播放”；`--sort relevance` 可改回综合排序。`search_cards` 保留卡片原文，具体视频页的 `video_metadata.stat` 可提供 view、like、favorite 等数值，附采集时间。不能将卡片第二个数（常为弹幕数）当点赞数。热度决定同分支候选核验优先级，不覆盖目标相关性。截图等待实际 seek 完成，不能把视频 currentTime 刚更新时的旧画面当作新时间的证据。

遇到播放器权限限制、加载失败或没有音轨时保留准确失败项。搜索页的推荐视频与目标视频区分，不能将一个 video 元素存在就当作目标已核验。

## Gemini 本地配置

按用户选择连接 Gemini。运行：

```text
python SKILL_DIR/scripts/gemini_media.py configure
python SKILL_DIR/scripts/gemini_media.py status
```

配置窗口使用遮挡输入，密钥通过 keyring 保存到系统凭据库（Windows 凭据管理器 / Mac Keychain），服务名 `meme-asset-extract/gemini`；非敏感模型设置保存在 `%LOCALAPPDATA%/MemeAssetTools/gemini.json`。Mac/Linux 非敏感配置位于 `~/MemeAssetTools/gemini.json`。配置窗口需要 tkinter；缺少时可使用环境变量。也支持当前进程的 GEMINI_API_KEY 或 GOOGLE_API_KEY。状态检查只返回配置布尔值，不打印密钥。不要要求用户把密钥贴进聊天，也不要把密钥写到提取清单、版本库或命令行参数。

“验证并保存”调用官方模型信息接口验证访问，未上传视频。默认模型依据 2026-09-08 查阅的官方音频示例，可在窗口修改；以用户账户实际可用模型为准。配置成功不代表真实媒体分析已通过，必须另做一次授权样本实测。

## 直接听音／视频分析

```text
python SKILL_DIR/scripts/gemini_media.py analyze --source SOURCE_FILE --mode audio --start 0 --seconds 12 --out WORK_DIR/audio-analysis
python SKILL_DIR/scripts/gemini_media.py analyze --source SOURCE_VIDEO --mode video --start 20 --seconds 10 --out WORK_DIR/video-analysis
```

脚本通过 FFmpeg 制作短片段，音频转 MP3，视频缩小保留同步音轨，再以真实音频/视频内容调用官方 Interactions API。默认分析 30 秒，单次最多 120 秒，请求大小受限，不自动上传整段长视频。请求使用 `store:false`，不创建服务端对话；这不代表服务商没有其他适用的数据处理政策。

输出 `analysis.json`、`analysis.md` 和实际提交的片段；记录模型、源文件哈希、片段偏移、实际输入哈希、用量及分析内容。时间戳相对片段，回查原视频需加 offset_s。结果为模型分析，不自动将原选源记录改成 matched。

无密钥返回 configuration_required；HTTP 错误只报告状态码，不输出可能包含敏感输入的原始错误。密钥、网络或模型不可用时不把 ASR 或画面推测冒充“已听音”。

## 实测记录与文档

2026-09-08 本机实测：B站站内搜索可返回实际视频 URL，并按最多播放排序；具体页面可读取播放与点赞数、取得画面和约 12 秒非静音播放器音轨。抖音首次进入搜索遇验证码，需用户手动验证。Gemini 密钥已保存在本地凭据管理器，音频与视频真实调用成功：已知台词回归测试识别出“是关中王来了”，校园热门音轨识别出英语倒计时，视频模式返回舞蹈与音乐描述。首轮纯音频回答曾编造视觉内容，已标为不通过并加强输入模态约束；具体混音、语气和精细时间戳仍需复核。不要将本记录视为永久健康状态。

官方依据：[Playwright 持久会话](https://playwright.dev/python/docs/api/class-browsertype)、[Gemini 音频输入](https://ai.google.dev/gemini-api/docs/audio)、[Interactions REST 与输出结构](https://ai.google.dev/gemini-api/docs/get-started)。

迁移与独立历史重放见仓库 `reproduction/README.md`；其案例答案不是新任务的默认上下文。
