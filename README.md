# B站鱼塘 · AI/推广评论收集器

[![test](https://github.com/Heidiefu27/bilibili-fishpond/actions/workflows/test.yml/badge.svg)](https://github.com/Heidiefu27/bilibili-fishpond/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

把 B 站评论区里像 **AI 生成 / 推广文案**的评论从原评论区"收走"，集中放到「最新」旁边的 **鱼塘** 页——就在原评论区的位置就地切换，不开浮窗。

（页签图标是 DeepSeek 的蓝鲸 logo，已内嵌进脚本，不需要联网加载。）

![左：原评论区（AI 评论已被收走） / 右：鱼塘页](assets/preview.png)

## 安装

需要 [Tampermonkey](https://www.tampermonkey.net/)，然后点这里：

<https://raw.githubusercontent.com/Heidiefu27/bilibili-fishpond/main/bilibili-fishpond.user.js>

<sub>国内下载慢的话可以用镜像（jsDelivr 对 `@main` 有约 12 小时缓存，可能比仓库晚一点）：<https://cdn.jsdelivr.net/gh/Heidiefu27/bilibili-fishpond@main/bilibili-fishpond.user.js></sub>

装完打开任意视频页，滚到评论区，排序条右侧出现蓝鲸图标 + `鱼塘` 即生效。脚本的 `@updateURL` 指向同一个 jsDelivr 地址，之后会自动检查更新。

## 使用

| 操作 | 说明 |
|---|---|
| 点 `鱼塘 N` | 切到鱼塘页，只看被收走的评论 |
| 点 `最新/最热` 或 `← 回到全部评论` | 切回正常评论区 |
| 鱼塘页顶部 | 搜索正文/UP主、按分数或时间排序 |
| 点 `扫全部` | 翻页扫描该视频的**全部**评论（不只是你滚动加载到的），进度会显示在按钮上，再点一次可中断 |

## 扫描全部评论

默认只收集页面实际请求到的评论（第一条 + 你滚动加载的）。点鱼塘页里的 `扫全部` 会主动翻页：

- 走 `/x/v2/reply/wbi/main` + **wbi 签名**（脚本自带 MD5 与签名实现），分页 token 取 `cursor.pagination_reply.next_offset`
- 每页间隔 350ms，失败自动重试 3 次（B 站偶发 `-412` 限流）；上限 120 页 / 2400 条
- 未登录时 B 站只给约 12 页（200 多条）就 `is_end`，这时会自动补一轮"滚动驱动页面自己加载"，把能看的都收进来

> 注：`回复 @某人 :` 是 B 站的引用格式，脚本会先剥掉这段前缀再判断 @ 与打分——所以"回复别人的正常讨论"不会被当成推广。

## 判定

只有两步，都要满足：

| 条件 |
|---|
| ① 评论里 `@` 了人 |
| ② 腔调分数 ≥ 阈值（默认 6） |

**前置排除**（命中就一律不收集）：

| 排除 | 说明 |
|---|---|
| **点赞数 ≥ 5** | 有人点赞的评论基本不是这波水军（水军评论通常 0 赞） |
| **有子回复**（`rcount > 0`） | 有真人跟帖讨论，水军评论基本没人回 |
| `@` 的对象是**本视频 UP 主** | 在跟 UP 对话，不是发推广（比对接口的 `content.members[].mid` 与本视频 UP 的 mid） |

**账号等级按分数算**（不豁免，高等级也可能被收）：

| 等级 | 加减分 |
|---|---|
| 0~1 | +4（新号更可疑） |
| 2~3 | +2 |
| 4 | 0 |
| 5 | −2 |
| 6 | −3 |

分数来自"像不像推广文案"的统计特征——分号/顿号排比、`最实用`/`更戳我`/`没短板`、`装完记得`/`不然会`、`等于给它一块…`、`你试试`、功能罗列（能…还能…）、`@人 + 推荐词`，以及反面的"人味"（梗、语气词、个人叙事、求助、太短、B站表情）。

改阈值：源码里 `DEFAULT_CFG.threshold`；换圈子用：改 `RE_TOPIC` 里的产品词。

## 实现要点

- **接口层剔除**：拦 `/x/v2/reply*`，把命中的评论从 JSON 里删掉，原评论区压根不渲染它，`评论 N` 同步扣减
- **不闪**：接口没拦住时，在新卡片出现的**那一拍**（绘制前）隐藏
- **自适应**：兼容新版 Shadow DOM 与老版 Vue 评论区；组件重渲染、页签丢失都能自愈；多实例不会插出两枚页签

## 已知限制

- 只支持网页版，不含 App
- 「最热」和「最新」是两个不同的接口池，条目天然不完全一样
- 判定是启发式，不可能 100%：误收调高阈值，漏收调低阈值

## 隐私

不联网、不上报、不读 Cookie。只有鱼塘列表缓存在本地（按 BV 隔离，最多 120 条）。

## 调试

```js
__fishpond.diag()                  // 钩子/拦截/剔除/页签状态
__fishpond.scanned                 // 本页扫到的评论（含分数）
__fishpond.check('文本','昵称')     // 对一段文本跑完整判定
```

## 开发

```bash
node --check bilibili-fishpond.user.js
node test/score-cases.mjs
```

MIT License · 变更见 [CHANGELOG.md](CHANGELOG.md)
