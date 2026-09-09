# 执行与数据约定

`media_assets.py` 只使用 Python 标准库；媒体处理依赖 PATH 中的 ffmpeg/ffprobe。可用 `--ffmpeg`、`--ffprobe` 指定程序。链接获取额外使用 yt-dlp（可执行程序，或当前 Python 中的模块）。不需要为本地处理安装下载器。

## 命令

以下 `SKILL_DIR` 是该技能的实际安装目录；`WORK_DIR` 是本次工作目录，不是固定路径。

```text
python SKILL_DIR/scripts/media_assets.py inspect --source WORK_DIR/source.mp4
python SKILL_DIR/scripts/media_assets.py preview --source WORK_DIR/source.mp4 --out WORK_DIR/preview --count 8
python SKILL_DIR/scripts/media_assets.py fetch --url VIDEO_PAGE_URL --out WORK_DIR/download
python SKILL_DIR/scripts/media_assets.py render --plan WORK_DIR/plan.json --out WORK_DIR/result
```

`inspect` 输出媒体流、尺寸、时长及哈希。`preview` 输出单独的带时间索引图片和 preview.json；静态图仅输出一帧。音频输入返回无可视帧提示。可用 `--start`、`--end` 缩小预览区间。

`fetch` 只接受 http(s) 发布链接；返回文件路径及最小来源记录，不在回复里转储下载器包含临时媒体直链的完整元数据。需要平台登录时使用当前已授权能力，不自动读取浏览器 cookie。远程图片若下载器不支持，可通过已有网页/媒体工具保存，再作为本地来源。

`render` 默认在全新目录执行，已有非空目录会报错；局部修正使用另一个运行目录。计划里素材路径可为绝对路径，或相对于计划文件目录的路径。返回码：0 为所有计划项导出成功；2 为计划错误、依赖错误或部分导出失败。它不会删除源文件。

## 提取计划

只有梗名时，`selection.json` 另记 `search_log`（有用查询、实际渠道、返回的具体候选、下一步）和候选的 `progress`：`discovery`（found / unresolved）、`inspection`（逐模态注明 frames / continuous_video / listened / metadata_only / not_checked）、`acquisition`（acquired / failed / not_attempted）。`target` 可带 `scope`（single_clip / series / template / ambiguous）与 `branches`；未确认唯一版本时保留候选分支。状态由 Agent 按实际工具结果填写，不由下载成功推断内容核验完成。

声音线索可另记 `music_candidates`：标题／歌名、发布页、关联证据、是否实听、混音和速度的未知。平台音乐标签仅为关联证据，不能自动标成音轨匹配。识别特征可附 `recognition_priority` 与 `necessity_hypothesis`，但跨样本一致性和删除要素实验只有实际做过才写 verified。以上为 Agent 维护的附加字段，现有提取脚本不校验。

自行选源时，先由 Agent 写 `selection.json`（不由脚本自动推断），再写提取计划。例如：

```json
{
  "target": {"meme": "待拆解的梗", "version": "目标基础版本的描述"},
  "candidates": [{
    "source_id": "s1",
    "url": "发布页链接",
    "content_layer": "base_meme",
    "modalities": {
      "image": {"status": "matched", "reason": "画面比对依据", "evidence": []},
      "audio": {"status": "unresolved", "reason": "尚未听音核验", "evidence": []},
      "motion": {"status": "unresolved", "reason": "尚未核对动作版本", "evidence": []}
    }
  }],
  "missing": ["待补齐的基础音频和动作"]
}
```

`content_layer` 为 underlying_asset / base_meme / derivative / unknown；每种模态的 `status` 为 matched / rejected / unresolved。`matched` 应填写可回查依据（来源与时间或明确的用户接受反馈），不能只填自评。静态素材没有动作时可在原因中标明不适用。Agent 在渲染后可给 manifest 追加 `selection_record: "../selection.json"` 或内嵌 `target_match`，使下游不把导出成功误当目标匹配。脚本目前不校验这些附加字段；不得声称脚本已拦截选源错误。

下面时间仅为格式示例，实际执行必须改为针对输入素材观察到的数值；不得将此例视为某个真实 meme 的事件时间。

