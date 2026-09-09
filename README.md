# Meme Studio 本地工作台

访问 **http://127.0.0.1:4317**。macOS 双击 `start.command` 启动并打开页面，双击 `stop.command` 停止。关闭网页不会中断研究；停止服务会取消执行中的 CLI。重启后可在历史记录中重试。

## 两步使用

1. 输入 meme 名称、链接或版本说明。Agent 研究“素材到底哪一下有意思？依据是什么？”以及“要保住这个趣味，哪些东西不能随便改？”，自行核验并保留证据缺口。
2. 用户选择要做的版本、设定 **1–50 的数量上限**并启动选题。这是选择目标，不是代替 Agent 审核理解。带着“玩家操作以后，会发生什么值得他亲手体验的变化？”开放检索，再分析 Steam 具体操作过程，展开、评审和淘汰。

全站共用一个 **3 名额的 CLI 队列**。不同网页任务也不能突破 3；选题展开阶段按编号分配给最多 3 个 CLI。前置机制研究和最后评审各占一个名额，顺序执行。CLI 内部子代理关闭，不修改用户的全局并发或模型配置。

只把保留的候选放入主结果；弱方案、重复方案和待证据方向单独记录原因。数量可以少于上限，也可以为零；界面和导出明确说明不足。没有看过、听过或试玩的部分不能写成已经验证。

## Skill 版本

当前为 `three-questions-v2`。内置三个 Skill，基于上游 [`meme-asset-extract` 的 7171f679](https://github.com/cbh1733908441/meme-asset-extract/commit/7171f6798b436b8812a6918e68be99a7524023d2) 修改；上游提交仅用于溯源，不代表修改后的内容。

`vendor/skills` 是实际运行的源副本，`vendor/manifest.json` 记录当前文件摘要及上游来源。新任务保存独立快照，所有阶段使用同一版本。旧任务只读保留；点击“使用同一素材新建研究”即可按新版重新研究。

## 安装与运行

仓库仅包含源码与 Skill，不含依赖环境、媒体二进制和用户研究记录。按下述步骤在本机安装；FFmpeg / ffprobe 请安装适合当前平台的版本并加入 PATH。

新环境需要 Node.js 22+、已登录的 Codex CLI。优先 Python 3.10+，并安装 FFmpeg / ffprobe：

```sh
npm ci
codex login
python3 -m venv .venv
.venv/bin/python -m pip install -r vendor/skills/meme-asset-extract/requirements.txt
.venv/bin/python -m playwright install chromium
node scripts/local-server.mjs start
```

也可在终端用 `npm start` 前台运行。`start.command` 和后台启动器自动查找本机 Codex App 内的 CLI、`.venv/bin/python` 及 `runtime/bin`。前台启动时请让相应工具在 PATH 中，或设置 `CODEX_BIN` / `MEME_PYTHON`。

| 变量 | 用途 |
| --- | --- |
| `PORT` | 本地端口，默认 4317 |
| `CODEX_BIN` | 指定 Codex CLI 文件 |
| `MEME_PYTHON` | 供媒体脚本使用的 Python 绝对路径 |
| `CODEX_MODEL` | 可选覆盖模型；不设置则沿用本地 Codex 配置 |

调用通过本机 `codex exec` 进行，沿用登录账号和模型额度；不是离线模型。页面不需要填写 OpenAI API Key。非交互调用使用 JSON Schema、JSONL 进度流和输出文件，见 [Codex 非交互运行文档](https://developers.openai.com/codex/noninteractive/)。

素材 Skill 的 Gemini 音视频理解是独立可选能力，沿用该 Skill 已配置的方式；本网页不保存或索取密钥。如果不可用，任务仍可进行公开来源研究，但会保留未实听/实看的缺口。Playwright、FFmpeg 安装成功也不保证所有站点可访问。

## 数据和执行边界

- 服务仅绑定 `127.0.0.1`，校验 Host、Origin 和写入请求的页面令牌。
- `data/<研究ID>/run.json` 保存状态、确认版本、来源、结果和简要进度。
- `data/<研究ID>/work/<任务ID>/` 保存本阶段的提示词、Skill、结构化输出、素材及 CLI 日志。JSON 导出包含完整研究数据；Markdown 适合阅读。
- CLI 使用 `workspace-write`、无需审批的非交互模式，并为公开资料检索启用网络；关联的个人 MCP 服务在本次调用中关闭。用户材料通过标准输入传递，不拼成 shell 命令。
- 页面上的来源和模型输出按纯文本渲染。素材仅允许从本次研究目录读取；拒绝路径穿越和逃出目录的软链接。
- 每阶段最多运行 30 分钟；取消会停止进程组并移除排队任务。重试从当前大步骤开始，可能重新研究；不是从模型中断位置续接。

## 验证与维护

```sh
npm test
node scripts/local-server.mjs stop
```

自动测试覆盖确认门槛、过期版本、数量及编号、共享研究与 3 路并发、错误输出、失败重试、取消和重启恢复、HTTP 边界、导出及素材访问。

`scripts/smoke.mjs` 是需要手动运行的真实 CLI 端到端验收，会消耗账号额度，并由验收程序明确确认测试 meme 后最多生成 1 个候选。测试数据默认写入独立 `data-smoke`，不会作为用户研究自动出现在网页中。运行方式：

```sh
CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex \
MEME_PYTHON="$PWD/.venv/bin/python" \
PATH="$PWD/runtime/bin:$PATH" \
node scripts/smoke.mjs
```

运行日志位于 `logs/server.log`；应用不随系统登录自动启动，也没有部署到公网。
