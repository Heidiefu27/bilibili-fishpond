// ==UserScript==
// @name            B站鱼塘 · AI评论收集器
// @namespace       https://github.com/Heidiefu27/bilibili-fishpond
// @version         2.9.2
// @description     把评论区里“明显AI生成/推广文案”的评论从原评论区收走，集中放进“最热/最新”旁边的【鱼塘】页；就在原评论区位置就地切换，不开浮窗
// @author          Heidiefu27
// @homepageURL     https://github.com/Heidiefu27/bilibili-fishpond
// @supportURL      https://github.com/Heidiefu27/bilibili-fishpond/issues
// @downloadURL     https://raw.githubusercontent.com/Heidiefu27/bilibili-fishpond/main/bilibili-fishpond.user.js
// @updateURL       https://raw.githubusercontent.com/Heidiefu27/bilibili-fishpond/main/bilibili-fishpond.user.js
// @icon            https://www.bilibili.com/favicon.ico
// @match           *://www.bilibili.com/*
// @match           *://t.bilibili.com/*
// @match           *://space.bilibili.com/*
// @run-at          document-start
// @grant           GM_getValue
// @grant           GM_setValue
// @grant           GM_deleteValue
// @grant           unsafeWindow
// @noframes
// @license         MIT
// ==/UserScript==

