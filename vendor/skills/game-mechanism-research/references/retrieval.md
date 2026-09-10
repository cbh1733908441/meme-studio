# 资料读取

`fetch_game.py` 是已知产品的只读资料读取器，Python 3 标准库即可运行。检索仍由调用环境的网页搜索完成；不要宣称它是已部署的 MCP 或语义搜索服务。

```text
python scripts/fetch_game.py steam 600990 --output gardens-steam.json
python scripts/fetch_game.py apple 1371965583 --country us --output gardens-ios.json
python scripts/fetch_game.py steam https://store.steampowered.com/app/512250/ --language english
```

实际调用时把脚本相对路径解析到本 skill 目录。`--output` 仅在显式传入时写文件，否则输出 JSON。相同文件名会覆盖，保留历史证据时用新文件名。

成功返回 `status=ok`、`retrieved_at`、`source_url`、`endpoint_url`、产品 ID、名称、提供者、平台/设备证据、原始介绍、公开截图/视频入口和可取得的评分样本；附来源文字哈希以追踪版本。不会下载媒体。`source_kind=publisher_store_description` 表示开发者/商店说明，`gameplay_observed=false` 表示没有实玩验证。评分字段只提供体验权重，不能证明某个局部机制好玩。

Steam 读取公开 Store appdetails 端点；这不是有稳定性保证的语义搜索 API。返回 `product_type`，供调用者识别游戏、DLC、音乐等；类别标签不视作机制事实。Apple 使用公开 iTunes lookup，返回 `supported_devices`、`features` 和最低系统版本；要据这些字段与页面平台标识区分 iPhone、iPad 和 Mac。Apple 区域无结果不证明其他区域或历史版本不存在。

`status=error` 不返回伪造描述；JSON 中写明错误类别和原因，并以非零状态退出。HTTP 403/429、地区缺失或接口变化时，换网页和开发者来源；不反复重试相同受阻入口。读取日期不等于发行日期。

网页检索例子：

- 关系发现：`site:store.steampowered.com game manipulate time objects`。
- 机制精化：`site:store.steampowered.com game assemble sentence words reaction`。
- 找到名称后核验：`site:store.steampowered.com/app "Rhythm Doctor" "7th"`。
- 手机入口：`site:apps.apple.com/us/app "The Gardens Between" "iPhone"`。
- 操作缺口：`site:gameovenstudios.com Bounden controls`。

记下哪些查询改变了决策即可，不必把重复地区页面和全部结果灌入上下文。
