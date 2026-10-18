/**
 * 只看正文腔调打分的回归测试（零依赖）
 *
 *   node test/score-cases.mjs
 *
 * 注意：这里只测 scoreComment()（正文打分），不含脚本里的三道硬门
 * （人工标记 / 文案查重 / 必须有 @ / 正文 ≥10 字），那部分请用浏览器里的
 *   __fishpond.check('文本', '昵称')
 *
 * 用例都是为测试**虚构**的句子，不是真实评论。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'bilibili-fishpond.user.js');
const src = readFileSync(SRC, 'utf8');

const m = src.match(/\/\* __SCORE_BLOCK_START__ \*\/([\s\S]*?)\/\* __SCORE_BLOCK_END__ \*\//);
if (!m) {
  console.error('✗ 没找到打分代码块（__SCORE_BLOCK_START__ / END 标记被删了？）');
  process.exit(1);
}
const scoreComment = new Function(`${m[1]}; return scoreComment;`)();

const THRESHOLD = 6;

/**
 * 应当被判为「推广腔」的句子
 *
 * 注意：这里是**纯正文**打分，所以用例都靠文本本身过阈值。
 * 依赖 @/ID/话题 加成才能过线的句子（比如“xx 插件方便办公，快捷键很流畅 @某人”），
 * 要用浏览器里的 __fishpond.check('文本','昵称') 验证。
 */
const SHOULD_FLAG = [
  '@示例甲 最实用的是能一键归档，再按标题翻回来，等于给它一块常驻黑板。装完记得手动启动一次服务。',
  '@示例乙 这个插件最值的是能自动整理；标签、置顶、批量导出都够用。装完记得去设置里手动启动，不然会以为装坏了。',
  '这个功能其实早就有，只是之前藏在设置里，得手动开一下，开了之后确实方便很多，建议试试。',
  '@示例丁 插件能被 agent 读写这段最实用，快捷键和吸附也做了，慢慢看。',
  '示例产品 一次 102 条变更：插件可挂自定义索引源、agent 能自己建插件；但 API 读取优先级变了，升级前先看这两条。@示例戊',
  '@示例己 汇报一下：三处会改现有行为——读取优先级变了、混合模式移除、改名 agent。默认关要手动开，1 分 50 秒，比 changelog 好读。',
  '这个版本我按提示改了三处：字体、行距、首行缩进；改完确实舒服多了。## 重点',
];

/** 应当被放过的真人句子 */
const SHOULD_PASS = [
  '哈哈哈哈这也太离谱了',
  '这个主副屏可以用吗？',
  '可以的，每一个屏幕都可以用',
  '@示例甲 谢谢大佬，我试试',
  '@示例甲 我也遇到过，重启一下就好了',
  '说句公道话，这次更新确实有问题，我更新完之后思考时间变长了',
  '我用的还是旧版，新版界面改得有点乱，不过功能还行吧',
  '笑死，评论区全是鱼',
  '这游戏平衡性、手感、剧情都还行，就是有点肝',
  '感谢分享，终于搞定了，之前一直报错',
  '@示例乙 这个能用吗？',
  '蹲一个，晚上回家试试，先码住',
];

let bad = 0;
const show = (r) => r.hits.slice(0, 4).map((h) => `${h.w > 0 ? '+' : ''}${h.w}${h.name}`).join(' | ');

console.log(`阈值 = ${THRESHOLD}\n\n—— 应当入塘 ——`);
for (const text of SHOULD_FLAG) {
  const r = scoreComment(text);
  const ok = r.score >= THRESHOLD;
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗漏'} ${String(r.score).padStart(3)} 分  ${show(r)}`);
}

console.log('\n—— 应当放过 ——');
for (const text of SHOULD_PASS) {
  const r = scoreComment(text);
  const ok = r.score < THRESHOLD;
  if (!ok) bad++;
  const brief = text.length > 26 ? `${text.slice(0, 26)}…` : text;
  console.log(`${ok ? '✓' : '✗误伤'} ${String(r.score).padStart(3)} 分  ${show(r)}   «${brief}»`);
}

console.log(`\n${bad ? `✗ ${bad} 条不符合预期` : '✓ 全部通过'}`);
process.exit(bad ? 1 : 0);
