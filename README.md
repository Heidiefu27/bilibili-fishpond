# B站鱼塘 · AI/推广评论收集器

[![test](https://github.com/Heidiefu27/bilibili-fishpond/actions/workflows/test.yml/badge.svg)](https://github.com/Heidiefu27/bilibili-fishpond/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个 Tampermonkey 用户脚本：把 B 站评论区里**明显像 AI 生成 / 推广文案**的评论从原评论区里"收走"，集中放到「最新」旁边的 **🐟 鱼塘** 页里——**就在原评论区的位置**就地切换，不开浮窗、不跳新页面。

> 它不是"关键词黑名单"，而是按**说话腔调**给每条评论打分，再用两道门槛判定。详见[判定](#判定)。

![效果预览](assets/preview.png)

*预览用本地模拟页面渲染，用户名均为示例。*

## 安装

**一键安装**（需先装好 [Tampermonkey](https://www.tampermonkey.net/)）：

<https://raw.githubusercontent.com/Heidiefu27/bilibili-fishpond/main/bilibili-fishpond.user.js>

在浏览器里打开这个链接，Tampermonkey 会弹出安装页；装完打开任意视频页、滚到评论区，排序条右侧出现 `🐟 鱼塘` 即生效。

手动安装：打开本仓库的 `bilibili-fishpond.user.js` 全选复制，粘到 Tampermonkey 的「新建脚本」里保存。

> 脚本头部带 `@updateURL`，仓库更新后 Tampermonkey 会自动检查更新。

## 使用

| 操作 | 说明 |
|---|---|
| 点 `🐟 鱼塘` | 在原评论区位置切到鱼塘页（只看被收走的评论） |
| 点 `最热 / 最新`，或 `← 回到全部评论` | 切回正常评论区 |
| `Esc` | 退出鱼塘页 |
| 鱼塘页里的搜索框 | 按正文 / UP 主过滤 |
| `分数↓` | 在"按分数"和"按时间"之间切换 |

鱼塘里的卡片照搬原评论区排版：头像、昵称、等级、正文、时间、IP 属地、点赞数，多一个 `AI xx` 分数标签。

## 判定

判定只看**怎么说**，不看说了什么，只有两步：

| 顺序 | 条件 | 不满足 |
|---|---|---|
| 1 | 必须 `@` 了人（这类水军的固定特征） | 没 @ → 放过 |
| 2 | 分数 ≥ 阈值（默认 6，改源码里的 `DEFAULT_CFG.threshold`） | 低于阈值放过 |

**加分项**大致分四类：

- 结构：分号、破折号、顿号列举、多个冒号、长句高密度、空格断句
- 腔调：总结腔、提示腔（装完记得 / 不然会）、测评口吻（最实用 / 更戳我 / 没短板）、比喻解释（等于给它一块…）、建议试用（你试试 / 慢慢看）、评价表态（这句我认 / 太对了）、比较收益（比…省事多了）
- 推广：功能罗列（能…还能…）、产品 slug 名、ID 带"鱼 / 鲸"、`@` 了人、话题词命中、安利式 @人
- 反例（减分）：B 站表情、梗与口头禅、语气词、个人叙事、求助问法、感谢、叠字、太短、无标点

**"无任何人味特征 +3"**：够长、标点规整、没梗没语气词**且没有"我"** —— 这反而是机器写的典型特征。

话题词表在源码 `RE_TOPIC` 里，默认带了一些示例产品词（`DSH / DeepSeek / 便签 / 插件 / agent …`）。**换个圈子用，把那几个词换掉即可**：

```js
// 源码里搜索 RE_TOPIC
const RE_TOPIC = /(你的产品名|你的插件名|关键词A|关键词B)/gi;
```

## 它做了什么

1. **接口层剔除**：拦下评论区接口（`/x/v2/reply*`），把命中判定的评论直接从 JSON 里去掉 —— 原评论区压根不会渲染它，**不留空白坑，也不会闪一下**；「评论 N」的计数同步扣减。
2. **DOM 兜底**：万一接口没拦住，就在新卡片出现的**那一拍**（浏览器绘制之前）隐藏它。
3. **鱼塘页**：只收命中判定的评论，就在原列表位置切换。
4. **自适应**：兼容新版 Shadow DOM 评论区与老版 Vue 评论区；Shadow DOM 嵌套/晚挂载、组件重渲染导致页签丢失，都会在 1 秒内自愈。

## 调试

F12 控制台里的只读入口：

```js
__fishpond.diag()          // 钩子状态 / 拦到几次接口 / 剔掉几条 / 影子根数 / 页签状态
__fishpond.pond            // 当前鱼塘里的评论（含分数与命中项）
__fishpond.scanned         // 本页扫到的全部评论（查"为什么没收某条"）
__fishpond.check('文本','昵称')  // 对一段文本跑完整判定（含 @ 门槛）
__fishpond.score('文本')         // 只看正文的腔调分
```

某条该收没收：先跑 `__fishpond.scanned.find(r => r.message.includes('关键词'))`
- 有结果但 `ai: false` → 分数不够，调低 `threshold`
- 没有结果 → 那条数据没走脚本挂钩的接口

## 隐私

- 脚本**不联网**、不上报任何数据、不读取 Cookie / 账号信息
- 只在本地（Tampermonkey 存储）缓存鱼塘列表，用于刷新后仍能看到被收走的评论；键按视频 BV 隔离，最多 120 条，超过 30 天的忽略
- 想清空：在 Tampermonkey 里删除该脚本的存储，或在页面控制台执行
  `Object.keys(localStorage).filter(k => k.startsWith('fishpond:cache:')).forEach(k => localStorage.removeItem(k))`

## 兼容性 / 已知限制

- 只处理**网页版**（`www.bilibili.com` / `t.bilibili.com` / `space.bilibili.com`），不含 App
- B 站评论组件用 Shadow DOM 且元素名会改，脚本靠"文本锚点 + 影子根登记"适配，改版后可能需要更新
- 评论区「最热」与「最新」是两个不同的接口池（`mode=2` / `mode=3`），两边条目天然不完全一样
- 判定是启发式，**不可能 100%**：误收靠调高阈值规避，漏收靠调低阈值或补关键词

## 开发

```bash
node --check bilibili-fishpond.user.js   # 语法
node test/score-cases.mjs                # 只看正文打分的回归（零依赖）
```

GitHub Actions 会在 push / PR 时跑上面两步（见 `.github/workflows/test.yml`）。
版本变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)。随便改，保留版权声明即可。
