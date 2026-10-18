// ==UserScript==
// @name            B站鱼塘 · AI评论收集器
// @namespace       https://github.com/Heidiefu27/bilibili-fishpond
// @version         1.6.2
// @description     把评论区里“明显AI生成/推广文案”的评论从原评论区收走，集中放进“最热/最新”旁边的【鱼塘】页；就在原评论区位置就地切换，不开浮窗；支持手动投喂(Alt+点击)、放回、搜索、复制、导出
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
// @grant           GM_registerMenuCommand
// @noframes
// @license         MIT
// ==/UserScript==

/*
 * 原理
 * ────────────────────────────────────────────────────────────────
 * 1) document-start 处挂 fetch / XMLHttpRequest 钩子，拦下评论区接口
 *    （/x/v2/reply*，新版是 /x/v2/reply/wbi/main，mode=3 就是“最新”）。
 * 2) 每条评论按“AI/推广味”打分：标点结构、总结腔、功能罗列腔、DSH/插件话题、
 *    ID 带“鱼/鲸”、@某人、文案与其他评论高度重复（查重）… 分数 ≥ 阈值 → 进鱼塘。
 * 3) 判定的评论直接从返回的 JSON 里 splice 掉 → 原评论区根本不渲染它，
 *    没有空白坑、不会闪一下（比事后 display:none 干净）。
 * 4) “最热/最新”右边生成一个【🐟 鱼塘 N】页签；点它就在**原评论区的位置**
 *    换成鱼塘列表（排版照原评论区：头像 / 昵称 / 等级 / 正文 / 时间 / IP / 点赞，
 *    外加 AI 分和人工操作），点“最新/最热”或“← 回到全部评论”就换回来。
 * 5) DOM 兜底：万一接口没拦住（或页面用了缓存），再按文本把卡片藏掉。
 *
 * 快捷键：Alt+F 开/关鱼塘；Alt+点击任意一条评论 = 手动投进鱼塘。
 * 判定错了：每条鱼都有【放回评论区】，刷新后回到正常列表。
 */

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════
   * 0. 基础
   * ══════════════════════════════════════════════════════════════ */

  const VERSION = '1.6.2';
  const TAG = '%c[鱼塘]';
  const TAG_CSS = 'color:#00AEEC;font-weight:700';
  const log = (...a) => { try { console.log(TAG, TAG_CSS, ...a); } catch (e) {} };
  const warn = (...a) => { try { console.warn('[鱼塘]', ...a); } catch (e) {} };

  const NS = 'fishpond';
  const K_CFG = NS + ':cfg';
  const K_FORCE = NS + ':force';       // { rpid: 'ai' | 'human' } 人工纠正
  const K_CACHE = NS + ':cache:';      // 按页面缓存鱼塘（刷新后仍在）

  const DEFAULT_CFG = {
    enabled: true,      // 总开关
    hideNative: true,   // 从原评论区收走（拦截接口数据，推荐）
    domFallback: true,  // 接口没拦住时按文本兜底隐藏
    showReasons: true,  // 显示判定依据
    requireAt: true,    // 硬性门槛：没 @ 别人的一律不收（这波水军必带 @）
    threshold: 6,       // 分数 ≥ 阈值 → 进鱼塘
    sort: 'score',      // score | time
  };

  /* ══════════════════════════════════════════════════════════════
   * 1. 存储（油猴 API 优先，回退 localStorage）
   * ══════════════════════════════════════════════════════════════ */

  const hasGM = (() => {
    try { return typeof GM_getValue === 'function'; } catch (e) { return false; }
  })();

  const store = {
    get(key, def) {
      try {
        if (hasGM) {
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
        if (hasGM) GM_setValue(key, val);
        else localStorage.setItem(key, JSON.stringify(val));
      } catch (e) { warn('存储失败', key, e); }
    },
    del(key) {
      try {
        if (hasGM && typeof GM_deleteValue === 'function') GM_deleteValue(key);
        else localStorage.removeItem(key);
      } catch (e) {}
    },
  };

  let CFG = Object.assign({}, DEFAULT_CFG, store.get(K_CFG, {}) || {});
  let FORCE = store.get(K_FORCE, {}) || {};

  const saveCfg = () => store.set(K_CFG, CFG);
  const saveForce = () => store.set(K_FORCE, FORCE);

  /* ══════════════════════════════════════════════════════════════
   * 2. 打分
   *    scoreComment(text) 只看正文；
   *    evaluate(rec)      再加 ID / @ / 话题等外部特征。
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
      // 评测式好评：“操作很流畅”“挺顺手”
      [/(很|挺|比较|非常|特别|蛮|相当)(流畅|顺手|丝滑|好用|方便|舒服|稳定|快捷|省事|好使)/, 2, '好评腔(II)'],
      // 测评口吻：像在写产品评测（“最实用的是…”“这段最实用”“更戳我”“没短板”“很给面子了”）
      [/(最实用|最有用|最值得|最戳我|更戳我|没短板|短板|我反而|诚意|这个细节比|把瑕疵|摆出来|小工具|这类工具|给面子|给足了|有点东西)/, 3, '测评口吻'],
      // 评价/表态腔：接住视频里的某句再表态（“这句我认”“太对了”“思路对”）
      [/(这句我认|这话我认|这句服|太对了|说得对|思路对|确实是这样|这点我赞同)/, 3, '评价表态腔'],
      // 比较收益腔：跟“原来那样”比一比来夸（“比来回跟它描述省事多了”）
      [/比.{0,12}(省事|省心|方便|好用|快|强|舒服|顺)(多)?了/, 2, '比较收益腔'],
      // 比喻/等价解释：把功能讲成“等于给它一块常驻黑板/草稿纸”
      [/(等于|相当于|等同于).{0,14}(给它|给ta|往它|贴|塞|摆|留)/, 3, '比喻解释腔'],
      // 建议/试用腔：“你试试”“这个可以试试”“慢慢看”
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

    /* ---------- 带货 / 推广结构 ---------- */
    const ability = cnt(/(能|可以|支持|还能|都能|全在|都在)/g);
    if (ability >= 2) add(dun >= 2 ? 3 : 2, dun >= 2 ? '功能罗列腔' : '功能罗列');
    if (/(要是|如果|假如).{0,26}就(真|彻底|完美|更好|没短板|无短板|稳了|齐了|完美了)/.test(s)) add(2, '假设句式');
    // 复制粘贴的产品 slug（dsh-sticky-notes-desktop 这类三段以上英文连字符名）
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

    /* ---------- 无人味加成：长、完整、无任何人类痕迹 ---------- */
    // 带第一人称的（“我觉得/我用了…”）基本是真人，不给这个加成
    if (comma >= 2 && n >= 35 && humanMarks.length === 0 && !/(我|咱|俺)/.test(s)) add(3, '无任何人味特征');

    const score = hits.reduce((a, h) => a + (h.w || 0), 0);
    hits.sort((a, b) => b.w - a.w);
    return { score, hits };
  }
  /* __SCORE_BLOCK_END__ */

  // 外部特征里用到的关键词
  const RE_ID_FISH = /鱼|鲸/;                         // 发送者 ID 带“鱼/鲸”——这波水军的特征
  const RE_AT = /@\s*[^\s@]{1,24}/;                    // @ 了别人（推广文案几乎必带，注意 B 站有“@ 名字”带空格的写法）
  const RE_TOPIC = /(DSH|DeepSeek|便签|插件|草稿纸|agent|GitHub|开源|模型|字体|配色|订阅|安装|设置里)/gi;

  const normKey = (s) => String(s == null ? '' : s).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  const grams = (s, n) => {
    const set = new Set();
    for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n));
    return set;
  };
  const jaccard = (a, b) => {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    const small = a.size < b.size ? a : b;
    const big = a.size < b.size ? b : a;
    for (const g of small) if (big.has(g)) inter++;
    return inter / (a.size + b.size - inter);
  };

  /* ══════════════════════════════════════════════════════════════
   * 3. 评论数据登记 / 剔除
   * ══════════════════════════════════════════════════════════════ */

  const REPLIES = new Map();   // rpid -> record
  const AI = new Set();        // 进鱼塘的 rpid
  const NEEDLES = new Map();   // rpid -> 文本 needle（DOM 兜底用）
  const DUP = new Set();       // 文案与其他评论高度重复的 rpid
  const COUNTED = new Set();   // 已经扣过“评论 N”的 rpid（最热/最新重复请求时不重复扣）

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
      return { oid: '', type: '1' };
    }
  }

  function normalizeAvatar(a) {
    if (!a) return '';
    if (a.startsWith('//')) return 'https:' + a;
    return a;
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

  function buildHref(rpid) {
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/);
    if (m) return location.origin + '/video/' + m[1] + '#reply' + rpid;
    return location.origin + location.pathname + location.search + '#reply' + rpid;
  }

  /** 打分：正文 + ID/@/话题 */
  function evaluate(rec) {
    const base = scoreComment(rec.message);
    const hits = base.hits.slice();
    let score = base.score;
    const msg = rec.message || '';
    const name = rec.uname || '';

    if (RE_ID_FISH.test(name)) { score += 2; hits.push({ w: 2, name: 'ID 带鱼/鲸' }); }
    if (RE_AT.test(msg)) { score += 2; hits.push({ w: 2, name: '@了别人' }); }

    const topic = msg.match(RE_TOPIC) || [];
    const uniq = new Set(topic.map((t) => t.toLowerCase()));
    if (uniq.size >= 3) { score += 2; hits.push({ w: 2, name: 'DSH/插件话题' }); }
    else if (/DSH|DeepSeek/i.test(msg)) { score += 1; hits.push({ w: 1, name: '提到 DSH' }); }

    // 安利式 @人：@某人 + 推荐/好评词 + 一点口语痕迹都没有（水军最常见的一类短评）
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

  function judge(rec) {
    if (!rec) return false;
    const ov = FORCE[rec.rpid];
    if (ov === 'ai') return true;
    if (ov === 'human') return false;
    if (DUP.has(rec.rpid)) return true;          // 文案查重命中：直接进鱼塘
    // 硬性门槛①：这波水军必然 @ 了某个人；没 @ 的一律当正常人处理
    if (CFG.requireAt && !RE_AT.test(rec.message || '')) return false;
    // 硬性门槛②：去掉 @ 之后正文不足 10 字（“@某人 总结邮箱”“@某人 收到”），
    // 不可能是推广文案，阈值调到最低也不收
    const body = String(rec.message || '').replace(RE_AT, '').replace(/\s+/g, '').trim();
    if (body.length < 10) return false;
    return rec.score >= Number(CFG.threshold || 6);
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

    // 重复请求 / 第二遍剔除：数据没变就直接返回当前判定（省一次打分）
    if (prev && prev.key !== undefined && prev.message === message && prev.uname === uname) {
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
      location: pickLocation(reply) || (prev && prev.location) || '',
      level: pickLevel(reply) || (prev && prev.level) || 0,
      href: buildHref(rpid),
      score: 0,
      hits: [],
    };
    const ev = evaluate(rec);
    rec.score = ev.score;
    rec.hits = ev.hits;
    // 查重用的归一化串和 n-gram 缓存
    rec.key = normKey(message);
    rec.g2 = null;
    rec.g3 = null;

    REPLIES.set(rpid, rec);
    refreshAI(rec);
    return { rec, isAI: AI.has(rpid) };
  }

  function gramsOf(rec, n) {
    if (n === 2) { if (!rec.g2) rec.g2 = grams(rec.key, 2); return rec.g2; }
    if (!rec.g3) rec.g3 = grams(rec.key, 3);
    return rec.g3;
  }

  /** 判断两条评论是不是“同一套文案”（水军最爱复制粘贴） */
  function isDupPair(a, b) {
    if (!a || !b || !a.key || !b.key) return false;
    const la = a.key.length;
    const lb = b.key.length;
    const min = Math.min(la, lb);
    const max = Math.max(la, lb);
    if (min < 20) return false;          // 太短的不比，免得“谢谢分享”互相误伤
    if (max > min * 2.5) return false;   // 长度差太多不比
    const g2 = jaccard(gramsOf(a, 2), gramsOf(b, 2));
    if (g2 >= 0.30) return true;
    if (g2 < 0.20) return false;
    const g3 = jaccard(gramsOf(a, 3), gramsOf(b, 3));
    return g3 >= 0.12;
  }

  /** 找一条与它高度重复的评论 */
  function findDup(rec) {
    if (!rec.key || rec.key.length < 20) return null;
    for (const [rpid, o] of REPLIES) {
      if (rpid === rec.rpid) continue;
      if (isDupPair(rec, o)) return o;
    }
    return null;
  }

  function markDup(a, b) {
    if (!a || !b) return false;
    let changed = false;
    if (!DUP.has(a.rpid)) { DUP.add(a.rpid); changed = true; }
    if (!DUP.has(b.rpid)) { DUP.add(b.rpid); changed = true; }
    if (changed) { refreshAI(a); refreshAI(b); }
    return changed;
  }

  /** 全量重建查重（加载缓存 / 改阈值后调一次） */
  function rebuildDup() {
    DUP.clear();
    if (REPLIES.size < 2 || REPLIES.size > 600) return;
    const list = [...REPLIES.values()].filter((r) => r.key && r.key.length >= 20);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (isDupPair(list[i], list[j])) { DUP.add(list[i].rpid); DUP.add(list[j].rpid); }
      }
    }
    for (const rpid of DUP) { const r = REPLIES.get(rpid); if (r) refreshAI(r); }
  }

  /** 递归扫描评论接口的 JSON：登记所有评论，并把 AI 评论从数组里剔掉 */
  function walkReplyTree(node, ctx, depth, noPrune, removedOut) {
    if (!node || typeof node !== 'object' || depth > 9) return 0;
    let removed = 0;

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        const item = node[i];
        if (looksLikeReply(item)) {
          const r = registerReply(item, ctx);
          walkReplyTree(item, ctx, depth + 1, noPrune, removedOut);   // 子回复照常登记
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

  /** 这条评论按其正文是否会被判为 AI（剔除前预判，不写库） */
  function wouldBeAI(reply) {
    const rpid = String(reply.rpid || reply.rpid_str || '');
    const msg = (reply.content && reply.content.message) || '';
    if (!rpid || !msg.trim()) return false;
    const ov = FORCE[rpid];
    if (ov === 'ai') return true;
    if (ov === 'human') return false;
    if (DUP.has(rpid)) return true;
    if (CFG.requireAt && !RE_AT.test(msg)) return false;
    return scoreComment(msg).score >= Number(CFG.threshold || 6);
  }

  function ingestAndPrune(json, url) {
    if (!json || typeof json !== 'object') return 0;
    const ctx = parseCtx(url);

    // 第一遍：只登记、不剔除（要先把这一批都拿到手，才能做文案查重）
    const before = REPLIES.size;
    walkReplyTree(json, ctx, 0, true);
    if (REPLIES.size !== before) {
      for (const [rpid, r] of REPLIES) {
        if (DUP.has(rpid)) continue;
        const d = findDup(r);
        if (d) markDup(r, d);
      }
    }

    // 边角保护：如果这一页会被剔得一条不剩，组件可能以为“没有更多”而停加载，
    // 这种情况就不剔了，交给 DOM 兜底去藏，分页照常。
    let noPrune = !CFG.hideNative;
    try {
      const d = json.data;
      const c = d && d.cursor;
      const arr = d && Array.isArray(d.replies) ? d.replies : null;
      if (arr && arr.length > 1 && c && c.is_end === false) {
        noPrune = arr.every((r) => looksLikeReply(r) && wouldBeAI(r));
      }
    } catch (e) {}

    // 第二遍：真正剔除
    const removedRpids = [];
    const removed = walkReplyTree(json, ctx, 0, noPrune, removedRpids);

    // 每个响应里的 all_count 都是服务端当次给的全量真值，
    // 所以“按本批剔掉几条就扣几条”是幂等的（来回切最热/最新不会累积少算）。
    for (const rp of removedRpids) if (rp) COUNTED.add(rp);   // 仅用于诊断
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
   * 4. 网络钩子（fetch / XHR）
   * ══════════════════════════════════════════════════════════════ */

  // 评论接口：新版 /x/v2/reply/wbi/main（mode=3 就是“最新”）、老版 /x/v2/reply，
  // 以及视频详情里夹带的热评预览（/x/web-interface/view/detail 的 data.Reply）
  const isReplyUrl = (url) => !!url && /\/x\/v2\/reply(\/|\?|$)|x\/web-interface\/view\/detail/.test(String(url));

  // 诊断用：到底有没有拦到评论接口、剔掉了多少
  const NET = { seen: 0, pruned: 0, urls: new Set(), byMode: {} };

  function patchFetch() {
    const raw = window.fetch;
    if (!raw || raw.__fpPatched) return;
    const patched = function (input, init) {
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
          return new Response(JSON.stringify(json), {
            status: res.status,
            statusText: res.statusText,
            headers,
          });
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
   * 5. 影子DOM 工具
   * ══════════════════════════════════════════════════════════════ */

  const SCOPE_SELECTORS = [
    'bili-comments',
    '#commentapp',
    '#comment',
    '.comment-container',
    '.bili-comments',
    '.bili-dyn-comment',
    '#comment-module',
    '#commentModule',
    '.reply-list',
  ];

  // 评论区根节点缓存：MutationObserver 里每个节点都要问一次，不能每次都跑 9 个选择器
  let scopeHit = null;
  let scopeAt = 0;

  function commentScope() {
    const now = Date.now();
    if (now - scopeAt < 1500) {
      if (scopeHit && scopeHit.isConnected) return scopeHit;
      if (!scopeHit) return null;   // 负缓存：这段时间内“没有评论区”也算结论，别反复查
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

  /** 已发现的影子根：避免每次都 querySelectorAll('*') 全树遍历（那样很卡） */
  const shadowRoots = new Set();

  function registerShadow(root) {
    if (!root || !root.host || shadowRoots.has(root)) return;
    shadowRoots.add(root);
    try { watchNode(root); } catch (e) {}
    // 新冒出来的影子根：当场把里面的卡片判一遍（很便宜），省得等下一次全量扫描
    try {
      for (const c of root.querySelectorAll(CARD_SELECTOR)) hideIfAI(c);
    } catch (e) {}
  }

  /** 递归发现影子根（B站把 header / 卡片又各套了一层影子根，必须进去找） */
  function discoverShadowRoots(scope) {
    const root = scope || document;
    const queue = [root];
    if (root && root.shadowRoot) queue.push(root.shadowRoot);   // 自己就是影子宿主
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
        // 只往评论相关的组件里钻，避免去扫播放器/弹幕那些
        const tag = String(el.tagName || '');
        const cls = typeof el.className === 'string' ? el.className : '';
        if (!/^BILI-/.test(tag) && !/comment|reply/i.test(tag) && !/comment|reply/i.test(cls)) continue;
        registerShadow(el.shadowRoot);
        queue.push(el.shadowRoot);
      }
      // 评论区容器本身可能是普通 div，也要收下
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

  /** 穿透 open shadowRoot 的 querySelectorAll（查文档 + 已登记影子根，成本很低） */
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
    // 去重（同一节点可能被多个 scope 命中）
    return out;
  }

  function deepQueryOne(root, selector) {
    const all = deepQueryAll(root, selector);
    return all.length ? all[0] : null;
  }

  /* ══════════════════════════════════════════════════════════════
   * 6. 样式
   * ══════════════════════════════════════════════════════════════ */

  // 标签页样式：会被插进 bili-comments 的 shadowRoot，所以单独一份
  const TAB_CSS = `
  .fp-tab {
    display: inline-flex; align-items: center; gap: 5px;
    margin: 0 0 0 10px; padding: 0 0 0 10px;
    border: 0; border-left: 1px solid rgba(148,158,178,.4);
    background: transparent; cursor: pointer; color: #00AEEC;
    font-weight: 600; line-height: 1.4; font-family: inherit;
    transition: opacity .15s;
  }
  .fp-tab:hover { opacity: .78; }
  .fp-tab.active { color: #F85A54; }
  .fp-tab-count {
    font-style: normal; font-size: 11px; line-height: 16px;
    min-width: 16px; padding: 0 5px; border-radius: 9px;
    background: #F85A54; color: #fff; text-align: center;
  }
  .fp-tab-count.zero { display: none; }
  `;

  // 鱼塘列表样式：就地长在原评论区里，颜色全部继承页面（明暗主题都适配）
  const POND_CSS = `
  .fp-pond { color: inherit; font-family: inherit; padding: 0 0 24px; }
  .fp-pond[hidden] { display: none !important; }
  .fp-pond-bar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 10px 2px 10px; margin-bottom: 4px;
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
    background: rgba(128,136,153,.10); color: inherit; outline: none;
    font-family: inherit;
  }
  .fp-search::placeholder { color: inherit; opacity: .45; }
  .fp-search:focus { border-color: #00AEEC; }
  .fp-mini {
    height: 28px; padding: 0 11px; font-size: 12.5px; cursor: pointer;
    border-radius: 14px; border: 1px solid rgba(128,136,153,.35);
    background: rgba(128,136,153,.10); color: inherit; font-family: inherit;
  }
  .fp-mini:hover { border-color: #00AEEC; color: #00AEEC; }
  .fp-mini.on { border-color: #00AEEC; color: #00AEEC; }

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
    background: rgba(248,90,84,.14); color: #F85A54; font-weight: 700; cursor: pointer;
  }
  .fp-text { font-size: 14px; line-height: 1.72; white-space: pre-wrap; word-break: break-word; }
  .fp-text.clamp { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
  .fp-meta { margin-top: 6px; font-size: 12px; opacity: .55; display: flex; gap: 14px; flex-wrap: wrap; }
  .fp-acts { margin-top: 6px; display: flex; gap: 14px; flex-wrap: wrap; }
  .fp-act {
    border: 0; background: transparent; padding: 0; cursor: pointer;
    font-size: 12px; color: inherit; opacity: .55; font-family: inherit;
  }
  .fp-act:hover { opacity: 1; color: #00AEEC; }
  .fp-act.danger:hover { color: #F85A54; }
  .fp-whys { margin-top: 7px; display: flex; gap: 5px; flex-wrap: wrap; }
  .fp-whys[hidden] { display: none !important; }
  .fp-why {
    font-size: 10.5px; padding: 1px 7px; border-radius: 6px;
    background: rgba(128,136,153,.14); opacity: .8;
  }
  .fp-why.pos { background: rgba(248,90,84,.14); color: #F85A54; opacity: 1; }
  .fp-why.neg { background: rgba(0,174,236,.14); color: #00AEEC; opacity: 1; }

  .fp-empty { padding: 40px 8px; text-align: center; font-size: 13px; line-height: 2; opacity: .6; }
  .fp-empty b { opacity: 1; font-size: 15px; }

  .fp-set {
    display: flex; gap: 18px; flex-wrap: wrap; align-items: center;
    padding: 10px 2px; margin-bottom: 4px; font-size: 12.5px;
    border-bottom: 1px solid rgba(128,136,153,.16);
  }
  .fp-set[hidden] { display: none !important; }
  .fp-set-item { display: flex; align-items: center; gap: 6px; }
  .fp-sw {
    width: 34px; height: 18px; border-radius: 999px; cursor: pointer; border: 0;
    background: rgba(128,136,153,.4); position: relative; padding: 0;
  }
  .fp-sw::after {
    content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
    border-radius: 50%; background: #fff; transition: left .16s;
  }
  .fp-sw.on { background: #00AEEC; }
  .fp-sw.on::after { left: 18px; }
  .fp-range { width: 110px; }
  .fp-val { color: #00AEEC; font-weight: 600; font-variant-numeric: tabular-nums; }
  .fp-hint { width: 100%; font-size: 11.5px; opacity: .5; line-height: 1.6; }

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
    if (document.getElementById('fp-style')) return;
    const style = document.createElement('style');
    style.id = 'fp-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /** 往影子根里补样式（shadow DOM 不继承文档样式） */
  function injectShadowCSS(root) {
    if (!root || !root.host) return;
    try {
      if (root.querySelector('style[data-fp]')) return;
      const style = document.createElement('style');
      style.setAttribute('data-fp', '1');
      style.textContent = CSS;
      root.appendChild(style);
    } catch (e) {}
  }

  /* ══════════════════════════════════════════════════════════════
   * 7. 小工具
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

  async function copyText(txt) {
    try {
      await navigator.clipboard.writeText(txt);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = txt;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        (document.body || document.documentElement).appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e2) { return false; }
    }
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
   * 8. 缓存（刷新页面后鱼塘里还有东西）
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
        oid: raw.oid || '',
        type: raw.type || '1',
        uname: raw.uname || '未知用户',
        mid: raw.mid || '',
        avatar: raw.avatar || '',
        ctime: raw.ctime || 0,
        like: raw.like || 0,
        location: raw.location || '',
        level: raw.level || 0,
        href: raw.href || buildHref(raw.rpid),
        score: 0,
        hits: [],
        key: normKey(raw.message),
        g2: null,
        g3: null,
      };
      const ev = evaluate(rec);
      rec.score = ev.score;
      rec.hits = ev.hits;
      REPLIES.set(rec.rpid, rec);
      refreshAI(rec);
    }
    rebuildDup();
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
            hits: rec.hits, href: rec.href,
          });
        }
        store.set(cacheKey, arr.slice(0, 120));
      } catch (e) {}
    }, 800);
  }

  /* ══════════════════════════════════════════════════════════════
   * 9. 内联鱼塘页（就在原评论区的位置，不开浮窗）
   * ══════════════════════════════════════════════════════════════ */

  let pondEl = null;      // 鱼塘容器
  let pondListEl = null;  // 卡片列表容器
  let pondOn = false;     // 现在是否停在鱼塘页
  let pondSig = '';
  let pondSetOpen = false;
  let searchKW = '';

  function findFeed() {
    const scope = commentScope();
    if (!scope) return null;
    for (const sel of ['#feed', '.reply-list', '.comment-list', '.reply-item', '.bili-comments-list']) {
      const el = deepQueryOne(scope, sel);
      if (!el) continue;
      return sel.startsWith('.reply-item') ? (el.parentElement || el) : el;
    }
    // 退而求其次：第一条评论卡片的父节点
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
    title.innerHTML = '<span>🐟</span> 鱼塘 <i>0</i>';
    const spacer = document.createElement('span');
    spacer.className = 'fp-spacer';

    const search = document.createElement('input');
    search.className = 'fp-search';
    search.placeholder = '搜正文 / UP主';
    search.addEventListener('input', () => { searchKW = search.value.trim(); renderPond(true); });

    const sortBtn = document.createElement('button');
    sortBtn.className = 'fp-mini';
    sortBtn.dataset.act = 'sort';
    sortBtn.textContent = CFG.sort === 'time' ? '时间↓' : '分数↓';
    sortBtn.title = '切换排序';

    const setBtn = document.createElement('button');
    setBtn.className = 'fp-mini' + (pondSetOpen ? ' on' : '');
    setBtn.dataset.act = 'settings';
    setBtn.textContent = '⚙';

    const rescanBtn = document.createElement('button');
    rescanBtn.className = 'fp-mini';
    rescanBtn.dataset.act = 'rescan';
    rescanBtn.textContent = '重扫本页';
    rescanBtn.title = '把当前已渲染的评论再按规则扫一遍';

    const exitBtn = document.createElement('button');
    exitBtn.className = 'fp-mini';
    exitBtn.dataset.act = 'exit';
    exitBtn.textContent = '← 回到全部评论';

    bar.append(title, spacer, search, sortBtn, rescanBtn, setBtn, exitBtn);

    const set = document.createElement('div');
    set.className = 'fp-set';
    set.hidden = true;
    buildSettings(set);

    pondListEl = document.createElement('div');
    pondListEl.className = 'fp-pond-list';

    el.append(bar, set, pondListEl);
    el.addEventListener('click', onPondClick);
    el.__bar = bar;
    el.__set = set;
    el.__title = title;
    el.__setBtn = setBtn;
    el.__sortBtn = sortBtn;
    return el;
  }

  function buildSettings(box) {
    box.textContent = '';
    const addSwitch = (key, label) => {
      const item = document.createElement('span');
      item.className = 'fp-set-item';
      const label2 = document.createElement('span');
      label2.textContent = label;
      const sw = document.createElement('button');
      sw.className = 'fp-sw' + (CFG[key] ? ' on' : '');
      sw.title = '切换';
      sw.addEventListener('click', () => {
        CFG[key] = !CFG[key];
        sw.classList.toggle('on', !!CFG[key]);
        saveCfg();
        if (key === 'domFallback' && !CFG.domFallback) restoreAllDom();
        toast((CFG[key] ? '已开启：' : '已关闭：') + label + (key === 'hideNative' ? '（刷新后完全生效）' : ''));
        sync(150);
      });
      item.append(label2, sw);
      box.appendChild(item);
    };

    addSwitch('requireAt', '必须有 @ 才算');
    addSwitch('hideNative', '从原评论区收走');
    addSwitch('showReasons', '显示判定依据');

    const item = document.createElement('span');
    item.className = 'fp-set-item';
    const lab = document.createElement('span');
    const val = document.createElement('span');
    val.className = 'fp-val';
    val.textContent = CFG.threshold;
    lab.append('阈值 ≥ ', val);
    const range = document.createElement('input');
    range.type = 'range';
    range.className = 'fp-range';
    range.min = '3';
    range.max = '12';
    range.step = '1';
    range.value = CFG.threshold;
    range.addEventListener('input', () => { val.textContent = range.value; CFG.threshold = Number(range.value); });
    range.addEventListener('change', () => {
      saveCfg();
      rebuildDup();
      recompute();
      toast('阈值改为 ' + CFG.threshold);
    });
    item.append(lab, range);
    box.appendChild(item);

    const copyAllBtn = document.createElement('button');
    copyAllBtn.className = 'fp-mini';
    copyAllBtn.dataset.act = 'copyAll';
    copyAllBtn.textContent = '复制全部';
    const exportBtn = document.createElement('button');
    exportBtn.className = 'fp-mini';
    exportBtn.dataset.act = 'export';
    exportBtn.textContent = '导出';
    const restoreAllBtn = document.createElement('button');
    restoreAllBtn.className = 'fp-mini';
    restoreAllBtn.dataset.act = 'restoreAll';
    restoreAllBtn.textContent = '全部放回';
    box.append(copyAllBtn, exportBtn, restoreAllBtn);

    const hint = document.createElement('span');
    hint.className = 'fp-hint';
    hint.textContent = '自动判定要求评论里 @ 了别人（这波水军的固定特征）；不想收就点【放回评论区】。Alt+点击任意评论 = 手动投进鱼塘；Alt+F 开关鱼塘。';
    box.appendChild(hint);
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
    out.sort((a, b) => (CFG.sort === 'time'
      ? (b.ctime || 0) - (a.ctime || 0)
      : (b.score || 0) - (a.score || 0)));
    return out;
  }

  function renderPond(force) {
    if (!pondEl || !pondListEl) return;
    const sig = AI.size + '|' + REPLIES.size + '|' + searchKW + '|' + CFG.sort + '|' + (CFG.showReasons ? 1 : 0) + '|' + DUP.size;
    updatePondTitle();
    if (!force && sig === pondSig) return;
    pondSig = sig;

    const list = currentList();
    const frag = document.createDocumentFragment();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'fp-empty';
      empty.innerHTML = searchKW
        ? '没搜到。<br>换个关键词试试？'
        : '这里还没有鱼 <b>🐟</b><br>这页评论区暂时没发现带 <b>@</b> 的 AI/推广评论<br><span style="font-size:11.5px">按住 <b>Alt</b> 点一条评论，可以手动收进来</span>';
      frag.appendChild(empty);
    } else {
      for (const rec of list) frag.appendChild(renderCard(rec));
    }
    pondListEl.textContent = '';
    pondListEl.appendChild(frag);
  }

  function renderCard(rec) {
    const card = document.createElement('div');
    card.className = 'fp-card';
    card.dataset.rpid = rec.rpid;

    // 头像
    const av = document.createElement('div');
    av.className = 'fp-av';
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

    // 昵称 / 等级 / AI 分
    const top = document.createElement('div');
    top.className = 'fp-top';
    const uname = document.createElement('span');
    uname.className = 'fp-uname';
    uname.textContent = rec.uname || '未知用户';
    top.appendChild(uname);
    if (rec.level) {
      const lv = document.createElement('span');
      lv.className = 'fp-lv';
      lv.textContent = 'LV' + rec.level;
      top.appendChild(lv);
    }
    const aiTag = document.createElement('span');
    aiTag.className = 'fp-ai';
    aiTag.dataset.act = 'why';
    aiTag.textContent = DUP.has(rec.rpid) ? '查重命中' : 'AI ' + rec.score;
    aiTag.title = '点击看判定依据';
    top.appendChild(aiTag);

    // 正文
    const text = document.createElement('div');
    text.className = 'fp-text';
    text.textContent = rec.message;

    // 元信息：时间 / IP属地 / 点赞
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
    if (rec.like) {
      const ml2 = document.createElement('span');
      ml2.textContent = '👍 ' + rec.like;
      meta.appendChild(ml2);
    }

    // 操作
    const acts = document.createElement('div');
    acts.className = 'fp-acts';
    const mkAct = (txt, act, danger) => {
      const b = document.createElement('button');
      b.className = 'fp-act' + (danger ? ' danger' : '');
      b.dataset.act = act;
      b.textContent = txt;
      return b;
    };
    const longMsg = rec.message.length > 220;
    let expandBtn = null;
    if (longMsg) {
      expandBtn = mkAct('展开全文', 'expand');
      expandBtn.addEventListener('click', () => {
        const clamped = text.classList.toggle('clamp');
        expandBtn.textContent = clamped ? '展开全文' : '收起';
      });
      text.classList.add('clamp');
      acts.appendChild(expandBtn);
    }
    acts.append(
      mkAct('复制', 'copy'),
      mkAct('判定依据', 'why'),
      mkAct('放回评论区', 'restore', true),
    );

    // 判定依据
    const whys = document.createElement('div');
    whys.className = 'fp-whys';
    whys.hidden = !CFG.showReasons;
    const allHits = (rec.hits || []).slice();
    if (DUP.has(rec.rpid)) allHits.unshift({ w: 6, name: '文案与其他评论高度重复' });
    const hits = allHits.slice(0, 4);
    if (hits.length) {
      for (const h of hits) {
        const chip = document.createElement('span');
        chip.className = 'fp-why ' + (h.w > 0 ? 'pos' : 'neg');
        chip.textContent = (h.w > 0 ? '+' : '') + h.w + ' ' + h.name;
        whys.appendChild(chip);
      }
      if (allHits.length > hits.length) {
        const more = document.createElement('span');
        more.className = 'fp-why';
        more.textContent = '+' + (allHits.length - hits.length);
        whys.appendChild(more);
      }
    } else {
      const chip = document.createElement('span');
      chip.className = 'fp-why';
      chip.textContent = '人工标记';
      whys.appendChild(chip);
    }

    body.append(top, text, meta, acts, whys);
    card.append(av, body);
    return card;
  }

  function updatePondTitle() {
    if (!pondEl || !pondEl.__title) return;
    const n = pondEl.__title.querySelector('i');
    if (n) n.textContent = AI.size;
  }

  function onPondClick(e) {
    const actEl = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!actEl) return;
    const act = actEl.dataset.act;
    if (act === 'exit') { setPond(false); return; }
    if (act === 'settings') {
      pondSetOpen = !pondSetOpen;
      pondEl.__set.hidden = !pondSetOpen;
      pondEl.__setBtn.classList.toggle('on', pondSetOpen);
      return;
    }
    if (act === 'sort') {
      CFG.sort = CFG.sort === 'time' ? 'score' : 'time';
      saveCfg();
      pondEl.__sortBtn.textContent = CFG.sort === 'time' ? '时间↓' : '分数↓';
      renderPond(true);
      return;
    }
    if (act === 'copyAll') { copyAll(); return; }
    if (act === 'export') { exportJSON(); return; }
    if (act === 'restoreAll') { restoreAll(); return; }
    if (act === 'rescan') {
      const before = AI.size;
      syncNativeDom(true);
      ensureTab();
      updateTabCount();
      renderPond(true);
      const added = AI.size - before;
      toast(added > 0 ? '又捞出 ' + added + ' 条' : '扫完了，没发现新的（池塘共 ' + AI.size + ' 条）');
      return;
    }

    const card = actEl.closest ? actEl.closest('.fp-card') : null;
    const rpid = card && card.dataset.rpid;
    if (!rpid) return;

    if (act === 'copy') {
      const rec = REPLIES.get(rpid);
      if (rec) copyText(rec.message).then((ok) => toast(ok ? '已复制' : '复制失败'));
      return;
    }
    if (act === 'why') {
      const box = card.querySelector('.fp-whys');
      if (box) box.hidden = !box.hidden;
      return;
    }
    if (act === 'restore') { restoreOne(rpid); return; }
    if (act === 'expand') return;   // 由卡片自己的监听处理
  }

  function copyAll() {
    const list = currentList();
    if (!list.length) { toast('鱼塘是空的'); return; }
    const txt = list.map((r) => '【' + r.uname + '】(' + formatTime(r.ctime) + (DUP.has(r.rpid) ? ', 查重命中' : ', AI ' + r.score + '分') + ')\n' + r.message).join('\n\n---\n\n');
    copyText(txt).then((ok) => toast(ok ? '已复制 ' + list.length + ' 条' : '复制失败'));
  }

  function exportJSON() {
    const list = currentList();
    if (!list.length) { toast('鱼塘是空的'); return; }
    const data = JSON.stringify(list.map((r) => ({
      rpid: r.rpid, uname: r.uname, mid: r.mid, ctime: r.ctime, like: r.like,
      location: r.location, message: r.message, score: r.score,
      dup: DUP.has(r.rpid), hits: r.hits,
    })), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bili-fishpond-' + Date.now() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('已导出 ' + list.length + ' 条');
  }

  function restoreOne(rpid) {
    FORCE[rpid] = 'human';
    saveForce();
    AI.delete(rpid);
    NEEDLES.delete(rpid);
    unhideRpid(rpid);
    saveCacheSoon();
    renderPond(true);
    updateTabCount();
    toast('已放回评论区（刷新页面后出现在正常列表里）');
  }

  function restoreAll() {
    if (!AI.size) { toast('鱼塘是空的'); return; }
    let n = 0;
    for (const rpid of AI) {
      FORCE[rpid] = 'human';
      unhideRpid(rpid);
      n++;
    }
    AI.clear();
    NEEDLES.clear();
    saveForce();
    saveCacheSoon();
    renderPond(true);
    updateTabCount();
    toast('已放回 ' + n + ' 条，刷新页面后生效');
  }

  /** 隐藏原列表 / 恢复原列表 */
  function hideFeed(feed) {
    if (!feed) return;
    try {
      feed.dataset.fpFeedHidden = '1';
      feed.style.setProperty('display', 'none', 'important');
    } catch (e) {}
  }

  function showFeed(feed) {
    if (!feed) return;
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

    if (!pondEl || !pondEl.__feed || pondEl.__feed !== feed || !pondEl.isConnected) {
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
      const feed = (pondEl && pondEl.__feed) || findFeed();
      showFeed(feed);
      if (pondEl) pondEl.hidden = true;
    }
    updateTabState();
  }

  function togglePond() { setPond(!pondOn); }

  /** 点“最新/最热”这类原生排序时，自动从鱼塘切回评论区 */
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
   * 10. 原评论区里插“鱼塘”页签
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

  /**
   * 找“最热 / 最新”排序条。
   * 新版评论区整个在 #commentapp > bili-comments 的影子根里，元素名常改，
   * 所以不赌选择器，直接扫文本节点：谁的文字正好是“最新”，就插在谁后面。
   * 坑：评论正文里也会出现“最新”二字（“最新版好用”），必须排除卡片内部。
   */
  function findSortAnchor() {
    const scope = commentScope();
    if (!scope) return null;

    const latest = [];
    const hot = [];

    // 只在“文档 + 已登记的影子根”里扫文本节点：不递归 querySelectorAll('*')，不然很卡
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
    // 只扫“头部/评论区本身”的影子根，不逐个扫 100 多个卡片根（那样会卡）
    for (const sr of shadowRoots) {
      const host = sr.host;
      if (!host) continue;
      const tag = String(host.tagName || '');
      const id = String(host.id || '');
      if (/HEADER/i.test(tag) || /^BILI-COMMENTS$/i.test(tag) || /HEADER/i.test(id) || (scope && (host === scope || sr === scope.shadowRoot))) {
        scanTexts(sr, target);
      }
    }
    if (!latest.length && !hot.length) {
      // 兜底：全扫（只为把页签找回来，偶尔一次无所谓）
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
    const fish = document.createElement('span');
    fish.textContent = '🐟';
    const text = document.createElement('span');
    text.textContent = '鱼塘';
    const count = document.createElement('i');
    count.className = 'fp-tab-count' + (AI.size ? '' : ' zero');
    count.textContent = AI.size;
    btn.append(fish, text, count);
    btn.title = '只看被收走的 AI/推广评论（Alt+F）';
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

  function ensureTab() {
    if (!CFG.enabled) {
      if (tabEl && tabEl.isConnected) tabEl.remove();
      return;
    }
    if (tabEl && tabEl.isConnected) { updateTabCount(); updateTabState(); return; }

    const anchor = findSortAnchor();
    if (!anchor) return;

    const btn = makeTab();
    try {
      if (!anchor.parentNode) return;
      injectShadowCSS(anchor.getRootNode());
      anchor.insertAdjacentElement('afterend', btn);
    } catch (e) { warn('插入标签失败', e); return; }
    try {
      const cs = getComputedStyle(anchor);
      btn.style.fontSize = cs.fontSize;
      btn.style.fontFamily = cs.fontFamily;
      if (parseFloat(cs.fontSize) > 18) btn.style.fontSize = '14px';
    } catch (e) {}
    tabEl = btn;
    updateTabCount();
    updateTabState();
    log('鱼塘页签已插入');
  }

  function updateTabCount() {
    const n = AI.size;
    if (tabEl && tabEl.isConnected) {
      const badge = tabEl.querySelector('.fp-tab-count');
      if (badge) {
        badge.textContent = n;
        badge.classList.toggle('zero', n === 0);
      }
    }
    updatePondTitle();
  }

  /* ══════════════════════════════════════════════════════════════
   * 11. DOM 兜底隐藏
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

  function unhideRpid(rpid) {
    const arr = hiddenCards.get(rpid) || [];
    for (const el of arr) {
      try {
        el.style.removeProperty('display');
        delete el.dataset.fpHidden;
      } catch (e) {}
    }
    hiddenCards.delete(rpid);
  }

  function restoreAllDom() {
    for (const [, arr] of hiddenCards) {
      for (const el of arr) {
        try { el.style.removeProperty('display'); delete el.dataset.fpHidden; } catch (e) {}
      }
    }
    hiddenCards.clear();
  }

  /** 从新版自定义组件里抠出 __data（B站把评论数据挂在元素实例上） */
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

  let lastDomSync = 0;

  /** 把 DOM 卡片自带的数据也纳入登记（接口没拦住时的兜底） */
  function considerData(data) {
    if (!data) return null;
    const rpid = String(data.rpid || data.rpid_str || '');
    if (!rpid) return null;
    let rec = REPLIES.get(rpid);
    if (!rec) {
      const out = registerReply(data, { oid: '', type: '1' });
      rec = out && out.rec ? out.rec : REPLIES.get(rpid) || null;
    }
    return rec;
  }

  const CARD_SELECTOR = 'bili-comment-thread-renderer, bili-comment-renderer, .reply-item, .sub-reply-item';

  function isCardEl(el) {
    if (!el || el.nodeType !== 1) return false;
    try { return el.matches(CARD_SELECTOR); } catch (e) { return false; }
  }

  /**
   * 单张卡片的即时判定：命中就当场隐藏。
   * 这一步在 MutationObserver 回调里同步执行（浏览器绘制之前），
   * 所以即便接口没拦住，也不会出现“先闪一下再消失”。
   */
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
        // 里层 renderer 命中时，把外面那层卡片一起藏，别留半个空行
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

  /** 老版 Vue 评论卡：按正文文本判 */
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

  /** 全量扫描（低频：启动、每 6 秒、点“重扫本页”时） */
  function syncNativeDom(force) {
    if (!CFG.enabled || !CFG.hideNative || !CFG.domFallback) return 0;
    if (pondOn && !force) return 0;   // 正在看鱼塘时不动原列表
    const scope = commentScope();
    if (!scope) return 0;
    lastDomSync = Date.now();

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
   * 12. Alt+点击 手动投喂
   * ══════════════════════════════════════════════════════════════ */

  function findCardFromEvent(e) {
    const path = (e.composedPath && e.composedPath()) || [];
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue;
      const tag = (node.tagName || '').toUpperCase();
      if (tag === 'BILI-COMMENT-THREAD-RENDERER' || tag === 'BILI-COMMENT-RENDERER') return node;
      if (node.classList && (node.classList.contains('reply-item') || node.classList.contains('sub-reply-item'))) return node;
    }
    return null;
  }

  function collectManual(card) {
    const data = findCommentData(card);
    if (!data) { toast('没读到这条评论的数据，换个位置点试试'); return; }
    const rpid = String(data.rpid || data.rpid_str || '');
    const message = (data.content && data.content.message) || '';
    if (!rpid || !message) { toast('这条评论没有正文'); return; }
    let rec = REPLIES.get(rpid);
    if (!rec) {
      rec = registerReply(data, { oid: '', type: '1' });
      rec = rec && rec.rec ? rec.rec : REPLIES.get(rpid);
    }
    if (!rec) return;
    FORCE[rpid] = 'ai';
    saveForce();
    refreshAI(rec);
    hideCard(card, rpid);
    saveCacheSoon();
    updateTabCount();
    if (pondOn) renderPond(true);
    toast('已投进鱼塘 🐟（刷新后这条不会再出现在评论区）');
  }

  function installManualHook() {
    window.addEventListener('click', (e) => {
      if (!e.altKey) return;
      const card = findCardFromEvent(e);
      if (!card) return;
      e.preventDefault();
      e.stopPropagation();
      collectManual(card);
    }, true);
  }

  /* ══════════════════════════════════════════════════════════════
   * 13. 重算 / 同步 / 观察
   * ══════════════════════════════════════════════════════════════ */

  function recompute() {
    pondSig = '';
    for (const [rpid, rec] of REPLIES) {
      const ev = evaluate(rec);
      rec.score = ev.score;
      rec.hits = ev.hits;
      refreshAI(rec);
    }
    for (const rpid of DUP) { const r = REPLIES.get(rpid); if (r) refreshAI(r); }
    restoreAllDom();
    saveCacheSoon();
    updateTabCount();
    if (pondOn) renderPond(true);
    sync();
  }

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

  let syncPending = 0;
  let syncScheduledAt = 0;

  /** 低频全量对齐：发现影子根 → 补页签 → 兜底隐藏 → 刷新计数/鱼塘 */
  function sweep(delay) {
    const d = delay == null ? 260 : delay;
    if (syncPending && Date.now() - syncScheduledAt < 800) return;
    clearTimeout(syncPending);
    syncScheduledAt = Date.now();
    syncPending = setTimeout(() => {
      syncPending = 0;
      if (!CFG.enabled) {
        if (tabEl && tabEl.isConnected) tabEl.remove();
        if (pondEl) pondEl.hidden = true;
        return;
      }
      injectCSS();
      // 站点有可能在后续脚本里改写 window.fetch / XMLHttpRequest，这里补装一次
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

  function sync(delay) { sweep(delay); }

  /* ---- MutationObserver（含影子DOM） ---- */
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

  /**
   * 新节点一进来就同步判一遍（MutationObserver 回调在绘制前执行），
   * 命中的卡片当场隐藏 —— 这是“不闪”的关键。
   */
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
    // 新挂载的自定义组件里可能又套了一层影子根
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
      let sawCards = false;
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
          handleAddedNode(n);     // 同步处理，赶在绘制之前
        }
        if (r.removedNodes && r.removedNodes.length) touched = true;
      }
      if (!touched) return;
      // 轻活：合并刷新计数；重活（全量扫描）交给低频 sweep
      if (!tabEl || !tabEl.isConnected) sync(400);
      else bumpUI();
    });
    watchNode(document.documentElement);
    sweep(0);
  }

  /* ══════════════════════════════════════════════════════════════
   * 14. 启动
   * ══════════════════════════════════════════════════════════════ */

  function installMenu() {
    try {
      if (typeof GM_registerMenuCommand !== 'function') return;
      GM_registerMenuCommand('🐟 打开/关闭鱼塘 (Alt+F)', () => {
        togglePond();
      });
      GM_registerMenuCommand('🐟 从评论区收走 AI 评论：' + (CFG.hideNative ? '开' : '关'), () => {
        CFG.hideNative = !CFG.hideNative;
        saveCfg();
        toast(CFG.hideNative ? '已开启，刷新后完全生效' : '已关闭，刷新后评论区恢复');
      });
      GM_registerMenuCommand('🐟 判定阈值：' + CFG.threshold + '（点一下 +1）', () => {
        CFG.threshold = CFG.threshold >= 12 ? 3 : CFG.threshold + 1;
        saveCfg();
        rebuildDup();
        recompute();
        toast('阈值 → ' + CFG.threshold);
      });
      GM_registerMenuCommand('🐟 清空鱼塘缓存与人工标记', () => {
        store.del(cacheKey || computeCacheKey());
        FORCE = {};
        saveForce();
        toast('已清空，刷新页面生效');
      });
    } catch (e) { warn('菜单注册失败', e); }
  }

  function onKeydown(e) {
    if (e.altKey && (e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      togglePond();
    } else if (e.key === 'Escape' && pondOn) {
      setPond(false);
    }
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
    lastDomSync = 0;
    scopeHit = null;
    scopeAt = 0;
    shadowRoots.clear();
    REPLIES.clear();
    AI.clear();
    NEEDLES.clear();
    DUP.clear();
    COUNTED.clear();
    hiddenCards.clear();
    cacheKey = '';
    loadCache();
    sync(600);
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
    installMenu();
    installManualHook();
    installPondExitHook();
    hookHistory();
    document.addEventListener('keydown', onKeydown, true);

    // 低频兜底：每 6 秒对一次账（发现新影子根、补页签、藏漏网的卡片）。
    // 高频的事都交给 MutationObserver 里的即时处理，避免卡顿。
    sweep(0);
    setInterval(() => {
      if (document.hidden) return;
      if (!CFG.enabled) return;
      sweep(0);
    }, 6000);

    // 便宜的 1 秒心跳：只接管新出现的影子根 + 补页签 + 刷计数
    setInterval(() => {
      if (document.hidden || !CFG.enabled) return;
      if (!tabEl || !tabEl.isConnected) {
        // 页签掉了（组件重渲染/影子根晚挂载）：这里才做一次发现 + 重插
        discoverShadowRoots(commentScope() || document);
        ensureTab();
      }
      updateTabCount();
    }, 1000);

    log('已启动 v' + VERSION + ' · 阈值', CFG.threshold);

    // 调试入口（控制台可用）：__fishpond.diag() 看诊断，__fishpond.pond 看鱼塘
    try {
      window.__fishpond = {
        version: VERSION,
        get cfg() { return CFG; },
        get pond() { return [...AI].map((r) => REPLIES.get(r)).filter(Boolean); },
        get scanned() { return [...REPLIES.values()]; },
        get dup() { return [...DUP]; },
        diag() {
          const cards = [];
          const scope = commentScope();
          if (scope) {
            try { cards.push(...deepQueryAll(scope, 'bili-comment-thread-renderer')); } catch (e) {}
            try { cards.push(...deepQueryAll(scope, '.reply-item')); } catch (e) {}
          }
          return {
            version: VERSION,
            hooks: {
              fetch: !!(window.fetch && window.fetch.__fpPatched),
              xhr: !!(window.XMLHttpRequest && window.XMLHttpRequest.prototype.__fpPatched),
            },
            api: { seen: NET.seen, pruned: NET.pruned, urls: [...NET.urls].slice(0, 6), byMode: NET.byMode },
            replies: REPLIES.size,
            pond: AI.size,
            dup: DUP.size,
            counted: COUNTED.size,
            domCards: cards.length,
            domHidden: hiddenCards.size,
            shadowRoots: shadowRoots.size,
            hasScope: !!commentScope(),
            tab: !!(tabEl && tabEl.isConnected),
            anchor: !!findSortAnchor(),
            pondOn,
            cfg: CFG,
          };
        },
        judge(rpid) { const r = REPLIES.get(String(rpid)); return r ? judge(r) : null; },
        force(rpid, v) {
          const k = String(rpid);
          if (v === 'ai' || v === 'human') FORCE[k] = v; else delete FORCE[k];
          saveForce();
          recompute();
        },
        score: (t) => scoreComment(t),
        verdict: (t, uname) => evaluate({ message: t, uname: uname || '' }),
        // 完整判定（含 @ 门槛）：{ score, hits, at, ai }
        check(t, uname) {
          const rec = { rpid: '__probe__', message: String(t || ''), uname: uname || '', score: 0, hits: [] };
          const ev = evaluate(rec);
          rec.score = ev.score;
          rec.hits = ev.hits;
          return { score: ev.score, hits: ev.hits, at: RE_AT.test(rec.message), ai: judge(rec) };
        },
        rescore: recompute,
        open: () => setPond(true),
        close: () => setPond(false),
        domScan: syncNativeDom,
        needles: () => [...NEEDLES.keys()],
      };
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