```json
{
  "meme": "待拆解的梗",
  "branch": "当前分支",
  "sources": [
    {"id": "s1", "path": "source.mp4", "url": null, "role": "unknown"}
  ],
  "features": [
    {
      "id": "f1",
      "kind": "visual",
      "text": "人物表情发生变化",
      "evidence_status": "observed",
      "evidence": [{"source_id": "s1", "start": 1.0, "end": 3.0}]
    }
  ],
  "assets": [
    {"id": "face", "type": "image", "source_id": "s1", "at": 2.0,
     "reason": "保留表情变化后的画面", "feature_ids": ["f1"]},
    {"id": "voice", "type": "audio", "source_id": "s1", "start": 1.0, "end": 3.0,
     "reason": "保留完整声音事件", "feature_ids": []},
    {"id": "motion", "type": "gif", "source_id": "s1", "start": 1.0, "end": 3.0,
     "fps": 12, "width": 480, "loop": false, "with_video": true,
     "reason": "展示变化过程，并用同步视频保留声音", "feature_ids": ["f1"]}
  ],
  "missing": []
}
```

- id 使用字母、数字、下划线或连字符；在各自列表内唯一。`source_id` / `feature_ids` 必须存在。
- `role`: original / remix / repost / explainer / unknown；它是输入的来源判断，脚本不验证首创性。
- `type`: image / audio / gif / video。静态图支持 image，音频支持 audio，视频/GIF按实际流支持；不会从静态图伪造动作。
- 时间为原素材起点起算的秒数，必须是有限数值。image 的 `at` 默认 0；片段必须给 `start` 和 `end`。GIF等时长未知的动态素材需先确认时长，不能猜测。
- image/gif/video 可加 `crop: [x, y, width, height]`，均为 0–1 归一化坐标，相对于未旋转的输入流画面；脚本关闭自动旋转，必须按同一预览方向选裁切。这只是矩形裁切，不是抠图。
- gif 默认宽 480、12 fps、不循环；显式 `loop: true` 表示请求循环，但脚本不验证首尾是否自然。`with_video: true` 同时输出相同时间区间的 MP4，保留输入中存在的音轨。MP4 使用偶数尺寸，不放大到请求宽度以上。
- image 导出 PNG，audio 导出 WAV，gif 导出 GIF，video 导出 MP4。音轨是原混音，不进行音源分离。
- `features.kind` 推荐 visual / audio / text / action / sequence / invariant / variable。`observed` 必须给本地来源证据；`source_reported` 可使用 `evidence: [{"url": "解释页URL"}]`；`hypothesis` 可无直接证据但应说明推导基础。
- 文本字段中保留实际听写、画面字幕、梗写法的区别；不将书面读音推断成已听到的声音。
- `missing` 列出缺失项或不适用项及原因，脚本还会追加导出失败信息。

## 输出

`manifest.json` 包含原特征、来源本地哈希与媒体属性、素材文件、原始时间范围、裁切参数及导出校验。同步视频与 GIF 共用同一来源及区间。

每个成功素材默认 `semantic_review: "pending"`。脚本只证明文件能解码、时长近似符合区间和媒体流存在，不证明选对了梗或台词。实际检视后由执行技能的 Agent 更新为 `verified` / `needs_review`，并附 `review_note`，说明检查了哪些模态；未检查的保持 pending。技术状态 `technical_status` 与语义状态不要合并。

`index.md` 给人查看文件与简要特征。它不代替 JSON 的完整证据记录。若输出被迁移，索引中的绝对路径需要随新位置更新。

## 给多模态理解模块的最小任务

“阅读所提供的参考素材，选择支持识别此梗分支的关键画面、目标版本的混合音轨（包括成梗配乐）与连续动作；先输出提取计划，不生成素材。给出相对原素材起点的时间、选取理由及可定位证据。把直接观察、来源描述和推断分开。保留台词听写、画面字幕与谐音梗写法的区别。不能辨认的词和未确定的歌曲名留空。只有支持动作变化的来源才选 GIF；依赖声音的动作配同步视频。所需字段按本文件的计划结构输出。”

这段任务可以给已配置的音视频模型，或由具有相应工具的当前 Agent 执行。技能不硬编码模型版本、价格、SDK 或凭证；纯图片模型不能替代音频分析。