/*
 * 判定（只有两步）
 * ────────────────────────────────────────────────────────────────
 * 1) 必须 @ 了人
 * 2) 分数 ≥ 阈值（默认 6，改下面的 DEFAULT_CFG.threshold）
 *
 * 做两件事
 * ────────────────────────────────────────────────────────────────
 * 1) 接口层剔除：拦 /x/v2/reply*，把判定命中的评论从 JSON 里去掉，
 *    原评论区压根不渲染它（不留空白坑、不闪）
 * 2) DOM 兜底：接口没拦住时，在新卡片出现的那一拍（绘制前）隐藏
 *    “最热/最新”右侧生成【鱼塘 N】页签（DeepSeek 蓝鲸图标），点它在原位置看被收走的评论
 */

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════
   * 0. 配置
   * ══════════════════════════════════════════════════════════════ */

  const VERSION = '2.9.2';
  const TAG = '%c[鱼塘]';
  const TAG_CSS = 'color:#00AEEC;font-weight:700';
  const log = (...a) => { try { console.log(TAG, TAG_CSS, ...a); } catch (e) {} };
  const warn = (...a) => { try { console.warn('[鱼塘]', ...a); } catch (e) {} };

  const NS = 'fishpond';
  const K_CACHE = NS + ':cache:';   // 按页面缓存鱼塘（刷新后还能看到收走的评论）

  const DEFAULT_CFG = {
    enabled: true,      // 总开关
    hideNative: true,   // 从原评论区收走（接口剔除）
    domFallback: true,  // 接口没拦住时按文本兜底隐藏
    requireAt: true,    // 判定①：必须 @ 了人
    threshold: 6,       // 判定②：分数 ≥ 阈值
    sort: 'score',      // 鱼塘页排序：score | time
  };
  const CFG = Object.assign({}, DEFAULT_CFG);

  // 扫描全部评论的上限（防止一条视频扫太久）
  // 本视频 UP 主信息（用于"@ 了 UP 主"的前置排除）
  const VIP = { upMid: '', upName: '' };
  // 点赞 >= 这个数 → 必定不是鱼（水军的评论基本没人赞）
  const LIKE_EXEMPT = 5;

  // 点赞/回复不再排除，只用来标记"疑似"并置顶
  // 疑似原因：赞 ≥ 5，或已有子回复（水军互捧时也算）
  function suspectTags(rec) {
    const tags = [];
    if (Number(rec.like) >= LIKE_EXEMPT) tags.push('赞 ' + rec.like);
    if (Number(rec.rcount) > 0) tags.push('有 ' + rec.rcount + ' 条回复');
    return tags;
  }
  function isSuspect(rec) { return suspectTags(rec).length > 0; }

  // 账号等级按分数算（不是硬排除）：等级低更可疑，等级高只降权，不豁免
  //   0~1 级 +4 / 2~3 级 +2 / 4 级 0 / 5 级 -2 / 6 级 -3
  function levelHits(level) {
    const lv = Number(level) || 0;
    if (lv <= 1) return { w: 4, name: '低等级号(LV' + lv + ')' };
    if (lv <= 3) return { w: 2, name: '等级偏低(LV' + lv + ')' };
    if (lv === 4) return null;
    if (lv === 5) return { w: -2, name: 'LV5 老号' };
    return { w: -3, name: 'LV6 老号' };
  }

  function detectUp() {
    try {
      const st = PAGE_WIN.__INITIAL_STATE__;
      if (st) {
        const up = st.upData || (st.videoData && st.videoData.owner) || null;
        if (up && up.mid) { VIP.upMid = String(up.mid); VIP.upName = String(up.name || ''); }
      }
    } catch (e) {}
    return VIP.upMid;
  }

  const SCAN_MAX_PAGES = 120;      // 最多 120 页（每页 20 条左右）
  const SCAN_MAX_REPLIES = 2400;   // 最多收录 2400 条
  const SCAN_DELAY = 350;          // 每页间隔（毫秒）
  const WBI_MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
    26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
    20, 34, 44, 52];

  // DeepSeek 蓝鲸 logo（内嵌 data URI：脚本不联网也能显示）
  const ICON = 'data:image/png;base64,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';
  // 图标用 mask 着色（跟随文字颜色，和原站蓝一致），并内联尺寸：
  // 影子根里即使残留旧样式表，也不会被放成 64px 原图
  const iconTag = (cls) => {
    const size = /title/.test(cls || '') ? 16 : 15;
    // 注意：外层属性用双引号，这里必须用单引号包 url，否则会把 style 属性截断
    const mask = "url('" + ICON + "') center / contain no-repeat";
    return '<span class="fp-icon ' + (cls || '') + '" aria-hidden="true"'
      + ' style="display:inline-block;width:' + size + 'px;height:' + size + 'px;'
      + 'background-color:currentColor;'
      + '-webkit-mask:' + mask + ';mask:' + mask + '"></span>';
  };

  const store = {
    get(key, def) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(key, undefined);
          return v === undefined || v === null ? def : v;
        }
        const raw = localStorage.getItem(key);
        if (raw === null) return def;
        try { return JSON.parse(raw); } catch (e) { return raw; }
      } catch (e) { return def; }
    },
    set(key, val) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, val);
        else localStorage.setItem(key, JSON.stringify(val));
      } catch (e) { warn('存储失败', key, e); }
    },
    del(key) {
      try {
        if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
        else localStorage.removeItem(key);
      } catch (e) {}
    },
  };

  /* ══════════════════════════════════════════════════════════════
   * 1. 打分
   *    scoreComment(text) 只看正文；evaluate(rec) 再加 ID / @ / 话题。
   * ══════════════════════════════════════════════════════════════ */

  /* __SCORE_BLOCK_START__ */
  function scoreComment(text) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const hits = [];
    const add = (w, name) => { if (w) hits.push({ w, name }); };
    const cnt = (re) => (s.match(re) || []).length;
    const has = (re) => re.test(s);
    const n = s.length;
    if (!n) return { score: 0, hits: [] };

    /* ---------- 标点 / 结构 ---------- */
    const semi = cnt(/[；;]/g);
    const comma = cnt(/[，,]/g);
    const dun = cnt(/、/g);
    const colon = cnt(/[：:]/g);
    const full = cnt(/[。！？!?]/g);
    const quotes = cnt(/[“”「」『』《》]/g);

    if (semi >= 1) add(2, '中文分号');
    if (semi >= 2) add(2, '连续分号成段');
    if (has(/——|—/)) add(3, '破折号排比');
    if (dun >= 2) add(2, '顿号并列');
    if (dun >= 3) add(2, '顿号并列×3+');
    if (colon >= 2) add(3, '多个冒号');
    else if (colon === 1 && (dun >= 1 || semi >= 1)) add(1, '冒号＋列举');
    if (quotes >= 1) add(2, '中文引号/书名号');
    if (n >= 60 && comma >= 4) add(2, '长句高密度');
    if (n >= 120 && comma >= 6) add(2, '超长结构化');
    if (full >= 2) add(1, '多句号成段');
    if (n >= 40 && full === 0 && comma === 0) add(-2, '无标点');
    // 空格断句：整段不用中文标点、靠空格切句（AI 写口语中文的典型排版）
    if (comma === 0 && semi === 0 && dun === 0 && cnt(/[ \u3000]+/g) >= 3 && n >= 30 && /[\u4e00-\u9fa5]{6,}/.test(s)) {
      add(2, '空格断句腔');
    }

    /* ---------- 腔调 ---------- */
    const TONES = [
      [/(综上|总的来说|总结一下|简单来说|一句话|划重点|换个说法|换句话说|说白了|本质上|核心就是|最值的是|最有用的是|值得注意的是|值得一提的是|归根结底|总体来看|整体来看)/, 4, '总结腔'],
      [/(先说结论|建议先看|升级前先看|提醒一句|友情提示|科普一下|补充一下|补充一句|顺便说一句|划个重点|注意一下|记住这句|这条要先看|装完记得|装完得先|记得手动|手动启动|建议加|建议先|不然会|这点容易|容易卡)/, 4, '提示腔'],
      [/([两三四五]\s*(处|条|点|项)(会|都|要|需要|该)?|\d+\s*(处|条|项)(变更|改动|建议|问题|坑))/, 2, '量化清单'],
      [/(属于.{0,10}(类型|那类|那种|一类|范畴)|这类|那种感觉|非常值得|值得一试|强烈推荐|不折腾|装了就|一分钟就能|亲测有效|都够用|够用了)/, 3, '评价结论腔'],
      [/(确实|挺|很|真的)(舒服|好用|不错|好看|香|实用|方便)多了|确实(很|挺)?(舒服|好用|不错|好看|香|实用|方便)/, 2, '好评腔'],
      [/(很|挺|比较|非常|特别|蛮|相当)(流畅|顺手|丝滑|好用|方便|舒服|稳定|快捷|省事|好使)/, 2, '好评腔(II)'],
      [/(最实用|最有用|最值得|最戳我|更戳我|没短板|短板|我反而|诚意|这个细节比|把瑕疵|摆出来|小工具|这类工具|给面子|给足了|有点东西)/, 3, '测评口吻'],
      [/(这句我认|这话我认|这句服|太对了|说得对|思路对|确实是这样|这点我赞同)/, 3, '评价表态腔'],
      [/比.{0,12}(省事|省心|方便|好用|快|强|舒服|顺)(多)?了/, 2, '比较收益腔'],
      [/(等于|相当于|等同于).{0,14}(给它|给ta|往它|贴|塞|摆|留)/, 3, '比喻解释腔'],
      [/(你试试|试试看|可以试试|不妨试|建议试试|愿意试|装上试试|装一个试试|慢慢看|慢慢用|慢慢研究)/, 3, '建议/试用腔'],
      [/(主人|本鱼|鱼鱼|本喵|小助手|在下)/, 2, '角色扮演自称腔'],
      [/(此外|另外|同时|因此|而且|并且|然而|首先|其次|最后|进而|从而|不过|实际上|总体)/, 0, '书面连接词'],
    ];
    for (const [re, w, name] of TONES) {
      if (w === 0) continue;
      if (has(re)) add(w, name);
    }
    const conn = cnt(/(此外|另外|同时|因此|而且|并且|然而|首先|其次|最后|进而|从而|不过|实际上|总体)/g);
    if (conn >= 2) add(2, '书面连接词' + conn + '处');

    /* ---------- 推广结构 ---------- */
    const ability = cnt(/(能|可以|支持|还能|都能|全在|都在)/g);
    if (ability >= 2) add(dun >= 2 ? 3 : 2, dun >= 2 ? '功能罗列腔' : '功能罗列');
    if (/(要是|如果|假如).{0,26}就(真|彻底|完美|更好|没短板|无短板|稳了|齐了|完美了)/.test(s)) add(2, '假设句式');
    if (/\b[a-z][a-z0-9]{2,}(?:-[a-z0-9]{2,}){2,}\b/i.test(s)) add(2, '产品 slug 名');
    if (/（[^（）]{3,24}）/.test(s)) add(1, '括号动作/补充');
    if (/\d+分\d+秒|\d+:\d{2}/.test(s)) add(1, '精确时间点');
    if (/#[^\s#]{1,14}#/.test(s)) add(1, '话题标签');

    /* ---------- 人味反向分 ---------- */
    const humanMarks = [];
    const anti = (w, name) => { add(w, name); humanMarks.push(name); };
    if (/\[[^\[\]]{1,8}\]/.test(s)) anti(-4, 'B站表情');
    if (/(哈{2,}|笑死|233+|awsl|泪目|离谱|卧槽|淦|狗头|前排|沙发|插眼|蹲|救命|破防|绷不住|绝了|好家伙|哭了|乐死|难崩|这波|我愿称)/.test(s)) anti(-4, '口语/梗');
    if (cnt(/(啊|吧|呀|呢|嘛|啦|嗷|诶|欸|嗯)/g) >= 2) anti(-3, '语气词多');
    if (/(我|咱)/.test(s) && /(感觉|刚才|昨天|试了|卡了|坑了|用着|在家|上班|折腾|踩过)/.test(s)) anti(-2, '个人叙事');
    if (/(有没有|咋|怎么破|啥|请问|求解|大佬|佬|求问|救命)/.test(s)) anti(-2, '求助/口语问法');
    if (/(感谢|谢谢|辛苦|三连|码住|收藏了|学到了)/.test(s)) anti(-2, '感谢/礼貌词');
    if (/(.)\1{2,}/.test(s)) anti(-2, '叠字/复读');
    if (n < 25) anti(-6, '太短');

    /* ---------- 无人味加成 ---------- */
    if (comma >= 2 && n >= 35 && humanMarks.length === 0 && !/(我|咱|俺)/.test(s)) add(3, '无任何人味特征');

    const score = hits.reduce((a, h) => a + (h.w || 0), 0);
    hits.sort((a, b) => b.w - a.w);
    return { score, hits };
  }
  /* __SCORE_BLOCK_END__ */

  const RE_ID_FISH = /鱼|鲸/;                    // 发送者 ID 带“鱼/鲸”
  const RE_AT = /@\s*[^\s@]{1,24}/;               // @ 了别人（注意 B 站有“@ 名字”带空格的写法）
  const RE_TOPIC = /(DSH|DeepSeek|便签|插件|草稿纸|agent|GitHub|开源|模型|字体|配色|订阅|安装|设置里)/gi;

  /**
   * B 站回复某人时，正文会带「回复 @某人 :」前缀。这不是推广里的 @，
   * 打分和 @ 门槛都必须用去掉前缀后的正文。
   */
  function splitQuote(msg) {
    const m = /^\s*回复\s*@\s*([^\s:：]{1,24})\s*[:：]\s*/.exec(String(msg || ''));
    if (!m) return { body: String(msg || ''), quoteTo: '' };
    return { body: String(msg || '').slice(m[0].length), quoteTo: m[1] };
  }

  function evaluate(rec) {
    const q = splitQuote(rec.message);
    const base = scoreComment(q.body);
    const hits = base.hits.slice();
    let score = base.score;
    const msg = q.body;
    const name = rec.uname || '';

    if (RE_ID_FISH.test(name)) { score += 2; hits.push({ w: 2, name: 'ID 带鱼/鲸' }); }
    if (RE_AT.test(msg)) { score += 2; hits.push({ w: 2, name: '@了别人' }); }

    const topic = msg.match(RE_TOPIC) || [];
    const uniq = new Set(topic.map((t) => t.toLowerCase()));
    if (uniq.size >= 3) { score += 2; hits.push({ w: 2, name: 'DSH/插件话题' }); }
    else if (/DSH|DeepSeek/i.test(msg)) { score += 1; hits.push({ w: 1, name: '提到 DSH' }); }

    // 账号等级：低等级加分、高等级减分（高等级仍然可能被收）
    const lh = levelHits(rec.level);
    if (lh) { score += lh.w; hits.push(lh); }

    // 安利式 @人：@某人 + 推荐/好评词 + 毫无口语痕迹
    if (RE_AT.test(msg)
      && /(推荐|试试|好用|流畅|方便|顺手|装上|装了|值得|不错)/.test(msg)
      && !/(哈哈|笑死|我|咱|啊|吧|呀|呢|嘛|啦|？|\?|求助|怎么)/.test(msg)
      && msg.length <= 90) {
      score += 3;
      hits.push({ w: 3, name: '安利式@人' });
    }

    hits.sort((a, b) => b.w - a.w);
    return { score, hits };
  }

  /* ══════════════════════════════════════════════════════════════
   * 2. 判定与登记
   * ══════════════════════════════════════════════════════════════ */

  const REPLIES = new Map();   // rpid -> record
  const AI = new Set();        // 进鱼塘的 rpid
  const NEEDLES = new Map();   // rpid -> 文本 needle（DOM 兜底用）
  const COUNTED = new Set();   // 已扣过“评论 N”的 rpid

  /** 判定：必须有 @ → @ 的不是本视频 UP → 分数 ≥ 阈值（等级只算分，不排除） */
  function judge(rec) {
    if (!rec) return false;
    const q = splitQuote(rec.message);
    const msg = q.body;

    // 排除：这条就是在回复本视频 UP 主
    if (VIP.upName && q.quoteTo && q.quoteTo === VIP.upName) return false;

    // 必须有 @（剔除「回复 @某人 :」这种引用）
    if (CFG.requireAt && !RE_AT.test(msg)) return false;

    // 排除：@ 的对象就是本视频 UP 主（在跟 UP 对话，不是发推广）
    const upMid = VIP.upMid || detectUp();
    if (upMid) {
      if (Array.isArray(rec.ats) && rec.ats.indexOf(String(upMid)) !== -1) return false;
      if ((!rec.ats || !rec.ats.length) && VIP.upName && msg.indexOf('@' + VIP.upName) !== -1) return false;
    }

    return rec.score >= Number(CFG.threshold || 6);
  }

  function normalizeText(t) { return String(t || '').replace(/\s+/g, '').trim(); }

  function looksLikeReply(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    const hasRpid = (typeof o.rpid === 'number' && o.rpid > 0) || (typeof o.rpid_str === 'string' && o.rpid_str);
    return !!hasRpid && !!(o.content && typeof o.content.message === 'string');
  }

  function parseCtx(url) {
    try {
      const u = new URL(url, location.href);
      return { oid: u.searchParams.get('oid') || '', type: u.searchParams.get('type') || '1', mode: u.searchParams.get('mode') || '' };
    } catch (e) {
      return { oid: '', type: '1', mode: '' };
    }
  }

  function normalizeAvatar(a) {
    if (!a) return '';
    return a.startsWith('//') ? 'https:' + a : a;
  }

  function pickLocation(o) {
    const raw = (o && o.reply_control && o.reply_control.location)
      || (o && o.member && o.member.location)
      || (o && o.location)
      || '';
    return String(raw).replace(/^IP\s*属地\s*[:：]\s*/, '').trim();
  }

  function pickLevel(o) {
    const lv = o && o.member && o.member.level_info && o.member.level_info.current_level;
    return typeof lv === 'number' ? lv : 0;
  }

  /** 这条评论下面已有的子回复作者（接口一般带前几条） */
  function pickChildMids(o) {
    const arr = o && o.replies;
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const r of arr) {
      const m = r && r.member && r.member.mid;
      if (m) out.push(String(m));
    }
    return out;
  }

  /** 这条评论 @ 了谁（B 站接口在 content.members 里给了 mid） */
  function pickAts(o) {
    const arr = o && o.content && o.content.members;
    if (!Array.isArray(arr)) return null;
    const out = [];
    for (const m of arr) {
      const mid = m && (m.mid || m.mid_str);
      if (mid) out.push(String(mid));
    }
    return out;
  }

  function refreshAI(rec) {
    if (!rec) return false;
    const isAI = judge(rec);
    if (isAI) {
      AI.add(rec.rpid);
      const nd = normalizeText(rec.message).slice(0, 20);
      if (nd.length >= 8) NEEDLES.set(rec.rpid, nd);
    } else {
      AI.delete(rec.rpid);
      NEEDLES.delete(rec.rpid);
    }
    return isAI;
  }

  function registerReply(reply, ctx) {
    const rpid = String(reply.rpid || reply.rpid_str || '');
    if (!rpid || rpid === '0') return null;
    const message = (reply.content && reply.content.message) || '';
    if (!message.trim()) return null;
    const member = reply.member || {};
    const prev = REPLIES.get(rpid);
    const uname = member.uname || (prev && prev.uname) || '未知用户';

    // 重复请求 / 第二遍剔除：正文没变时，把会变动的字段（赞/回复数/等级/@）同步过来，
    // 变了就重新判定一次（点赞涨上去、有回复了都可能改变结论）
    if (prev && prev.message === message && prev.uname === uname) {
      const like = Number(reply.like) || 0;
      const rc = Number(reply.rcount != null ? reply.rcount : reply.count) || 0;
      const lv = pickLevel(reply);
      const ats = pickAts(reply);
      const changed = like !== prev.like
        || rc !== (prev.rcount || 0)
        || lv !== (prev.level || 0)
        || (ats && ats.join(',') !== (prev.ats || []).join(','));
      if (!changed) return { rec: prev, isAI: AI.has(rpid) };
      prev.like = like;
      prev.rcount = rc;
      if (lv) prev.level = lv;
      if (ats) prev.ats = ats;
      const ev2 = evaluate(prev);
      prev.score = ev2.score;
      prev.hits = ev2.hits;
      refreshAI(prev);
      return { rec: prev, isAI: AI.has(rpid) };
    }

    const rec = {
      rpid,
      message,
      oid: ctx.oid,
      type: ctx.type,
      uname,
      mid: member.mid || (prev && prev.mid) || '',
      avatar: normalizeAvatar(member.avatar) || (prev && prev.avatar) || '',
      ctime: reply.ctime || (prev && prev.ctime) || 0,
      like: reply.like || 0,
      rcount: Number(reply.rcount != null ? reply.rcount : reply.count) || 0,
      parent: String(reply.parent || reply.parent_str || (prev && prev.parent) || ''),
      root: String(reply.root || reply.root_str || (prev && prev.root) || ''),
      childMids: pickChildMids(reply),
      location: pickLocation(reply) || (prev && prev.location) || '',
      level: pickLevel(reply) || (prev && prev.level) || 0,
      ats: pickAts(reply) || (prev && prev.ats) || [],
      score: 0,
      hits: [],
    };
    const ev = evaluate(rec);
    rec.score = ev.score;
    rec.hits = ev.hits;

    REPLIES.set(rpid, rec);
    rememberLoc(rec);
    refreshAI(rec);
    return { rec, isAI: AI.has(rpid) };
  }

  /** 递归扫描评论接口 JSON：登记 + 剔除命中项 */
  function walkReplyTree(node, ctx, depth, noPrune, removedOut) {
    if (!node || typeof node !== 'object' || depth > 9) return 0;
    let removed = 0;

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        const item = node[i];
        if (looksLikeReply(item)) {
          const r = registerReply(item, ctx);
          walkReplyTree(item, ctx, depth + 1, noPrune, removedOut);
          if (r && r.isAI && !noPrune) {
            node.splice(i, 1);
            removed++;
            if (removedOut && r.rec) removedOut.push(r.rec.rpid);
          }
        } else {
          removed += walkReplyTree(item, ctx, depth + 1, noPrune, removedOut);
        }
      }
      return removed;
    }

    for (const k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      const v = node[k];
      if (!v || typeof v !== 'object') continue;
      const rem = walkReplyTree(v, ctx, depth + 1, noPrune, removedOut);
      if (rem && typeof node.rcount === 'number') node.rcount = Math.max(0, node.rcount - rem);
      removed += rem;
    }
    return removed;
  }

  function wouldBeAI(reply) {
    const rpid = String(reply.rpid || reply.rpid_str || '');
    const msg = (reply.content && reply.content.message) || '';
    if (!rpid || !msg.trim()) return false;
    const probe = {
      rpid,
      message: msg,
      uname: (reply.member && reply.member.uname) || '',
      level: pickLevel(reply),
      like: Number(reply.like) || 0,
      rcount: Number(reply.rcount != null ? reply.rcount : reply.count) || 0,
      ats: pickAts(reply) || [],
      score: 0,
      hits: [],
    };
    const ev = evaluate(probe);
    probe.score = ev.score;
    probe.hits = ev.hits;
    return judge(probe);
  }

  const NET = { seen: 0, pruned: 0, urls: new Set(), byMode: {}, oid: '', type: '1' };

  function ingestAndPrune(json, url) {
    if (!json || typeof json !== 'object') return 0;
    const ctx = parseCtx(url);
    if (ctx.oid) { NET.oid = ctx.oid; NET.type = ctx.type || '1'; }
    try {
      const up = json.data && json.data.upper;
      if (up && up.mid && !VIP.upMid) { VIP.upMid = String(up.mid); if (up.name) VIP.upName = String(up.name); }
    } catch (e) {}

    walkReplyTree(json, ctx, 0, true);   // 第一遍：只登记

    // 边角保护：整页会被剔光时不剔，交给 DOM 兜底，避免分页停住
    let noPrune = !CFG.hideNative;
    try {
      const d = json.data;
      const c = d && d.cursor;
      const arr = d && Array.isArray(d.replies) ? d.replies : null;
      if (arr && arr.length > 1 && c && c.is_end === false) {
        noPrune = arr.every((r) => looksLikeReply(r) && wouldBeAI(r));
      }
    } catch (e) {}

    const removedRpids = [];
    const removed = walkReplyTree(json, ctx, 0, noPrune, removedRpids);
    for (const rp of removedRpids) if (rp) COUNTED.add(rp);
    if (removed) {
      NET.pruned += removed;
      try {
        const d = json.data;
        if (d && d.cursor && typeof d.cursor.all_count === 'number') {
          d.cursor.all_count = Math.max(0, d.cursor.all_count - removed);
        }
      } catch (e) {}
    }
    NET.seen++;
    try {
      const m = ctx.mode || '?';
      const b = NET.byMode[m] || (NET.byMode[m] = { seen: 0, removed: 0, lastReplies: 0 });
      b.seen++;
      b.removed += removed;
      b.lastReplies = json.data && Array.isArray(json.data.replies) ? json.data.replies.length : 0;
    } catch (e) {}
    bumpUI();
    return removed;
  }

  /* ══════════════════════════════════════════════════════════════
   * 2.5 扫描全部评论（wbi 签名分页，失败则驱动页面自己加载）
   * ══════════════════════════════════════════════════════════════ */

  // Tampermonkey 沙箱里 window 是隔离的，页面全局（__INITIAL_STATE__ 等）要从 unsafeWindow 读
  const PAGE_WIN = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  let scanning = false;
  let scanAbort = false;
  const MID_LOC = new Map();   // mid → IP 属地（子回复不返回 location 时用它补）
  let scanTotal = 0;   // 接口报告的评论总数（all_count）

  /** 精简 MD5（wbi 签名要用；脚本里没有 Node 的 crypto） */
  function md5Hex(input) {
    const str = unescape(encodeURIComponent(String(input)));
    const len = str.length;
    const words = [];
    for (let i = 0; i < len; i++) words[i >> 2] |= (str.charCodeAt(i) & 0xff) << ((i % 4) * 8);
    words[len >> 2] |= 0x80 << ((len % 4) * 8);
    words[(((len + 8) >> 6) << 4) + 14] = len * 8;
    const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const K = [];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let i = 0; i < words.length; i += 16) {
      let a = a0, b = b0, c = c0, d = d0;
      for (let j = 0; j < 64; j++) {
        let f, g;
        if (j < 16) { f = (b & c) | (~b & d); g = j; }
        else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
        else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * j) % 16; }
        const tmp = d;
        d = c; c = b;
        const sum = (a + f + K[j] + (words[i + g] | 0)) | 0;
        const sh = S[(j >> 4) * 4 + (j % 4)];
        b = (b + ((sum << sh) | (sum >>> (32 - sh)))) | 0;
        a = tmp;
      }
      a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
    }
    const hex = (n) => {
      let out = '';
      for (let i = 0; i < 4; i++) out += ((n >> (i * 8)) & 0xff).toString(16).padStart(2, '0');
      return out;
    };
    return hex(a0) + hex(b0) + hex(c0) + hex(d0);
  }

  let wbiCache = { key: '', at: 0 };
  async function getWbiKey() {
    if (wbiCache.key && Date.now() - wbiCache.at < 3600 * 1000) return wbiCache.key;
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
    const j = await r.json();
    const img = String(j && j.data && j.data.wbi_img && j.data.wbi_img.img_url || '').split('/').pop().split('.')[0];
    const sub = String(j && j.data && j.data.wbi_img && j.data.wbi_img.sub_url || '').split('/').pop().split('.')[0];
    const raw = img + sub;
    if (!raw) throw new Error('拿不到 wbi key');
    let key = '';
    for (const i of WBI_MIXIN) if (i < raw.length) key += raw[i];
    wbiCache = { key: key.slice(0, 32), at: Date.now() };
    return wbiCache.key;
  }

  function wbiQuery(params, mixinKey) {
    const p2 = Object.assign({}, params, { wts: Math.round(Date.now() / 1000) });
    const q = Object.keys(p2).sort().map((k) => {
      const v = String(p2[k]).replace(/[!'()*]/g, '');
      return encodeURIComponent(k) + '=' + encodeURIComponent(v);
    }).join('&');
    return q + '&w_rid=' + md5Hex(q + mixinKey);
  }

  /** 从已拦到的接口里取 oid/type（页面加载过评论才有） */
  function currentOid() {
    if (NET.oid) return { oid: NET.oid, type: NET.type || '1' };
    try {
      const st = PAGE_WIN.__INITIAL_STATE__;
      if (st && st.aid) return { oid: String(st.aid), type: '1' };
    } catch (e) {}
    return null;
  }

  function scanProgress(txt) {
    scanLabel(txt);
    toast(txt);
  }

  /** 主路：带 wbi 签名调分页接口 */
  async function scanByApi() {
    const ctx = currentOid();
    if (!ctx) return -1;                     // 没有 oid，交给兜底
    let key;
    try { key = await getWbiKey(); } catch (e) { return -1; }

    let offset = '';
    let pages = 0;
    let added = 0;
    while (!scanAbort && pages < SCAN_MAX_PAGES && REPLIES.size < SCAN_MAX_REPLIES) {
      const q = wbiQuery({
        oid: ctx.oid,
        type: ctx.type,
        mode: 3,
        pagination_str: JSON.stringify({ offset }),
        plat: 1,
        web_location: 1315875,
      }, key);
      // 带重试：B 站偶发 -412/-352 限流，或网络抖动
      let json = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch('https://api.bilibili.com/x/v2/reply/wbi/main?' + q, { credentials: 'include' });
          json = await r.json();
          if (json && json.code === 0) break;
          warn('扫描接口返回', json && json.code, json && json.message);
          if (attempt < 2) await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
        } catch (e) {
          warn('扫描请求失败', e);
          if (attempt < 2) await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
        }
      }
      if (!json || json.code !== 0) { warn('扫描放弃这一页'); break; }

      const before = REPLIES.size;
      try { walkReplyTree(json, parseCtx('https://api.bilibili.com/x/v2/reply/wbi/main?oid=' + ctx.oid + '&type=' + ctx.type + '&mode=3'), 0, true); } catch (e) {}
      added += Math.max(0, REPLIES.size - before);

      const cur = json.data && json.data.cursor || {};
      const total = cur.all_count || 0;
      if (total) scanTotal = total;
      pages++;
      scanProgress('扫描中 ' + pages + ' 页 · 已收 ' + added + ' 条 / 共 ' + total);
      saveCacheSoon();
      bumpUI();

      if (cur.is_end) break;
      // 分页 token 在 pagination_reply.next_offset（旧字段是 next，做兼容）
      const pr = cur.pagination_reply || {};
      const next = pr.next_offset || pr.next;
      if (!next) { offset = null; break; }   // 拿不到 token → 交给滚动兜底
      offset = next;
      await new Promise((r) => setTimeout(r, SCAN_DELAY));
    }
    return offset === null ? -1 : added;
  }

  /** 兜底：滚动/点击让页面自己加载，我们只负责收接口数据 */
  async function scanByScroll() {
    const feed = findFeed();
    if (!feed) return 0;
    const start = REPLIES.size;
    let idle = 0;
    for (let i = 0; i < 120 && !scanAbort; i++) {
      const before = REPLIES.size;
      try {
        const more = deepQueryOne(commentScope(), '[class*="load-more"], .load-more, .reply-load-more');
        if (more && more.click) more.click();
      } catch (e) {}
      try { feed.lastElementChild && feed.lastElementChild.scrollIntoView({ block: 'end' }); } catch (e) {}
      try { window.scrollBy(0, 400); } catch (e) {}
      await new Promise((r) => setTimeout(r, 700));
      if (REPLIES.size === before) { idle++; if (idle >= 3) break; } else { idle = 0; }
      scanProgress('滚动加载中 · 已收 ' + (REPLIES.size - start) + ' 条');
    }
    return REPLIES.size - start;
  }

  let scanLabelTimer = 0;
  function scanLabel(txt) {
    if (!pondEl || !pondEl.__scanBtn) return;
    pondEl.__scanBtn.textContent = txt;
  }

  async function scanAll() {
    if (scanning) { scanAbort = true; return; }
    scanning = true;
    scanAbort = false;
    if (pondEl && pondEl.__scanBtn) pondEl.__scanBtn.textContent = '扫描中…';
    const start = REPLIES.size;
    let added = 0;
    try {
      const total = scanTotal || 0;
      added = await scanByApi();
      if (added < 0) {
        // 接口拿不到分页 token → 靠页面自己加载
        await scanByScroll();
      } else if (total && REPLIES.size < total * 0.8) {
        // 接口提前 is_end（未登录/风控只给部分），补一轮滚动，尽量把能看的都收进来
        scanProgress('接口只给了 ' + REPLIES.size + ' / ' + total + ' 条，继续滚动补…');
        await scanByScroll();
      }
      added = REPLIES.size - start;
    } catch (e) {
      warn('扫描出错', e);
      try { scanByScroll(); } catch (e2) {}
      added = REPLIES.size - start;
    } finally {
      scanning = false;
      saveCacheSoon();
      renderPond(true);
      updateTabCount();
      try { syncNativeDom(); } catch (e) {}
      if (pondEl && pondEl.__scanBtn) pondEl.__scanBtn.textContent = '扫全部';
      toast(added ? '扫描完成：新增 ' + added + ' 条（鱼塘 ' + AI.size + ' 条）' : '扫描完成：没有新增');
    }
  }

  /* ══════════════════════════════════════════════════════════════
   * 3. 网络钩子（fetch / XHR）
   * ══════════════════════════════════════════════════════════════ */

  const isReplyUrl = (url) => !!url && /\/x\/v2\/reply(\/|\?|$)|x\/web-interface\/view\/detail/.test(String(url));

  function patchFetch() {
    const raw = window.fetch;
    if (!raw || raw.__fpPatched) return;
    const patched = function (input) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const p = raw.apply(this, arguments);
      if (isReplyUrl(url)) NET.urls.add(String(url).split('?')[0]);
      if (!isReplyUrl(url) || !CFG.enabled || !CFG.hideNative) {
        if (isReplyUrl(url)) {
          p.then((res) => {
            try { res.clone().json().then((j) => ingestAndPrune(j, url)).catch(() => {}); } catch (e) {}
          }).catch(() => {});
        }
        return p;
      }
      return p.then((res) => {
        if (!res || !res.ok) return res;
        return res.clone().json().then((json) => {
          let removed = 0;
          try { removed = ingestAndPrune(json, url); } catch (e) { warn('解析评论失败', e); }
          if (!removed) return res;
          const headers = new Headers(res.headers);
          headers.delete('content-length');
          headers.delete('content-encoding');
          return new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers });
        }).catch(() => res);
      });
    };
    patched.__fpPatched = true;
    try { window.fetch = patched; } catch (e) { warn('fetch 钩子安装失败', e); }
  }

  function patchXHR() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto || proto.__fpPatched) return;
    proto.__fpPatched = true;

    const rawOpen = proto.open;
    const dText = Object.getOwnPropertyDescriptor(proto, 'responseText');
    const dResp = Object.getOwnPropertyDescriptor(proto, 'response');

    proto.open = function (method, url) {
      try { this.__fpUrl = String(url || ''); } catch (e) {}
      if (!this.__fpHooked) {
        this.__fpHooked = true;
        const xhr = this;

        if (dText && dText.get) {
          Object.defineProperty(xhr, 'responseText', {
            configurable: true,
            get() {
              let raw = '';
              try { raw = dText.get.call(xhr); } catch (e) { return ''; }
              if (raw && xhr.__fpText === undefined && isReplyUrl(xhr.__fpUrl) && xhr.readyState === 4) {
                try {
                  const json = JSON.parse(raw);
                  const removed = ingestAndPrune(json, xhr.__fpUrl);
                  xhr.__fpText = removed && CFG.enabled && CFG.hideNative ? JSON.stringify(json) : null;
                } catch (e) { xhr.__fpText = null; }
              }
              return xhr.__fpText ? xhr.__fpText : raw;
            },
          });
        }
        if (dResp && dResp.get) {
          Object.defineProperty(xhr, 'response', {
            configurable: true,
            get() {
              const type = xhr.responseType;
              if (!type || type === 'text') return xhr.responseText;
              let raw;
              try { raw = dResp.get.call(xhr); } catch (e) { return null; }
              if (type === 'json' && raw && !xhr.__fpJsonDone && isReplyUrl(xhr.__fpUrl)) {
                xhr.__fpJsonDone = true;
                try { ingestAndPrune(raw, xhr.__fpUrl); } catch (e) {}
              }
              return raw;
            },
          });
        }
      }
      return rawOpen.apply(this, arguments);
    };
  }

  patchFetch();
  patchXHR();

  /* ══════════════════════════════════════════════════════════════
   * 4. 影子 DOM 工具
   * ══════════════════════════════════════════════════════════════ */

  const SCOPE_SELECTORS = [
    'bili-comments', '#commentapp', '#comment', '.comment-container',
    '.bili-comments', '.bili-dyn-comment', '#comment-module', '#commentModule', '.reply-list',
  ];

  let scopeHit = null;
  let scopeAt = 0;

  function commentScope() {
    const now = Date.now();
    if (now - scopeAt < 1500) {
      if (scopeHit && scopeHit.isConnected) return scopeHit;
      if (!scopeHit) return null;
    }
    for (const sel of SCOPE_SELECTORS) {
      let el = null;
      try { el = document.querySelector(sel); } catch (e) { el = null; }
      if (el) { scopeHit = el; scopeAt = now; return el; }
    }
    scopeHit = null;
    scopeAt = now;
    return null;
  }

  const shadowRoots = new Set();

  function registerShadow(root) {
    if (!root || !root.host || shadowRoots.has(root)) return;
    shadowRoots.add(root);
    try { watchNode(root); } catch (e) {}
    try {
      for (const c of root.querySelectorAll(CARD_SELECTOR)) hideIfAI(c);
    } catch (e) {}
  }

  function discoverShadowRoots(scope) {
    const root = scope || document;
    const queue = [root];
    if (root && root.shadowRoot) queue.push(root.shadowRoot);
    const seen = new Set();
    let guard = 0;
    while (queue.length && guard++ < 600) {
      const sc = queue.shift();
      if (!sc || seen.has(sc)) continue;
      seen.add(sc);
      let all = [];
      try { all = sc.querySelectorAll('*'); } catch (e) { all = []; }
      for (const el of all) {
        if (!el.shadowRoot) continue;
        const tag = String(el.tagName || '');
        const cls = typeof el.className === 'string' ? el.className : '';
        if (!/^BILI-/.test(tag) && !/comment|reply/i.test(tag) && !/comment|reply/i.test(cls)) continue;
        registerShadow(el.shadowRoot);
        queue.push(el.shadowRoot);
      }
      if (sc === document) {
        try {
          for (const sel of ['bili-comments', '#commentapp', '#comment', '.comment-container', '.reply-list']) {
            for (const h of document.querySelectorAll(sel)) {
              if (h.shadowRoot) { registerShadow(h.shadowRoot); queue.push(h.shadowRoot); }
            }
          }
        } catch (e) {}
      }
    }
  }

  function deepQueryAll(root, selector) {
    const out = [];
    const seen = new Set();
    const push = (scope) => {
      if (!scope || typeof scope.querySelectorAll !== 'function' || seen.has(scope)) return;
      seen.add(scope);
      try {
        for (const el of scope.querySelectorAll(selector)) out.push(el);
      } catch (e) {}
      if (scope.shadowRoot) push(scope.shadowRoot);
    };
    push(root || document);
    for (const sr of shadowRoots) push(sr);
    return out;
  }

  function deepQueryOne(root, selector) {
    const all = deepQueryAll(root, selector);
    return all.length ? all[0] : null;
  }

  /* ══════════════════════════════════════════════════════════════
   * 5. 样式
   * ══════════════════════════════════════════════════════════════ */

  // 页签样式：会被插进 bili-comments 的 shadowRoot，单独一份
  const TAB_CSS = `
  /* 页签：字号/字重/分隔符都对齐原站「最热 | 最新」 */
  .fp-tab {
    display: inline-flex; align-items: center; gap: 4px;
    margin: 0; padding: 0;
    border: 0; background: transparent; cursor: pointer;
    color: #00AEEC; font-family: inherit;
    font-weight: 400; font-size: inherit; line-height: 1.4;
    letter-spacing: 0; vertical-align: baseline;
    transition: opacity .15s;
  }
  .fp-tab:hover { opacity: .75; }
  .fp-tab.active { color: #F85A54; }
  .fp-tab-sep {
    display: inline-block; margin: 0 8px;
    color: rgba(148,158,178,.55); font-weight: 400;
    transform: scaleX(.6);
  }
  .fp-tab-text { display: inline-block; }
  .fp-icon { width: 15px; height: 15px; display: inline-block; vertical-align: -2px; }
  .fp-icon-title { width: 16px; height: 16px; vertical-align: -3px; }
  .fp-tab-count {
    font-style: normal; font-size: 10px; line-height: 14px;
    min-width: 14px; padding: 0 4px; border-radius: 7px;
    background: #F85A54; color: #fff; text-align: center;
    margin-left: 2px;
  }
  .fp-tab-count.zero { display: none; }
  `;

  // 鱼塘页样式：就地长在原评论区里，颜色继承页面（明暗主题都适配）
  const POND_CSS = `
  .fp-pond { color: inherit; font-family: inherit; padding: 0 0 24px; }
  .fp-pond[hidden] { display: none !important; }
  .fp-pond-bar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 10px 2px; margin-bottom: 4px;
    border-bottom: 1px solid rgba(128,136,153,.22);
    font-size: 13px;
  }
  .fp-pond-title { font-weight: 700; font-size: 14px; display: inline-flex; align-items: center; gap: 6px; }
  .fp-pond-title i {
    font-style: normal; font-size: 11px; line-height: 17px; min-width: 18px;
    padding: 0 6px; border-radius: 9px; background: rgba(248,90,84,.16);
    color: #F85A54; text-align: center;
  }
  .fp-spacer { flex: 1 1 auto; }
  .fp-search {
    height: 28px; width: 168px; padding: 0 10px; font-size: 12.5px;
    border-radius: 14px; border: 1px solid rgba(128,136,153,.35);
    background: rgba(128,136,153,.10); color: inherit; outline: none; font-family: inherit;
  }
  .fp-search::placeholder { color: inherit; opacity: .45; }
  .fp-search:focus { border-color: #00AEEC; }
  .fp-mini {
    height: 28px; padding: 0 11px; font-size: 12.5px; cursor: pointer;
    border-radius: 14px; border: 1px solid rgba(128,136,153,.35);
    background: rgba(128,136,153,.10); color: inherit; font-family: inherit;
  }
  .fp-mini:hover { border-color: #00AEEC; color: #00AEEC; }
  .fp-scaninfo { font-size: 11.5px; opacity: .45; padding: 2px 2px 8px; line-height: 1.6; }

  .fp-card { display: flex; gap: 12px; padding: 16px 2px; border-bottom: 1px solid rgba(128,136,153,.16); }
  .fp-card:hover { background: rgba(128,136,153,.05); }
  .fp-av {
    width: 44px; height: 44px; border-radius: 50%; overflow: hidden; flex: 0 0 auto;
    background: rgba(128,136,153,.22); display: flex; align-items: center; justify-content: center;
    font-size: 16px; font-weight: 600; opacity: .9;
  }
  .fp-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .fp-body { flex: 1 1 auto; min-width: 0; }
  .fp-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
  .fp-uname { font-size: 13px; font-weight: 600; opacity: .95; }
  .fp-lv {
    font-size: 10px; line-height: 15px; padding: 0 5px; border-radius: 4px;
    border: 1px solid rgba(128,136,153,.45); opacity: .6; font-style: italic;
  }
  .fp-ai {
    font-size: 11px; line-height: 16px; padding: 0 7px; border-radius: 8px;
    background: rgba(248,90,84,.14); color: #F85A54; font-weight: 700;
  }
  .fp-text { font-size: 14px; line-height: 1.72; white-space: pre-wrap; word-break: break-word; }
  .fp-text.clamp { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
  .fp-sus { color: #F85A54; }
  .fp-reply-toggle {
    border: 0; background: none; padding: 0; margin: 0;
    font: inherit; color: #00AEEC; cursor: pointer; opacity: .9;
  }
  .fp-reply-toggle:hover { opacity: 1; text-decoration: underline; }
  .fp-replies {
    margin: 8px 0 2px; padding: 8px 10px;
    border-left: 2px solid rgba(148,158,178,.25);
    background: rgba(148,158,178,.05); border-radius: 0 6px 6px 0;
    font-size: 12.5px; line-height: 1.7;
  }
  /* 楼中楼：整行自然流排，不要被 flex 撑开成两头分散 */
  .fp-reply { padding: 2px 0; line-height: 1.7; }
  .fp-reply-av {
    width: 20px; height: 20px; border-radius: 50%; overflow: hidden; flex: 0 0 auto;
    display: inline-flex; align-items: center; justify-content: center;
    background: rgba(148,158,178,.2); font-size: 10px; vertical-align: -5px; margin-right: 6px;
    cursor: pointer;
  }
  .fp-reply-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .fp-reply-who { color: #00AEEC; margin-right: 6px; text-decoration: none; cursor: pointer; }
  .fp-uname { text-decoration: none; cursor: pointer; }
  .fp-ucard {
    display: none; position: absolute; z-index: 99999;
    background: #22252B; color: #E3E5E7; border: 1px solid rgba(148,158,178,.25);
    border-radius: 10px; padding: 14px 16px; box-shadow: 0 10px 30px rgba(0,0,0,.45);
    font-size: 13px; line-height: 1.6; font-family: inherit;
  }
  .fp-ucard-head { display: flex; gap: 12px; align-items: center; }
  .fp-ucard-face {
    width: 52px; height: 52px; border-radius: 50%; overflow: hidden; flex: 0 0 auto;
    background: rgba(148,158,178,.2); display: flex; align-items: center; justify-content: center; font-size: 20px;
  }
  .fp-ucard-face img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .fp-ucard-info { min-width: 0; }
  .fp-ucard-name { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 6px; }
  .fp-ucard-stats { opacity: .55; font-size: 12px; margin-top: 2px; }
  .fp-ucard-btns { display: flex; gap: 8px; margin-top: 12px; }
  .fp-ucard-btn {
    flex: 1; text-align: center; padding: 6px 10px; border-radius: 6px; cursor: pointer;
    background: rgba(148,158,178,.15); color: #E3E5E7; text-decoration: none; font-size: 12.5px;
  }
  .fp-ucard-btn.primary { background: #00AEEC; color: #fff; }
  .fp-ucard-btn:hover { opacity: .85; }
  .fp-reply-txt { opacity: .85; word-break: break-word; }
  .fp-reply-meta { opacity: .45; font-size: 11.5px; margin-left: 8px; white-space: nowrap; }
  .fp-reply-meta::before { content: '· '; }
  .fp-reply-more { opacity: .5; font-size: 11.5px; padding-top: 4px; }
  .fp-meta { margin-top: 6px; font-size: 12px; opacity: .55; display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; }

  .fp-empty { padding: 40px 8px; text-align: center; font-size: 13px; line-height: 2; opacity: .6; }
  .fp-empty b { opacity: 1; font-size: 15px; }

  #fp-toast {
    position: fixed; left: 50%; bottom: 60px; transform: translate(-50%, 12px);
    z-index: 2147483002; padding: 8px 16px; border-radius: 999px;
    background: rgba(20,21,24,.95); color: #fff; font-size: 12.5px;
    border: 1px solid rgba(255,255,255,.14); box-shadow: 0 8px 22px rgba(0,0,0,.4);
    opacity: 0; pointer-events: none; transition: opacity .18s, transform .18s;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  #fp-toast.on { opacity: 1; transform: translate(-50%, 0); }
  `;

  const CSS = TAB_CSS + POND_CSS;

  function injectCSS() {
    const cur = document.getElementById('fp-style');
    if (cur && cur.dataset.fpVer === VERSION) return;
    if (cur) { try { cur.remove(); } catch (e) {} }
    const style = document.createElement('style');
    style.id = 'fp-style';
    style.dataset.fpVer = VERSION;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function injectShadowCSS(root) {
    if (!root || !root.host) return;
    try {
      const cur = root.querySelector('style[data-fp]');
      if (cur && cur.dataset.fpVer === VERSION) return;
      if (cur) { try { cur.remove(); } catch (e) {} }   // 旧实例留下的旧样式表直接换掉
      const style = document.createElement('style');
      style.setAttribute('data-fp', '1');
      style.dataset.fpVer = VERSION;
      style.textContent = CSS;
      root.appendChild(style);
    } catch (e) {}
  }

  /* ══════════════════════════════════════════════════════════════
   * 6. 小工具
   * ══════════════════════════════════════════════════════════════ */

  let toastTimer = 0;
  function toast(msg) {
    let el = document.getElementById('fp-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fp-toast';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
  }

  const p2 = (n) => String(n).padStart(2, '0');
  function formatTime(ts) {
    if (!ts) return '';
    const diff = Date.now() / 1000 - ts;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + '天前';
    const d = new Date(ts * 1000);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }

  /* ══════════════════════════════════════════════════════════════
   * 7. 缓存
   * ══════════════════════════════════════════════════════════════ */

  let cacheKey = '';
  let cacheTimer = 0;

  function computeCacheKey() {
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/);
    return K_CACHE + (m ? m[1] : location.pathname + location.search).slice(0, 120);
  }

  function loadCache() {
    cacheKey = computeCacheKey();
    let arr = [];
    try { arr = store.get(cacheKey, []) || []; } catch (e) { arr = []; }
    if (!Array.isArray(arr) || !arr.length) return;
    const now = Date.now() / 1000;
    for (const raw of arr) {
      if (!raw || !raw.rpid || !raw.message) continue;
      if (raw.ctime && now - raw.ctime > 86400 * 30) continue;
      if (REPLIES.has(String(raw.rpid))) continue;
      const rec = {
        rpid: String(raw.rpid),
        message: raw.message,
        oid: raw.oid || (currentOid() && currentOid().oid) || '',
        type: raw.type || '1',
        uname: raw.uname || '未知用户',
        mid: raw.mid || '',
        avatar: raw.avatar || '',
        ctime: raw.ctime || 0,
        like: raw.like || 0,
        location: raw.location || '',
        level: raw.level || 0,
        rcount: raw.rcount || 0,
        ats: Array.isArray(raw.ats) ? raw.ats : [],
        childMids: Array.isArray(raw.childMids) ? raw.childMids : [],
        parent: raw.parent || '',
        root: raw.root || '',
        score: 0,
        hits: [],
      };
      const ev = evaluate(rec);
      rec.score = ev.score;
      rec.hits = ev.hits;
      REPLIES.set(rec.rpid, rec);
      rememberLoc(rec);
      refreshAI(rec);
    }
    log('缓存恢复', AI.size, '条');
  }

  function saveCacheSoon() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      try {
        if (!cacheKey) cacheKey = computeCacheKey();
        const arr = [];
        for (const rpid of AI) {
          const rec = REPLIES.get(rpid);
          if (!rec) continue;
          arr.push({
            rpid: rec.rpid, message: rec.message, oid: rec.oid, type: rec.type,
            uname: rec.uname, mid: rec.mid, avatar: rec.avatar, location: rec.location,
            level: rec.level, ctime: rec.ctime, like: rec.like, score: rec.score,
            rcount: rec.rcount || 0, ats: rec.ats || [], childMids: rec.childMids || [],
            parent: rec.parent || '', root: rec.root || '',
            hits: rec.hits,
          });
        }
        store.set(cacheKey, arr.slice(0, 120));
      } catch (e) {}
    }, 800);
  }

  /* ══════════════════════════════════════════════════════════════
   * 8. 鱼塘页（就地切换）
   * ══════════════════════════════════════════════════════════════ */

  let pondEl = null;
  let pondListEl = null;
  let pondOn = false;
  let pondSig = '';
  let searchKW = '';

  function findFeed() {
    const scope = commentScope();
    if (!scope) return null;
    for (const sel of ['#feed', '.reply-list', '.comment-list', '.reply-item', '.bili-comments-list']) {
      const el = deepQueryOne(scope, sel);
      if (!el) continue;
      return sel.startsWith('.reply-item') ? (el.parentElement || el) : el;
    }
    const card = deepQueryOne(scope, 'bili-comment-thread-renderer')
      || deepQueryOne(scope, 'bili-comment-renderer')
      || deepQueryOne(scope, '.reply-item');
    return card ? (card.parentElement || null) : null;
  }

  function buildPond() {
    const el = document.createElement('div');
    el.className = 'fp-pond';
    el.hidden = true;

    const bar = document.createElement('div');
    bar.className = 'fp-pond-bar';

    const title = document.createElement('span');
    title.className = 'fp-pond-title';
    title.innerHTML = iconTag('fp-icon-title') + ' 鱼塘 <i>0</i>';

    const spacer = document.createElement('span');
    spacer.className = 'fp-spacer';

    const search = document.createElement('input');
    search.className = 'fp-search';
    search.placeholder = '搜正文 / UP主';
    search.addEventListener('input', () => { searchKW = search.value.trim(); renderPond(true); });

    const scanBtn = document.createElement('button');
    scanBtn.className = 'fp-mini';
    scanBtn.dataset.act = 'scan';
    scanBtn.textContent = '扫全部';
    scanBtn.title = '翻页扫描该视频的全部评论';

    const sortBtn = document.createElement('button');
    sortBtn.className = 'fp-mini';
    sortBtn.dataset.act = 'sort';
    sortBtn.textContent = CFG.sort === 'time' ? '时间↓' : '分数↓';

    const exitBtn = document.createElement('button');
    exitBtn.className = 'fp-mini';
    exitBtn.dataset.act = 'exit';
    exitBtn.textContent = '← 回到全部评论';

    bar.append(title, spacer, search, scanBtn, sortBtn, exitBtn);

    const info = document.createElement('div');
    info.className = 'fp-scaninfo';

    pondListEl = document.createElement('div');
    pondListEl.className = 'fp-pond-list';

    el.append(bar, info, pondListEl);
    el.__title = title;
    el.__sortBtn = sortBtn;
    el.__scanBtn = scanBtn;
    el.__info = info;
    el.addEventListener('click', onPondClick);
    el.addEventListener('mouseover', onPondOver);
    el.addEventListener('mouseleave', () => scheduleHideUserCard());
    return el;
  }

  function currentList() {
    const out = [];
    for (const rpid of AI) {
      const rec = REPLIES.get(rpid);
      if (!rec) continue;
      if (searchKW) {
        const kw = searchKW.toLowerCase();
        if (!(rec.message.toLowerCase().includes(kw) || (rec.uname || '').toLowerCase().includes(kw))) continue;
      }
      out.push(rec);
    }
    out.sort((a, b) => {
      const sa = isSuspect(a) ? 1 : 0;
      const sb = isSuspect(b) ? 1 : 0;
      if (sa !== sb) return sb - sa;              // 疑似（高赞/有回复）排在最前
      return CFG.sort === 'time'
        ? (b.ctime || 0) - (a.ctime || 0)
        : (b.score || 0) - (a.score || 0);
    });
    return out;
  }

  /** 统计：扫到多少、收了多少、各条规则各放过了多少（用于鱼塘页那行说明） */
  let scanTotalSeen = 0;
  function summarize() {
    const out = { total: REPLIES.size, pond: AI.size, suspect: 0, atup: 0, noat: 0, low: 0, apiTotal: scanTotal || 0 };
    const upMid = VIP.upMid || detectUp();
    for (const [, rec] of REPLIES) {
      if (AI.has(rec.rpid)) continue;
      const q = /^\s*回复\s*@\s*([^\s:：]{1,24})\s*[:：]\s*/.exec(rec.message || '');
      const body = q ? rec.message.slice(q[0].length) : (rec.message || '');
      if (upMid && ((rec.ats || []).indexOf(String(upMid)) !== -1 || (VIP.upName && body.indexOf('@' + VIP.upName) !== -1))) { out.atup++; continue; }
      if (CFG.requireAt && !RE_AT.test(body)) { out.noat++; continue; }
      out.low++;
    }
    try { out.suspect = [...AI].filter((rpid) => { const r = REPLIES.get(rpid); return r && isSuspect(r); }).length; } catch (e) {}
    return out;
  }

  function renderPond(force) {
    if (!pondEl || !pondListEl) return;
    updatePondTitle();
    // 注意不要把 REPLIES.size 放进签名：拉取子回复会让它变大，
    // 导致整页重渲染、把已展开的回复和按钮节点都换掉
    const sig = AI.size + '|' + searchKW + '|' + CFG.sort + '|' + (scanTotal || 0);
    if (!force && sig === pondSig) return;
    pondSig = sig;

    if (pondEl.__info) {
      const st = summarize();
      const parts = ['扫到 ' + st.total + ' 条'];
      if (st.apiTotal && st.total < st.apiTotal * 0.8) parts.push('（该视频共 ' + st.apiTotal + ' 条，接口只给了这些，点「扫全部」可再试）');
      parts.push('鱼塘 ' + st.pond);
      if (st.suspect) parts.push('其中疑似 ' + st.suspect + ' 条（已置顶）');
      const ex = [];
      if (st.atup) ex.push('@UP 放过 ' + st.atup);
      if (st.noat) ex.push('没@ 放过 ' + st.noat);
      if (ex.length) parts.push(ex.join(' · '));
      pondEl.__info.textContent = parts.join(' · ');
    }

    const list = currentList();
    const frag = document.createDocumentFragment();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'fp-empty';
      empty.innerHTML = searchKW
        ? '没搜到。<br>换个关键词试试？'
        : iconTag() + ' 这里还没有鱼<br>这页评论区暂时没发现带 <b>@</b> 的 AI/推广评论';
      frag.appendChild(empty);
    } else {
      for (const rec of list) frag.appendChild(renderCard(rec));
    }
    pondListEl.textContent = '';
    pondListEl.appendChild(frag);
  }

  /** 某条评论已有的子回复（按时间正序） */
  // 子回复接口不返回 IP 属地，用同一作者的其它评论补
  function rememberLoc(rec) {
    if (rec && rec.mid && rec.location) MID_LOC.set(String(rec.mid), rec.location);
  }
  function locOf(rec) {
    if (!rec) return '';
    if (rec.location) { rememberLoc(rec); return rec.location; }
    return MID_LOC.get(String(rec.mid || '')) || '';
  }

  function childrenOf(rpid) {
    const id = String(rpid);
    const out = [];
    for (const [, r] of REPLIES) {
      if (r.rpid === id) continue;
      if (String(r.root || '') === id || String(r.parent || '') === id) out.push(r);
    }
    out.sort((a, b) => (a.ctime || 0) - (b.ctime || 0));
    return out;
  }

  // 最近一次拉子回复的结果（调试用）
  const REPLY_FETCH = { code: null, msg: '', url: '', tried: 0, variant: '', hasLocation: null };

  /** 拉一条评论的楼中楼：三种请求变体依次尝试，失败原因记到 REPLY_FETCH */
  async function fetchReplies(rec, pn) {
    const ctx = currentOid();
    const oid = String(rec.oid || (ctx && ctx.oid) || (currentOid() || {}).oid || '');
    const type = String(rec.type || (ctx && ctx.type) || '1');
    if (!oid) { REPLY_FETCH.code = 'no-oid'; REPLY_FETCH.msg = '缺少 oid'; return 0; }

    const base = 'https://api.bilibili.com/x/v2/reply/reply?type=' + encodeURIComponent(type)
      + '&oid=' + encodeURIComponent(oid)
      + '&root=' + encodeURIComponent(rec.rpid)
      + '&ps=20&pn=' + (pn || 1);

    // 顺序很重要：B 站只有在**登录态**（请求带 Cookie）时才给子回复返回
    // reply_control.location。跨域 fetch 默认不带 Cookie，所以必须最先带 credentials
    const variants = [
      { name: 'cred', url: base, init: { credentials: 'include' } },
      { name: 'plain', url: base, init: undefined },
      { name: 'wbi', url: null, init: { credentials: 'include' } },
    ];

    REPLY_FETCH.tried = 0;
    const before = REPLIES.size;
    for (const v of variants) {
      let url = v.url;
      try {
        if (!url) {
          const key = await getWbiKey();
          url = 'https://api.bilibili.com/x/v2/reply/reply?' + wbiQuery({ type, oid, root: String(rec.rpid), ps: 20, pn: pn || 1 }, key);
        }
      } catch (e) { continue; }
      REPLY_FETCH.tried++;
      try {
        const r = await fetch(url, v.init);
        const json = await r.json();
        REPLY_FETCH.code = json && json.code;
        REPLY_FETCH.msg = (json && json.message) || '';
        REPLY_FETCH.url = url.slice(0, 160);
        if (json && json.code === 0) {
          const withLoc = ((json.data && json.data.replies) || []).filter((r) => r && r.reply_control && r.reply_control.location).length;
          REPLY_FETCH.hasLocation = withLoc > 0;
          REPLY_FETCH.variant = v.name;
          walkReplyTree(json, { oid, type, mode: '3' }, 0, true);
          saveCacheSoon();
          if (REPLIES.size > before) return REPLIES.size - before;
          // code 0 但没有数据：说明这条确实没楼中楼
          return 0;
        }
        warn('子回复接口 [' + v.name + ']', json && json.code, json && json.message);
      } catch (e) {
        REPLY_FETCH.code = 'net';
        REPLY_FETCH.msg = String(e && e.message || e);
        warn('子回复请求 [' + v.name + '] 失败', e);
      }
    }
    return REPLIES.size - before;
  }

  function renderReplyRow(r) {
    const row = document.createElement('div');
    row.className = 'fp-reply';

    const av = document.createElement('span');
    av.className = 'fp-reply-av';
    const face = normalizeAvatar(r.avatar) || '';
    if (face) {
      const img = document.createElement('img');
      img.src = face;
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => { img.remove(); av.textContent = (r.uname || '?').slice(0, 1); });
      av.appendChild(img);
    } else {
      av.textContent = (r.uname || '?').slice(0, 1);
    }
    av.dataset.act = 'user';
    av.dataset.mid = r.mid || '';
    av.dataset.rpid = r.rpid || '';

    const who = document.createElement('a');
    who.className = 'fp-reply-who';
    who.textContent = r.uname || '匿名';
    who.dataset.act = 'user';
    who.dataset.mid = r.mid || '';
    who.dataset.rpid = r.rpid || '';
    who.href = r.mid ? 'https://space.bilibili.com/' + r.mid : 'javascript:void(0)';
    who.target = '_blank';
    who.rel = 'noreferrer noopener';

    const txt = document.createElement('span');
    txt.className = 'fp-reply-txt';
    txt.textContent = r.message;

    const meta = document.createElement('span');
    meta.className = 'fp-reply-meta';
    const rloc = locOf(r);
    meta.textContent = formatTime(r.ctime)
      + (rloc ? ' · IP属地：' + rloc : '')
      + (r.like ? ' · 👍 ' + r.like : '');
    if (rloc && !r.location) meta.title = '该回复接口不返回 IP，取自同作者其它评论';

    row.append(av, who, txt, meta);
    return row;
  }

  // 已展开的评论（重渲染后要还原）
  const EXPANDED = new Set();

  /** 把子回复填进卡片（不拉接口，只渲染已有的） */
  function fillReplies(card, rec, loading) {
    if (!card) return null;
    let box = card.querySelector('.fp-replies');
    if (!box) {
      box = document.createElement('div');
      box.className = 'fp-replies';
      const bodyEl = card.querySelector('.fp-body') || card;
      bodyEl.appendChild(box);
    }
    box.textContent = '';
    if (loading) { box.textContent = '正在加载回复…'; return box; }
    const kids = childrenOf(rec.rpid);
    if (!kids.length) {
      box.textContent = rec.rcount
        ? '（没取到回复：code=' + REPLY_FETCH.code + (REPLY_FETCH.msg ? ' ' + REPLY_FETCH.msg : '') + '）'
        : '（暂无回复）';
      return box;
    }
    for (const k of kids.slice(0, 60)) box.appendChild(renderReplyRow(k));
    if ((rec.rcount || 0) > kids.length) {
      const more = document.createElement('div');
      more.className = 'fp-reply-more';
      more.textContent = '还有 ' + ((rec.rcount || 0) - kids.length) + ' 条回复未加载';
      box.appendChild(more);
    }
    return box;
  }

  function cardOf(rpid) {
    if (!pondEl) return null;
    const id = String(rpid).replace(/"/g, '');
    return deepQueryOne(pondEl, '.fp-card[data-rpid="' + id + '"]');
  }

  /** 展开 / 收起某条评论的子回复 */
  async function toggleReplies(rpid) {
    const id = String(rpid);
    const rec = REPLIES.get(id);
    if (!rec) return;
    const card = cardOf(id);

    if (EXPANDED.has(id)) {
      EXPANDED.delete(id);
      const box = card && card.querySelector('.fp-replies');
      if (box) box.remove();
      return;
    }
    EXPANDED.add(id);
    if (card) fillReplies(card, rec, childrenOf(id).length < (rec.rcount || 0));

    if (childrenOf(id).length < (rec.rcount || 0)) {
      await fetchReplies(rec, 1);
      // 拉完可能触发过重渲染，重新取卡片再填
      const card2 = cardOf(id);
      if (card2) fillReplies(card2, rec, false);
    } else {
      const card2 = cardOf(id);
      if (card2) fillReplies(card2, rec, false);
    }
  }

  /* ── 用户卡片：悬停头像/昵称弹出 ── */
  const USER_CACHE = new Map();
  let userCardEl = null;
  let userCardTimer = 0;
  let userCardFor = '';

  async function fetchUserStats(mid) {
    const key = String(mid);
    if (USER_CACHE.has(key)) return USER_CACHE.get(key);
    const stats = { fans: null, following: null };
    try {
      const r = await fetch('https://api.bilibili.com/x/relation/stat?vmid=' + encodeURIComponent(key), { credentials: 'include' });
      const j = await r.json();
      if (j && j.code === 0 && j.data) {
        stats.fans = j.data.follower;
        stats.following = j.data.following;
      }
    } catch (e) {}
    USER_CACHE.set(key, stats);
    return stats;
  }

  function ensureUserCard() {
    if (userCardEl && userCardEl.isConnected) return userCardEl;
    userCardEl = document.createElement('div');
    userCardEl.className = 'fp-ucard';
    userCardEl.dataset.act = 'ucard';
    userCardEl.addEventListener('mouseenter', () => { clearTimeout(userCardTimer); });
    userCardEl.addEventListener('mouseleave', () => { scheduleHideUserCard(); });
    (pondEl || document.body).appendChild(userCardEl);
    return userCardEl;
  }

  function hideUserCard() {
    if (userCardEl) userCardEl.style.display = 'none';
    userCardFor = '';
  }

  function scheduleHideUserCard() {
    clearTimeout(userCardTimer);
    userCardTimer = setTimeout(hideUserCard, 220);
  }

  async function showUserCard(anchorEl, mid, rpid) {
    const rec = rpid ? REPLIES.get(String(rpid)) : null;
    const id = String(mid || (rec && rec.mid) || '');
    if (!id) return;
    const card = ensureUserCard();
    userCardFor = id;
    card.style.display = 'block';
    card.innerHTML = '';
    card.dataset.mid = id;

    const uname = (rec && rec.uname) || '用户 ' + id;
    const faceSrc = normalizeAvatar((rec && rec.avatar) || '') || '';

    const head = document.createElement('div');
    head.className = 'fp-ucard-head';
    const face = document.createElement('div');
    face.className = 'fp-ucard-face';
    if (faceSrc) { const img = document.createElement('img'); img.src = faceSrc; img.referrerPolicy = 'no-referrer'; face.appendChild(img); }
    else face.textContent = uname.slice(0, 1);
    const info = document.createElement('div');
    info.className = 'fp-ucard-info';
    const name = document.createElement('div');
    name.className = 'fp-ucard-name';
    name.textContent = uname;
    if (rec && rec.level) {
      const lv = document.createElement('span');
      lv.className = 'fp-lv';
      lv.textContent = 'LV' + rec.level;
      name.appendChild(lv);
    }
    const statsEl = document.createElement('div');
    statsEl.className = 'fp-ucard-stats';
    statsEl.textContent = '加载中…';
    info.append(name, statsEl);
    head.append(face, info);

    const btns = document.createElement('div');
    btns.className = 'fp-ucard-btns';
    const home = document.createElement('a');
    home.className = 'fp-ucard-btn primary';
    home.textContent = '个人主页';
    home.href = 'https://space.bilibili.com/' + id;
    home.target = '_blank';
    home.rel = 'noreferrer noopener';
    const msg = document.createElement('a');
    msg.className = 'fp-ucard-btn';
    msg.textContent = '发消息';
    msg.href = 'https://message.bilibili.com/#/whisper/mid' + id;
    msg.target = '_blank';
    msg.rel = 'noreferrer noopener';
    btns.append(home, msg);

    card.append(head, btns);

    // 定位到触发元素附近
    try {
      const r = anchorEl.getBoundingClientRect();
      const cw = 300;
      let left = r.left;
      if (left + cw > window.innerWidth - 12) left = Math.max(12, window.innerWidth - cw - 12);
      const top = r.bottom + 8 + window.scrollY;
      card.style.left = Math.round(left + window.scrollX) + 'px';
      card.style.top = Math.round(top) + 'px';
      card.style.width = cw + 'px';
    } catch (e) {}

    const st = await fetchUserStats(id);
    if (userCardFor !== id) return;
    const parts = [];
    if (st.following != null) parts.push(st.following + ' 关注');
    if (st.fans != null) parts.push(st.fans + ' 粉丝');
    statsEl.textContent = parts.length ? parts.join(' · ') : '（粉丝数取不到）';
  }

  function renderCard(rec) {
    const card = document.createElement('div');
    card.className = 'fp-card';
    card.dataset.rpid = rec.rpid;

    const av = document.createElement('div');
    av.className = 'fp-av';
    av.dataset.act = 'user';
    av.dataset.mid = rec.mid || '';
    av.dataset.rpid = rec.rpid || '';
    if (rec.avatar) {
      const img = document.createElement('img');
      img.src = rec.avatar;
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => { img.remove(); av.textContent = (rec.uname || '?').slice(0, 1); });
      av.appendChild(img);
    } else {
      av.textContent = (rec.uname || '?').slice(0, 1);
    }

    const body = document.createElement('div');
    body.className = 'fp-body';

    const top = document.createElement('div');
    top.className = 'fp-top';
    const uname = document.createElement('a');
    uname.className = 'fp-uname';
    uname.textContent = rec.uname || '未知用户';
    uname.dataset.act = 'user';
    uname.dataset.mid = rec.mid || '';
    uname.dataset.rpid = rec.rpid || '';
    uname.href = rec.mid ? 'https://space.bilibili.com/' + rec.mid : 'javascript:void(0)';
    uname.target = '_blank';
    uname.rel = 'noreferrer noopener';
    top.appendChild(uname);
    if (rec.level) {
      const lv = document.createElement('span');
      lv.className = 'fp-lv';
      lv.textContent = 'LV' + rec.level;
      top.appendChild(lv);
    }
    const aiTag = document.createElement('span');
    aiTag.className = 'fp-ai';
    aiTag.textContent = 'AI ' + rec.score;
    top.appendChild(aiTag);

    const text = document.createElement('div');
    text.className = 'fp-text';
    text.textContent = rec.message;

    const meta = document.createElement('div');
    meta.className = 'fp-meta';
    const mt = document.createElement('span');
    mt.textContent = formatTime(rec.ctime);
    meta.appendChild(mt);
    if (rec.location) {
      const ml = document.createElement('span');
      ml.textContent = 'IP属地：' + rec.location;
      meta.appendChild(ml);
    }
    const ml3 = document.createElement('span');
    ml3.textContent = '👍 ' + (rec.like || 0);
    meta.appendChild(ml3);
    if (rec.rcount) {
      const mr = document.createElement('button');
      mr.type = 'button';
      mr.className = 'fp-reply-toggle';
      mr.dataset.act = 'replies';
      mr.dataset.for = rec.rpid;
      mr.textContent = '💬 ' + rec.rcount + ' 条回复';
      mr.title = '展开 / 收起回复';
      meta.appendChild(mr);
    }
    if (isSuspect(rec)) {
      const ms = document.createElement('span');
      ms.className = 'fp-sus';
      ms.textContent = '疑似';
      meta.appendChild(ms);
    }

    body.append(top, text, meta);
    card.append(av, body);
    // 重渲染后把已展开的子回复还原回去
    if (rec.rcount && EXPANDED.has(String(rec.rpid))) {
      try { fillReplies(card, rec, false); } catch (e) {}
    }
    return card;
  }

  function updatePondTitle() {
    if (!pondEl || !pondEl.__title) return;
    const n = pondEl.__title.querySelector('i');
    if (n) n.textContent = AI.size;
  }

  function onPondOver(e) {
    if (!e.target || !e.target.closest) return;
    const el = e.target.closest('[data-act="user"]');
    if (!el || !pondEl || !pondEl.contains(el)) return;
    clearTimeout(userCardTimer);
    const mid = el.dataset.mid;
    if (!mid) return;
    if (userCardFor === String(mid) && userCardEl && userCardEl.style.display === 'block') return;
    userCardTimer = setTimeout(() => showUserCard(el, mid, el.dataset.rpid), 260);
  }

  function onPondClick(e) {
    const actEl = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!actEl) return;
    const act = actEl.dataset.act;
    if (act === 'exit') { setPond(false); return; }
    if (act === 'ucard') { return; }
    if (act === 'user') { return; }
    if (act === 'scan') { scanAll(); return; }
    if (act === 'replies') {
      const id = actEl.dataset.for || (actEl.closest('.fp-card') || {}).dataset && actEl.closest('.fp-card').dataset.rpid;
      if (id) toggleReplies(id);
      return;
    }
    if (act === 'sort') {
      CFG.sort = CFG.sort === 'time' ? 'score' : 'time';
      pondEl.__sortBtn.textContent = CFG.sort === 'time' ? '时间↓' : '分数↓';
      renderPond(true);
    }
  }

  function hideFeed(feed) {
    if (!feed) return;
    try {
      feed.dataset.fpFeedHidden = '1';
      feed.style.setProperty('display', 'none', 'important');
    } catch (e) {}
  }

  function showFeed(feed) {
    const f = feed || (pondEl && pondEl.__feed);
    if (!f) return;
    try {
      f.style.removeProperty('display');
      delete f.dataset.fpFeedHidden;
    } catch (e) {}
  }

  function ensurePond() {
    const feed = findFeed();
    if (!feed) return false;

    if (!pondEl || pondEl.__feed !== feed || !pondEl.isConnected) {
      if (pondEl && pondEl.isConnected) { try { pondEl.remove(); } catch (e) {} }
      pondEl = buildPond();
      pondEl.__feed = feed;
      try { feed.insertAdjacentElement('afterend', pondEl); } catch (e) { warn('插入鱼塘失败', e); return false; }
      injectShadowCSS(feed.getRootNode ? feed.getRootNode() : null);
    } else if (pondEl.previousElementSibling !== feed) {
      try { feed.insertAdjacentElement('afterend', pondEl); } catch (e) {}
    }
    if (pondOn) {
      hideFeed(feed);
      pondEl.hidden = false;
      renderPond();
    }
    return true;
  }

  function setPond(on) {
    try { hideUserCard(); } catch (e) {}
    if (on === pondOn) return;
    if (on) {
      pondOn = true;
      if (!ensurePond()) {
        pondOn = false;
        toast('没找到评论区，先把评论区展开试试');
        return;
      }
      pondEl.hidden = false;
      hideFeed(pondEl.__feed);
      renderPond(true);
    } else {
      pondOn = false;
      showFeed((pondEl && pondEl.__feed) || findFeed());
      if (pondEl) pondEl.hidden = true;
    }
    updateTabState();
  }

  function togglePond() { setPond(!pondOn); }

  /** 点“最新/最热”这类原生排序时自动切回评论区 */
  const SORT_LABELS = { '最新': 1, '最热': 1, '按时间': 1, '按热度': 1, '最多点赞': 1, '最多回复': 1, '最新发布': 1 };

  function installPondExitHook() {
    document.addEventListener('click', (e) => {
      if (!pondOn) return;
      const path = (e.composedPath && e.composedPath()) || [e.target];
      for (const node of path) {
        if (!node || node.nodeType !== 1) continue;
        if (node.closest && node.closest('.fp-pond, .fp-tab')) return;
        const t = (node.textContent || '').trim();
        if (t && t.length <= 8 && SORT_LABELS[t]) { setPond(false); return; }
      }
    }, true);
  }

  /* ══════════════════════════════════════════════════════════════
   * 9. 页签
   * ══════════════════════════════════════════════════════════════ */

  let tabEl = null;

  const EXCLUDE_TAGS = {
    'BILI-COMMENT-THREAD-RENDERER': 1,
    'BILI-COMMENT-RENDERER': 1,
    'BILI-COMMENT-REPLY-RENDERER': 1,
    'BILI-COMMENT-REPLY-ITEM': 1,
    'BILI-COMMENT-USER-RENDERER': 1,
  };
  const EXCLUDE_CLASS = { 'reply-item': 1, 'sub-reply-item': 1, 'reply-item-wrap': 1, 'comment-item': 1 };

  function insideCommentCard(el) {
    let p = el;
    let guard = 0;
    while (p && guard++ < 30) {
      if (p.nodeType === 1) {
        const tag = (p.tagName || '').toUpperCase();
        if (EXCLUDE_TAGS[tag]) return true;
        if (p.id && p.id.indexOf('fp-') === 0) return true;
        if (p.classList) {
          for (const c of p.classList) if (EXCLUDE_CLASS[c]) return true;
          if (p.classList.contains('fp-tab') || p.classList.contains('fp-card') || p.classList.contains('fp-pond')) return true;
        }
      }
      p = p.parentNode || p.host || null;
    }
    return false;
  }

  function deepest(el, stopAt) {
    let d = 0;
    let p = el;
    while (p && p !== stopAt) { d++; p = p.parentNode || p.host || null; }
    return d;
  }

  function findSortAnchor() {
    const scope = commentScope();
    if (!scope) return null;

    const latest = [];
    const hot = [];

    const scanTexts = (root, target) => {
      if (!root) return;
      try {
        const walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */, null);
        let n = walker.nextNode();
        while (n) {
          const data = (n.data || '').trim();
          if (data && data.length <= 12 && n.parentElement) {
            if (data === '最新' || data === '按时间' || data === '最新发布') target.latest.push(n.parentElement);
            else if (data === '最热' || data === '按热度' || data === '最多点赞' || data === '最多回复') target.hot.push(n.parentElement);
            else if (data.includes('最新')) target.latest.push(n.parentElement);
          }
          n = walker.nextNode();
        }
      } catch (e) {}
    };

    const target = { latest, hot };
    scanTexts(scope, target);
    if (scope.shadowRoot) scanTexts(scope.shadowRoot, target);
    for (const sr of shadowRoots) {
      const host = sr.host;
      if (!host) continue;
      const tag = String(host.tagName || '');
      if (/HEADER/i.test(tag) || /^BILI-COMMENTS$/i.test(tag) || (scope && (host === scope || sr === scope.shadowRoot))) {
        scanTexts(sr, target);
      }
    }
    if (!latest.length && !hot.length) {
      for (const sr of shadowRoots) scanTexts(sr, target);
      if (!latest.length && !hot.length) scanTexts(document.documentElement, target);
    }

    const pick = (list) => list.filter((el) => el && el.isConnected && el.parentNode && !insideCommentCard(el));

    let cands = pick(latest);
    if (!cands.length) cands = pick(hot);
    if (!cands.length) return null;

    const exact = cands.filter((el) => SORT_LABELS[(el.textContent || '').trim()]);
    if (exact.length) cands = exact;

    cands.sort((a, b) => deepest(b, scope) - deepest(a, scope));

    for (const el of cands) {
      let rect = null;
      try { rect = el.getBoundingClientRect(); } catch (e) { rect = null; }
      if (rect && (rect.width === 0 || rect.height === 0)) continue;
      return el;
    }
    return null;
  }

  function makeTab() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fp-tab';
    const sep = document.createElement('span');
    sep.className = 'fp-tab-sep';
    sep.textContent = '|';            // 和原站「最热 | 最新」同款分隔符
    const icon = document.createElement('span');
    icon.className = 'fp-tab-icon';
    icon.innerHTML = iconTag();
    const text = document.createElement('span');
    text.className = 'fp-tab-text';
    text.textContent = '鱼塘';
    const count = document.createElement('i');
    count.className = 'fp-tab-count' + (AI.size ? '' : ' zero');
    count.textContent = AI.size;
    btn.dataset.fpVer = VERSION;   // 版本标记：多个实例并存时用于判定谁该留下
    btn.append(sep, icon, text, count);
    btn.title = '只看被收走的 AI/推广评论';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePond();
    });
    return btn;
  }

  function updateTabState() {
    if (!tabEl || !tabEl.isConnected) return;
    tabEl.classList.toggle('active', pondOn);
  }

  function updateTabCount() {
    if (tabEl && tabEl.isConnected) {
      const badge = tabEl.querySelector('.fp-tab-count');
      if (badge) {
        badge.textContent = AI.size;
        badge.classList.toggle('zero', AI.size === 0);
      }
    }
    updatePondTitle();
  }

  function ensureTab() {
    if (!CFG.enabled) {
      if (tabEl && tabEl.isConnected) tabEl.remove();
      return;
    }
    if (tabEl && tabEl.isConnected) {
      dedupeTabs(tabEl);
      updateTabCount();
      updateTabState();
      return;
    }

    const anchor = findSortAnchor();
    if (!anchor || !anchor.parentNode) return;

    // 已有页签（另一个脚本实例插的 / tabEl 引用丢了）→ 认领它，别再插一枚
    const existing = anchor.parentNode.querySelector('.fp-tab');
    if (existing) {
      // 旧版本（无版本标记或标记不同）插的页签 → 换成本版本的，避免一直显示旧图标
      const sameVer = existing.dataset && existing.dataset.fpVer === VERSION;
      if (sameVer && existing.querySelector('.fp-tab-count')) {
        tabEl = existing;
        dedupeTabs(existing);
      } else {
        // 不是本脚本的页签（旧实例 / 别的写法）→ 替换成我们的，保证计数和点击都正常
        const btn = makeTab();
        try { existing.replaceWith(btn); } catch (e) { existing.remove(); anchor.insertAdjacentElement('afterend', btn); }
        tabEl = btn;
        dedupeTabs(btn);
      }
      updateTabCount();
      updateTabState();
      return;
    }

    const btn = makeTab();
    try {
      injectShadowCSS(anchor.getRootNode());
      anchor.insertAdjacentElement('afterend', btn);
    } catch (e) { warn('插入页签失败', e); return; }
    try {
      const cs = getComputedStyle(anchor);
      const size = parseFloat(cs.fontSize) || 13;
      btn.style.fontSize = Math.min(size, 14) + 'px';   // 和「最热 / 最新」同级，不抢戏
      btn.style.fontFamily = cs.fontFamily;
      btn.style.fontWeight = cs.fontWeight;
      btn.style.lineHeight = cs.lineHeight;
    } catch (e) {}
    tabEl = btn;
    dedupeTabs(btn);
    updateTabCount();
    updateTabState();
    log('鱼塘页签已插入');
  }

  /** 同一容器里如果有多枚页签（多个脚本实例），只留第一枚 */
  function dedupeTabs(keepEl) {
    try {
      const parent = keepEl && keepEl.parentNode;
      if (!parent) return;
      const all = parent.querySelectorAll('.fp-tab');
      for (let i = 0; i < all.length; i++) {
        if (all[i] !== keepEl) all[i].remove();
      }
    } catch (e) {}
  }

  /* ══════════════════════════════════════════════════════════════
   * 10. DOM 兜底
   * ══════════════════════════════════════════════════════════════ */

  const hiddenCards = new Map();   // rpid -> [element]

  function hideCard(el, rpid) {
    if (!el || !el.style) return;
    if (el.dataset.fpHidden === '1') return;
    el.dataset.fpHidden = '1';
    el.style.setProperty('display', 'none', 'important');
    if (rpid) {
      const arr = hiddenCards.get(rpid) || [];
      if (!arr.includes(el)) arr.push(el);
      hiddenCards.set(rpid, arr);
    }
  }

  const CARD_SELECTOR = 'bili-comment-thread-renderer, bili-comment-renderer, .reply-item, .sub-reply-item';

  function isCardEl(el) {
    if (!el || el.nodeType !== 1) return false;
    try { return el.matches(CARD_SELECTOR); } catch (e) { return false; }
  }

  function findCommentData(el) {
    if (!el) return null;
    if (el.__data && (el.__data.rpid || el.__data.rpid_str)) return el.__data;
    const visit = (node, depth) => {
      if (!node || depth > 3) return null;
      let kids = [];
      try { kids = node.children || []; } catch (e) { kids = []; }
      for (const k of kids) {
        if (k.__data && (k.__data.rpid || k.__data.rpid_str)) return k.__data;
        if (k.shadowRoot) {
          for (const s of k.shadowRoot.children || []) {
            if (s.__data && (s.__data.rpid || s.__data.rpid_str)) return s.__data;
          }
        }
        const deeper = visit(k, depth + 1);
        if (deeper) return deeper;
      }
      return null;
    };
    return visit(el, 0);
  }

  function considerData(data) {
    if (!data) return null;
    const rpid = String(data.rpid || data.rpid_str || '');
    if (!rpid) return null;
    // 每次都走 registerReply：正文没变时它会同步赞/回复数等可变字段并重新判定
    const out = registerReply(data, { oid: '', type: '1' });
    return (out && out.rec) ? out.rec : (REPLIES.get(rpid) || null);
  }

  /** 单张卡片即时判定：命中就当场隐藏（绘制之前） */
  function hideIfAI(el) {
    if (!el || el.nodeType !== 1 || el.dataset.fpHidden === '1') return false;
    if (!CFG.enabled || !CFG.hideNative || !CFG.domFallback) return false;

    let data = el.__data;
    if (!data && el.querySelector) {
      try {
        const inner = el.querySelector('bili-comment-renderer');
        if (inner) data = inner.__data;
      } catch (e) {}
    }
    if (data && (data.rpid || data.rpid_str)) {
      const rec = considerData(data);
      if (rec && AI.has(rec.rpid)) {
        let target = el;
        try {
          const root = el.getRootNode && el.getRootNode();
          const host = root && root.host;
          if (host && /^BILI-COMMENT-THREAD-RENDERER$/.test(host.tagName || '') && host.childElementCount <= 2) target = host;
        } catch (e) {}
        hideCard(target, rec.rpid);
        if (target !== el) hideCard(el, rec.rpid);
        return true;
      }
      return false;
    }
    if (el.classList && (el.classList.contains('reply-item') || el.classList.contains('sub-reply-item'))) {
      return hideLegacyCard(el);
    }
    return false;
  }

  function hideLegacyCard(el) {
    if (!el || el.dataset.fpHidden === '1') return false;
    let text = '';
    try {
      const msgEl = el.querySelector('.reply-content, .reply-content-container, .sub-reply-content') || el;
      text = normalizeText(msgEl.textContent);
    } catch (e) { return false; }
    if (!text) return false;
    for (const [rpid, needle] of NEEDLES) {
      if (text.includes(needle)) { hideCard(el, rpid); return true; }
    }
    return false;
  }

  function syncNativeDom(force) {
    if (!CFG.enabled || !CFG.hideNative || !CFG.domFallback) return 0;
    if (pondOn && !force) return 0;
    const scope = commentScope();
    if (!scope) return 0;

    let hidden = 0;
    for (const th of deepQueryAll(scope, 'bili-comment-thread-renderer')) {
      if (th.__data && hideIfAI(th)) hidden++;
    }
    for (const r of deepQueryAll(scope, 'bili-comment-renderer')) {
      if (!r.__data) continue;
      const rec = considerData(r.__data);
      if (!rec || !AI.has(rec.rpid)) continue;
      hideCard(r, rec.rpid);
      hidden++;
      try {
        const root = r.getRootNode && r.getRootNode();
        const host = root && root.host;
        if (host && /^BILI-COMMENT-(THREAD-)?RENDERER$/.test(host.tagName || '') && host.childElementCount <= 2) {
          hideCard(host, rec.rpid);
        }
      } catch (e) {}
    }
    for (const el of deepQueryAll(scope, '.reply-item, .reply-item-wrap, .sub-reply-item')) {
      if (hideLegacyCard(el)) hidden++;
    }
    return hidden;
  }

  /* ══════════════════════════════════════════════════════════════
   * 11. 同步 / 观察
   * ══════════════════════════════════════════════════════════════ */

  let uiTimer = 0;
  function bumpUI() {
    if (uiTimer) return;
    uiTimer = setTimeout(() => {
      uiTimer = 0;
      updateTabCount();
      saveCacheSoon();
      if (pondOn) renderPond();
    }, 120);
  }

  let sweepPending = 0;
  let sweepScheduledAt = 0;

  function sweep(delay) {
    const d = delay == null ? 260 : delay;
    if (sweepPending && Date.now() - sweepScheduledAt < 800) return;
    clearTimeout(sweepPending);
    sweepScheduledAt = Date.now();
    sweepPending = setTimeout(() => {
      sweepPending = 0;
      if (!CFG.enabled) {
        if (tabEl && tabEl.isConnected) tabEl.remove();
        if (pondEl) pondEl.hidden = true;
        return;
      }
      injectCSS();
      try {
        if (!(window.fetch && window.fetch.__fpPatched)) patchFetch();
        if (!(window.XMLHttpRequest && window.XMLHttpRequest.prototype.__fpPatched)) patchXHR();
      } catch (e) {}
      discoverShadowRoots(document);
      ensureTab();
      if (pondOn) ensurePond();
      else syncNativeDom(true);
      updateTabCount();
      updateTabState();
      if (pondOn) renderPond();
    }, d);
  }

  const observedRoots = new WeakSet();
  let observer = null;

  function watchNode(node) {
    if (!observer || !node) return;
    try {
      if (observedRoots.has(node)) return;
      observer.observe(node, { childList: true, subtree: true });
      observedRoots.add(node);
    } catch (e) {}
  }

  function handleAddedNode(node) {
    if (!node || node.nodeType !== 1) return;
    if (!CFG.enabled || !CFG.hideNative || !CFG.domFallback) return;

    if (node.shadowRoot) {
      registerShadow(node.shadowRoot);
      watchNode(node.shadowRoot);
      let inner = [];
      try { inner = node.shadowRoot.querySelectorAll(CARD_SELECTOR); } catch (e) { inner = []; }
      for (const c of inner) hideIfAI(c);
    }
    if (!commentScope()) return;
    if (isCardEl(node)) hideIfAI(node);
    if (!node.querySelectorAll) return;
    let cards = [];
    try { cards = node.querySelectorAll(CARD_SELECTOR); } catch (e) { cards = []; }
    for (const c of cards) hideIfAI(c);
    let hosts = [];
    try { hosts = node.querySelectorAll('bili-comments, bili-comment-thread-renderer, bili-comment-renderer'); } catch (e) { hosts = []; }
    for (const h of hosts) {
      if (!h.shadowRoot) continue;
      registerShadow(h.shadowRoot);
      watchNode(h.shadowRoot);
      let inner = [];
      try { inner = h.shadowRoot.querySelectorAll(CARD_SELECTOR); } catch (e) { inner = []; }
      for (const c of inner) hideIfAI(c);
    }
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((records) => {
      let touched = false;
      for (const r of records) {
        const t = r.target;
        if (t && t.nodeType === 1) {
          try {
            if (t.closest && t.closest('.fp-pond, #fp-toast, .fp-tab')) continue;
          } catch (e) {}
        }
        for (const n of r.addedNodes || []) {
          if (n.nodeType !== 1) continue;
          touched = true;
          handleAddedNode(n);
        }
        if (r.removedNodes && r.removedNodes.length) touched = true;
      }
      if (!touched) return;
      if (!tabEl || !tabEl.isConnected) sweep(400);
      else bumpUI();
    });
    watchNode(document.documentElement);
    sweep(0);
  }

  /* ══════════════════════════════════════════════════════════════
   * 12. 启动
   * ══════════════════════════════════════════════════════════════ */

  function onKeydown(e) {
    if (e.key === 'Escape' && pondOn) setPond(false);
  }

  let lastHref = location.href;
  function onNav() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    log('页面切换', location.pathname);
    if (pondEl && pondEl.__feed) showFeed(pondEl.__feed);
    if (tabEl) { try { tabEl.remove(); } catch (e) {} }
    tabEl = null;
    pondEl = null;
    pondListEl = null;
    pondOn = false;
    pondSig = '';
    scopeHit = null;
    scopeAt = 0;
    shadowRoots.clear();
    REPLIES.clear();
    AI.clear();
    NEEDLES.clear();
    COUNTED.clear();
    hiddenCards.clear();
    cacheKey = '';
    loadCache();
    sweep(600);
  }

  function hookHistory() {
    const wrap = (name) => {
      const raw = history[name];
      if (typeof raw !== 'function') return;
      history[name] = function () {
        const ret = raw.apply(this, arguments);
        setTimeout(onNav, 60);
        return ret;
      };
    };
    wrap('pushState');
    wrap('replaceState');
    window.addEventListener('popstate', () => setTimeout(onNav, 60));
    window.addEventListener('hashchange', () => setTimeout(onNav, 60));
  }

  function boot() {
    injectCSS();
    loadCache();
    startObserver();
    installPondExitHook();
    hookHistory();
    document.addEventListener('keydown', onKeydown, true);

    sweep(0);
    setInterval(() => {
      if (document.hidden || !CFG.enabled) return;
      sweep(0);
    }, 6000);

    setInterval(() => {
      if (document.hidden || !CFG.enabled) return;
      if (!tabEl || !tabEl.isConnected) {
        discoverShadowRoots(commentScope() || document);
        ensureTab();
      }
      updateTabCount();
    }, 1000);

    log('已启动 v' + VERSION + ' · 阈值 ' + CFG.threshold + '（必须有 @）');

    // 调试入口（只读）。Tampermonkey 沙箱里 window 是隔离的，
    // 必须挂到 unsafeWindow 才能在页面控制台访问到
    try {
      PAGE_WIN.__fishpond = {
        version: VERSION,
        get cfg() { return CFG; },
        get pond() { return [...AI].map((r) => REPLIES.get(r)).filter(Boolean); },
        get scanned() { return [...REPLIES.values()]; },
        replyFetch: () => ({ ...REPLY_FETCH }),
        diag() {
          const scope = commentScope();
          const cards = scope ? deepQueryAll(scope, 'bili-comment-thread-renderer').length : 0;
          return {
            version: VERSION,
            hooks: {
              fetch: !!(window.fetch && window.fetch.__fpPatched),
              xhr: !!(window.XMLHttpRequest && window.XMLHttpRequest.prototype.__fpPatched),
            },
            api: { seen: NET.seen, pruned: NET.pruned, urls: [...NET.urls].slice(0, 6), byMode: NET.byMode },
            replies: REPLIES.size,
            pond: AI.size,
            counted: COUNTED.size,
            domCards: cards,
            domHidden: hiddenCards.size,
            shadowRoots: shadowRoots.size,
            hasScope: !!scope,
            vip: { upMid: VIP.upMid || detectUp() || '', upName: VIP.upName },
            levelWeights: { '0-1': 4, '2-3': 2, '4': 0, '5': -2, '6': -3 },
            likeExempt: LIKE_EXEMPT,
            tab: !!(tabEl && tabEl.isConnected),
            scanning,
            anchor: !!findSortAnchor(),
            pondOn,
            cfg: CFG,
          };
        },
        judge(rpid) { const r = REPLIES.get(String(rpid)); return r ? judge(r) : null; },
        score: (t) => scoreComment(t),
        verdict: (t, uname) => evaluate({ message: t, uname: uname || '' }),
        check(t, uname, opts) {
          const o = opts || {};
          const rec = {
            rpid: '__probe__', message: String(t || ''), uname: uname || '',
            level: Number(o.level) || 0,
            like: Number(o.like) || 0,
            rcount: Number(o.rcount) || 0,
            ats: Array.isArray(o.ats) ? o.ats.map(String) : [],
            score: 0, hits: [],
          };
          const ev = evaluate(rec);
          rec.score = ev.score;
          rec.hits = ev.hits;
          return { score: ev.score, hits: ev.hits, at: RE_AT.test(rec.message), ai: judge(rec) };
        },
        open: () => setPond(true),
        close: () => setPond(false),
      };
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
