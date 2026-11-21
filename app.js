'use strict';

/* ============================================================
 * Media Insight · 纯静态版核心逻辑（v2.5）
 * 数据源：全球新闻池（同域 news-data.json，GitHub Actions 境外抓取）
 *         / 用户自建 RSS 聚合站
 * v2.4 移除「总结提炼」；v2.5 移除浏览器直连的「实时检索 GDELT」入口。
 * 检索完成即呈现清单与概览；翻译接口仅保留一次「中文话题 → 英文检索词」。
 * 全部在浏览器内运行，无服务端
 * ============================================================ */

const POOL_URL = 'news-data.json';   // 与页面同域，国内浏览器可直接读取
const RSS_URL = 'https://patfang0105.github.io/my-rss-blog/rss-data.json';
const MYMEMORY = 'https://api.mymemory.translated.net/get';

const PAYWALL_DOMAINS = [
  'wsj.com','ft.com','economist.com','bloomberg.com','scmp.com',
  'foreignaffairs.com','foreignpolicy.com','theinformation.com','barrons.com',
  'marketwatch.com','nikkei.com','thetimes.com','telegraph.co.uk','newyorker.com',
  'theatlantic.com','washingtonpost.com','nytimes.com','reuters.com','cnbc.com',
  'project-syndicate.org','oxfordeconomics.com','mckinsey.com','theguardian.com'
];
const PAYWALL_NAMES = [
  'wsj.com','wall street journal','financial times','ft.com','the economist',
  'finance & economics','bloomberg','south china morning post','foreign affairs',
  'fa rss','project syndicate','mckinsey','oxford economics','us top news and analysis',
  'rssopinion','cnbc','nytimes','the guardian'
];

const TIMESPAN_DAYS  = { '24h':1, '7d':7, '30d':30, '180d':180 };
const TIMESPAN_LABEL = { '24h':'最近24小时','7d':'最近7天','30d':'最近30天','180d':'最近180天' };
const SRC_LABEL = { pool:'全球新闻池', rss:'RSS 精选源' };

const STOPWORDS = new Set(('the a an and or but if of to in on at by for from with as is are was were be been being '
  + 'it its this that these those there here their they them he she his her we our you your i me my '
  + 'not no nor so than then too very can will would could should may might must have has had do does did '
  + 'about into over under after before between during through above below up down out off again further '
  + 'once more most other some such only own same s t just don now said says say new one two also which who '
  + 'what when where why how all any both each few more other some such').split(/\s+/));

/* v2.4：态度词、关键句抽取、批量机翻等提炼专用逻辑已移除 */

const state = {
  record: null,
  warnings: []
};

/* ---------------- 全球新闻池：页面同域只读 ----------------
 * 抓取由 GitHub Actions 在境外服务器每 3 小时完成，结果写入仓库的
 * news-data.json。浏览器只读本站点自己的文件，因此不跨境、无 CORS、
 * 不受境外接口限流影响，也完全不触碰 my-rss-blog。
 * --------------------------------------------------------- */
const POOL_SNAPSHOT_KEY = 'mi_pool_snapshot_v1';
let poolCache = null;
let poolMeta = { at:0, count:0, sources:0, generated:'', stale:false, source:'', warnings:[] };

function mapPool(items){
  return (items || []).map(it => ({
    origin: 'pool',
    title: stripHtml(it.title || ''),
    link: it.link || '',
    source: stripHtml(it.source || '') || '未知来源',
    author: '',
    date: it.date || '',
    summary: stripHtml(it.summary || ''),
    country: stripHtml(it.country || ''),
    topic: stripHtml(it.topic || ''),        // 抓取时的中文主题标签，参与相关度打分
    keywords: stripHtml(it.keywords || '')   // 英文关键词，提升中文话题译词的命中率
  }));
}
async function fetchPool(force){
  if(!force && poolCache) return poolCache;
  try{
    // 同域静态文件，尊重 ETag；强制刷新时才加时间戳绕过缓存
    const url = POOL_URL + (force ? '?t=' + Date.now() : '');
    const r = await fetchWithTimeout(url, {cache:'default'}, 20000);
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if(!d || !Array.isArray(d.articles)) throw new Error('新闻池数据格式异常');
    poolCache = mapPool(d.articles);
    poolMeta = {
      at: Date.now(), count: poolCache.length,
      sources: d.sources || new Set(poolCache.map(a => a.source)).size,
      generated: d.generated_at || '', stale: !!d.stale,
      source: '新闻池文件', warnings: Array.isArray(d.warnings) ? d.warnings : []
    };
    try{
      localStorage.setItem(POOL_SNAPSHOT_KEY,
        JSON.stringify({at:Date.now(), meta:poolMeta, items:poolCache}));
    }catch(e){ /* 浏览器配额不足时静默跳过 */ }
    return poolCache;
  }catch(e){
    // 同域文件偶发不可读：降级到本机快照，不反复重试
    try{
      const o = JSON.parse(localStorage.getItem(POOL_SNAPSHOT_KEY) || 'null');
      if(o && o.items && o.items.length){
        poolCache = o.items;
        poolMeta = Object.assign({}, o.meta, {stale:true, source:'本机快照'});
        state.warnings.push('新闻池文件暂不可读（' + e.message + '），已改用本机快照。');
        return poolCache;
      }
    }catch(e2){}
    throw e;
  }
}

/* ---------------- 通用工具 ---------------- */

function esc(s){
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}
function stripHtml(s){
  const d = document.createElement('div');
  d.innerHTML = s || '';
  return (d.textContent || '').replace(/\s+/g,' ').trim();
}
function hasChinese(s){ return /[\u4e00-\u9fff]/.test(s || ''); }
function showError(m){
  const e = document.getElementById('err');
  e.textContent = m; e.style.display = 'block';
  window.scrollTo({top:0, behavior:'smooth'});
}
function hideError(){ document.getElementById('err').style.display = 'none'; }
function setLoading(on, text){
  document.getElementById('loading').style.display = on ? 'block' : 'none';
  if(text) document.getElementById('loadingText').textContent = text;
}
function fetchWithTimeout(url, opts, ms){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 15000);
  return fetch(url, Object.assign({}, opts || {}, {signal: ctrl.signal}))
    .finally(() => clearTimeout(timer));
}
function fmtDate(iso){
  if(!iso) return '日期未知';
  const d = new Date(iso);
  if(isNaN(d.getTime())) return String(iso).slice(0,16);
  return d.toISOString().slice(0,16).replace('T',' ');
}
function isoDay(iso){
  if(!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(5,10);
}
function parseDate(s){
  if(!s) return '';
  if(/^\d{8}T\d{6}Z$/.test(s)){          // 境外媒体库 seendate 格式：20261119T120000Z
    return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8)+'T'+
           s.slice(9,11)+':'+s.slice(11,13)+':'+s.slice(13,15)+'Z';
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}
function textiseUrl(link){
  if(!link) return '';
  return 'https://www.textise.net/showText.aspx?strURL=' +
         encodeURIComponent(encodeURIComponent(link));
}
function isPaywall(a){
  const c = [];
  if(a.link){ try{ c.push(new URL(a.link).hostname.toLowerCase()); }catch(e){} }
  if(a.source) c.push(a.source.toLowerCase());
  return c.some(x => PAYWALL_DOMAINS.some(d => x.includes(d)) || PAYWALL_NAMES.some(n => x.includes(n)));
}
function markAccess(a){
  a.paywall = isPaywall(a);
  a.textise = a.paywall ? textiseUrl(a.link) : '';
  const hasSum = !!(a.summary && a.summary.trim());
  if(a.paywall && hasSum) a.access = '需订阅 · 公开摘要可用';
  else if(a.paywall)      a.access = '需订阅 · 仅标题可用';
  else if(hasSum)         a.access = '公开可访问';
  else                    a.access = '仅标题可用';
  return a;
}
function tokenize(q){
  return (q || '').toLowerCase()
    .replace(/["'`]/g,' ')
    .split(/[\s,;+/&|]+/)
    .map(x => x.trim())
    .filter(x => x.length > 1 && !STOPWORDS.has(x));
}

/* ---------------- 翻译（Google gtx / MyMemory 双接口竞速） ----------------
 * v2.4 起只用于把中文话题译成英文检索词（每次检索最多 1 轮请求），
 * 不再对报道逐篇机翻。两个免费接口并发竞速，谁先成功用谁；
 * 某个接口超时/不可达时不再串行重试，避免把整轮检索拖慢几十秒。
 * ------------------------------------------------------------------ */

/* 翻译结果本机持久化：重复检索同一话题时直接复用，显著减少免费接口请求与限流 */
const TRANS_CACHE_KEY = 'mi_trans_cache_v1';
const transCache = new Map();
(function loadTransCache(){
  try{
    const o = JSON.parse(localStorage.getItem(TRANS_CACHE_KEY) || '{}');
    Object.keys(o).slice(-2000).forEach(k => transCache.set(k, o[k]));
  }catch(e){ /* 缓存损坏时忽略 */ }
})();
let transSaveTimer = null;
function scheduleTransSave(){
  if(transSaveTimer) return;
  transSaveTimer = setTimeout(() => {
    transSaveTimer = null;
    try{
      const o = {};
      [...transCache.entries()].slice(-2000).forEach(([k,v]) => { o[k] = v; });
      localStorage.setItem(TRANS_CACHE_KEY, JSON.stringify(o));
    }catch(e){ /* 浏览器配额不足时静默跳过 */ }
  }, 2000);
}
async function gtx(text, from, to){
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx'
    + '&sl=' + encodeURIComponent(from) + '&tl=' + encodeURIComponent(to)
    + '&dt=t&q=' + encodeURIComponent(text);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try{
    const r = await fetch(url, { signal: ctl.signal });
    if(!r.ok) throw new Error('gtx HTTP ' + r.status);
    const d = await r.json();
    const out = ((d && d[0]) || []).map(x => (x && x[0]) ? x[0] : '').join('').trim();
    if(!out) throw new Error('gtx 未返回译文');
    return out;
  }finally{ clearTimeout(timer); }
}
async function mymemory(text, from, to){
  const url = MYMEMORY + '?' + new URLSearchParams({ q: text.slice(0,450), langpair: from + '|' + to });
  const r = await fetchWithTimeout(url, {}, 7000);
  if(!r.ok) throw new Error('翻译接口 HTTP ' + r.status);
  const d = await r.json();
  let out = (d.responseData && d.responseData.translatedText) || '';
  out = out.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&').trim();
  if(!out || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(out)) throw new Error('翻译接口未返回有效结果');
  return out;
}
/* 并发竞速：任一接口成功即返回，全部失败才抛错（不依赖 Promise.any，兼容旧浏览器） */
function firstFulfilled(promises){
  return new Promise((resolve, reject) => {
    let pending = promises.length;
    const errs = [];
    promises.forEach(p => p.then(resolve, e => {
      errs.push((e && e.message) ? e.message : String(e));
      if(--pending === 0) reject(new Error(errs.join('；') || '翻译接口均不可用'));
    }));
  });
}
async function translateText(text, from, to){
  const key = from + '|' + to + '|' + text;
  if(transCache.has(key)) return transCache.get(key);
  const out = await firstFulfilled([ gtx(text, from, to), mymemory(text, from, to) ]);
  transCache.set(key, out);
  scheduleTransSave();
  return out;
}
async function translateTopic(text){
  if(!text || !hasChinese(text)) return { text: text, ok: !!text };
  try{
    const out = await translateText(text, 'zh-CN', 'en');
    return { text: out, ok: true };
  }catch(e){
    state.warnings.push('中文话题自动翻译失败（' + e.message + '），已改用原文检索，建议在「英文检索词」中手动填写。');
    return { text: text, ok: false };
  }
}

/* ---------------- 数据抓取 ----------------
 * 对 RSS 源站只读引用：不写入、不修改源站任何文件。
 * 策略：本机快照(2h) > 浏览器条件请求(ETag/304) > 失败降级到旧快照且不重试。
 * 目的：把对源站的请求压到最低，源站短暂不可用时工具仍可用。
 * ---------------------------------------- */

const RSS_TTL = 2 * 60 * 60 * 1000;          // 本机快照有效期 2 小时
const RSS_SNAPSHOT_KEY = 'mi_rss_snapshot_v1';
let rssCache = null;                          // 当前页面内缓存
let rssMeta = { at: 0, count: 0, stale: false, source: '' };

function mapRss(items){
  return items.map(it => ({
    origin: 'rss',
    title: stripHtml(it.title),
    link: it.link || '',
    source: stripHtml(it.source) || 'RSS 精选源',
    author: stripHtml(it.author),
    date: parseDate(it.pubDate),
    summary: stripHtml(it.description).slice(0,1400),
    country: ''
  }));
}
function readRssSnapshot(){
  try{
    const o = JSON.parse(localStorage.getItem(RSS_SNAPSHOT_KEY) || 'null');
    return (o && Array.isArray(o.items) && o.items.length && o.at) ? o : null;
  }catch(e){ return null; }
}
function writeRssSnapshot(items){
  try{ localStorage.setItem(RSS_SNAPSHOT_KEY, JSON.stringify({at:Date.now(), items})); }
  catch(e){ /* 浏览器配额不足时静默跳过，不影响检索 */ }
}
async function fetchRss(force){
  if(!force && rssCache) return rssCache;
  const snap = readRssSnapshot();
  // 命中本机快照：本次检索完全不请求源站
  if(!force && snap && (Date.now() - snap.at) < RSS_TTL){
    rssCache = snap.items;
    rssMeta = {at:snap.at, count:snap.items.length, stale:false, source:'本机快照'};
    return rssCache;
  }
  try{
    // 尊重源站 cache-control / ETag，浏览器自动走 304 条件请求；绝不使用 no-store 强制重新拉取
    const r = await fetchWithTimeout(RSS_URL, {cache:'default'}, 35000);
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const items = await r.json();
    if(!Array.isArray(items)) throw new Error('数据源格式异常');
    rssCache = mapRss(items);
    writeRssSnapshot(rssCache);
    rssMeta = {at:Date.now(), count:rssCache.length, stale:false, source:'源站最新'};
    return rssCache;
  }catch(e){
    // 源站异常时降级到旧快照，且不重试、不反复打源站
    if(snap && snap.items && snap.items.length){
      rssCache = snap.items;
      rssMeta = {at:snap.at, count:snap.items.length, stale:true, source:'离线快照'};
      state.warnings.push('数据源暂不可用（' + e.message + '），已改用本机快照（' +
        new Date(snap.at).toLocaleString('zh-CN') + '）；不会反复重试请求源站。');
      return rssCache;
    }
    throw e;
  }
}
async function refreshDataSource(){
  const btn = document.getElementById('refreshBtn');
  const note = document.getElementById('dataNote');
  btn.disabled = true;
  note.textContent = '正在刷新数据源…';
  const parts = [];
  try{
    const p = await fetchPool(true);
    parts.push(`全球新闻池 ${p.length} 篇（生成于 ${poolMeta.generated || '—'}）`);
  }catch(e){ parts.push('新闻池刷新失败：' + e.message); }
  // 只有勾选了 RSS 才去请求你的订阅站，保持零影响
  const rssEl = document.getElementById('srcRss');
  if(rssEl && rssEl.checked){
    try{
      const r = await fetchRss(true);
      parts.push(`RSS 精选源 ${r.length} 篇`);
    }catch(e){ parts.push('RSS 刷新失败：' + e.message); }
  }
  note.textContent = parts.join(' · ');
  btn.disabled = false;
}
/* v2.5：浏览器直连 GDELT 的「实时检索」入口已按需求移除。
 * 新闻池仍由 GitHub Actions 在境外服务器抓取（scripts/fetch_news.py），不受影响。 */

/* ---------------- 检索、打分、统计 ---------------- */

function scoreArticle(a, terms){
  const title = (a.title || '').toLowerCase();
  const summ  = (a.summary || '').toLowerCase();
  // 新闻池条目带有抓取时的中文主题标签与英文关键词，一并参与匹配，
  // 让中文话题译成英文后更容易命中相关报道
  const extra = ((a.author || '') + ' ' + (a.source || '') + ' ' +
                 (a.topic || '') + ' ' + (a.keywords || '')).toLowerCase();
  let s = 0, hitAll = true;
  for(const t of terms){
    let h = 0;
    if(title.includes(t)) h += 3;
    if(summ.includes(t))  h += 1;
    if(extra.includes(t)) h += 1;
    if(h === 0) hitAll = false;
    s += h;
  }
  return { score: s, hitAll };
}
function buildStats(articles){
  const byDay = {}, bySrc = {};
  let paywall = 0, withSummary = 0, poolCount = 0, fromRss = 0;
  for(const a of articles){
    if(a.date){
      const d = isoDay(a.date);
      if(d) byDay[d] = (byDay[d] || 0) + 1;
    }
    const s = a.source || '未知来源';
    bySrc[s] = (bySrc[s] || 0) + 1;
    if(a.paywall) paywall++;
    if(a.summary) withSummary++;
    if(a.origin === 'pool') poolCount++;
    else fromRss++;
  }
  const days = Object.keys(byDay).sort();
  const topSources = Object.entries(bySrc).sort((a,b) => b[1]-a[1]).slice(0,10)
    .map(([source,count]) => ({source,count}));
  const total = articles.length;
  const heat = total >= 50 ? '高' : total >= 20 ? '中' : total > 0 ? '低' : '无命中';
  return {
    total, media_count: Object.keys(bySrc).length, paywall_count: paywall,
    summary_count: withSummary, pool_count: poolCount,
    rss_count: fromRss, heat_label: heat,
    by_day: days.map(day => ({day, count: byDay[day]})),
    top_sources: topSources
  };
}
async function doSearch(preset){
  hideError();
  const topic = (preset && preset.topic) || document.getElementById('topic').value.trim();
  if(!topic){ showError('请输入话题或主题'); return; }
  const sources = [];
  const srcPoolEl = document.getElementById('srcPool');
  if(srcPoolEl && srcPoolEl.checked) sources.push('pool');
  if(document.getElementById('srcRss').checked) sources.push('rss');
  if(!sources.length){ showError('请至少选择一个检索源；推荐勾选「全球新闻池」'); return; }

  const timespan = (preset && preset.timespan) || document.getElementById('timespan').value;
  const mode = document.getElementById('mode').value;
  let enkw = document.getElementById('enkw').value.trim();

  const btn = document.getElementById('goBtn');
  btn.disabled = true;
  setLoading(true, '正在翻译话题并检索境外媒体数据库…');
  document.getElementById('result').classList.add('hidden');
  state.warnings = [];

  try{
    let autoTranslated = false;
    if(!enkw){
      const t = await translateTopic(topic);
      enkw = t.text; autoTranslated = t.ok;
    }
    document.getElementById('enkw').value = enkw;

    setLoading(true, '正在读取全球新闻池并检索所选数据源…');
    const tasks = [];
    const srcErrors = [];
    if(sources.includes('pool')){
      tasks.push(fetchPool().catch(e => {
        srcErrors.push('全球新闻池：' + e.message);
        state.warnings.push('全球新闻池读取失败：' + e.message);
        return [];
      }));
    }
    if(sources.includes('rss')){
      tasks.push(fetchRss().catch(e => {
        srcErrors.push('RSS：' + e.message);
        state.warnings.push('RSS 精选源抓取失败：' + e.message);
        return [];
      }));
    }
    const pool = (await Promise.all(tasks)).flat();

    // 不再自动回退 RSS：用户明确要求「不依赖 RSS 也能检索」，
    // 拉取订阅快照会掩盖真实失败。改为如实报错并给出可操作的建议。
    if(!pool.length){
      throw new Error('本次未取到任何报道' +
        (srcErrors.length ? '（' + srcErrors.join('；') + '）' : '') +
        '。建议：勾选「全球新闻池」（境外服务器每 3 小时更新、页面同域读取，国内网络可用），或稍后重试。');
    }
    // 新闻池自身的告警（例如境外抓取被限流、暂时保留了上次数据）如实带入结果
    if(sources.includes('pool') && poolMeta.warnings && poolMeta.warnings.length){
      poolMeta.warnings.slice(0,3).forEach(w => state.warnings.push('新闻池：' + w));
    }

    const terms = tokenize(enkw || topic);
    // 自动翻译失败时检索词仍是中文，英文报道会被全部过滤；此时改为只按时间范围列出
    const skipMatch = hasChinese(enkw || topic);
    if(skipMatch) state.warnings.push('检索词未能自动译成英文，已按时间范围列出全部报道（未做关键词过滤）；建议在「英文检索词」中手动填写以获得精确结果。');
    const cutoff = Date.now() - (TIMESPAN_DAYS[timespan] || 30) * 86400000;
    let hits = [];
    for(const a of pool){
      if(a.date){ const t = new Date(a.date).getTime(); if(!isNaN(t) && t < cutoff) continue; }
      if(skipMatch){ hits.push({ a, score: 1 }); continue; }
      const { score, hitAll } = scoreArticle(a, terms);
      if(score <= 0) continue;
      if(mode === 'all' && !hitAll) continue;
      hits.push({ a, score });
    }
    // 关键词完全没命中时也要给出可用结果，并如实说明，避免「0 篇」让人以为工具坏了
    if(!hits.length && pool.length){
      state.warnings.push('检索词「' + (enkw || topic) + '」未在本次数据中命中；已放宽为按时间范围列出最多 60 篇。全球新闻池按预设的长期话题定期抓取，冷门或突发话题可能尚未入池，可换个检索词、缩短英文检索词，或稍后再试（新闻池每 3 小时更新）。');
      hits = pool.filter(a => !a.date || isNaN(new Date(a.date).getTime()) ||
                              new Date(a.date).getTime() >= cutoff)
                 .slice(0, 60).map(a => ({ a, score: 1 }));
    }
    hits.sort((x,y) => (y.score - x.score) ||
      ((new Date(y.a.date||0).getTime()||0) - (new Date(x.a.date||0).getTime()||0)));

    // 新闻池可达上千篇；为避免一次渲染过多卡片拖慢页面，
    // 按相关度取前 N 篇进入清单，并如实提示（不是静默丢弃）
    const MAX_ARTICLES = 300;
    if(hits.length > MAX_ARTICLES){
      const dropped = hits.length - MAX_ARTICLES;
      hits = hits.slice(0, MAX_ARTICLES);
      state.warnings.push(`本次命中 ${hits.length + dropped} 篇，清单按相关度展示前 ${MAX_ARTICLES} 篇；可缩小英文检索词或改用「全部关键词命中」获得更精确结果。`);
    }

    const seen = new Set(), articles = [];
    for(const {a, score} of hits){
      const key = a.link || a.title;
      if(seen.has(key)) continue;
      seen.add(key);
      a.score = score;
      articles.push(markAccess(a));
    }

    state.record = {
      id: Date.now().toString(36),
      request: { topic, en_keywords: enkw, auto_translated: autoTranslated,
                 timespan, sources, mode, created_at: new Date().toISOString() },
      stats: buildStats(articles),
      articles,
      warnings: state.warnings.slice()
    };
    render(state.record);
    saveHistory(state.record);
  }catch(err){
    showError('检索失败：' + err.message);
  }finally{
    setLoading(false);
    btn.disabled = false;
  }
}

/* ---------------- 渲染 ---------------- */

function render(rec){
  const s = rec.stats;
  const heatCls = s.heat_label === '高' ? 'hot' : s.heat_label === '中' ? 'warm' : 'cool';
  document.getElementById('stats').innerHTML = `
    <div class="stat"><div class="num">${s.total}</div><div class="lbl">相关报道</div></div>
    <div class="stat"><div class="num">${s.media_count}</div><div class="lbl">涉及媒体 / 机构</div></div>
    <div class="stat"><div class="num">${s.paywall_count}</div><div class="lbl">需订阅报道</div></div>
    <div class="stat"><div class="num">${s.summary_count}</div><div class="lbl">含公开摘要</div></div>
    <div class="stat"><div class="num ${heatCls}">${s.heat_label}</div><div class="lbl">热度评估</div></div>`;
  const notes = [];
  if(poolMeta.at){
    notes.push(`全球新闻池生成于 ${poolMeta.generated || new Date(poolMeta.at).toLocaleString('zh-CN')}` +
      `（${poolMeta.count} 篇 / ${poolMeta.sources} 家来源${poolMeta.stale ? '，暂用上一次数据' : ''}）`);
  }
  if(rssMeta.at){
    notes.push(`RSS 数据源：${rssMeta.source}` +
      `（${new Date(rssMeta.at).toLocaleString('zh-CN')}${rssMeta.stale ? '，离线缓存' : ''}）`);
  }
  const snapNote = notes.length ? ' · ' + notes.join(' · ') : '';
  document.getElementById('heatNote').textContent =
    (rec.request.auto_translated ? `中文话题已自动译为「${rec.request.en_keywords}」。` : '') +
    `检索范围：${TIMESPAN_LABEL[rec.request.timespan]} · 检索源：` +
    rec.request.sources.map(x => SRC_LABEL[x] || x).join(' + ') +
    ` · 全球新闻池 ${s.pool_count} 篇 / RSS 精选源 ${s.rss_count} 篇` +
    snapNote +
    (rec.warnings.length ? ' · ⚠ ' + rec.warnings.join('；') : '');
  const srcNote = document.getElementById('sourceNote');
  if(srcNote){
    const parts = [];
    if(s.pool_count) parts.push(`全球新闻池 ${s.pool_count} 篇（GitHub Actions 在境外服务器抓取，页面同域读取，独立于你的 RSS 站）`);
    if(s.rss_count) parts.push(`RSS 精选源 ${s.rss_count} 篇（你的订阅快照）`);
    srcNote.textContent = parts.length ? '来源构成：' + parts.join('　+　') : '来源构成：本次无命中报道。';
  }
  drawDayChart(s.by_day);
  renderSrcBars(s.top_sources);
  document.getElementById('result').classList.remove('hidden');
  renderArticles();
  loadHistory();
}
function renderArticles(){
  const rec = state.record;
  if(!rec) return;
  const openOnly = document.getElementById('openOnly').checked;
  const freshEl = document.getElementById('freshOnly');
  const freshOnly = freshEl ? freshEl.checked : false;
  const list = rec.articles.map((a,i) => ({a,i}))
    .filter(({a}) => (!openOnly || !a.paywall) && (!freshOnly || a.origin !== 'rss'));
  document.getElementById('artCount').textContent = list.length;
  document.getElementById('articles').innerHTML = list.length ? list.map(({a,i}) => `
    <div class="art" id="art-${i}">
      <div class="hd">
        <h3><a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.title)}</a></h3>
      </div>
      <div class="meta">
        <span class="tag ${a.origin}">${a.origin === 'rss' ? 'RSS 精选源' : '全球新闻池'}</span>
        <b>${esc(a.source)}</b> · ${fmtDate(a.date)}
        <span class="tag ${a.paywall ? 'pay':'open'}">${esc(a.access)}</span>
        ${a.country ? ' · ' + esc(a.country) : ''}
        ${a.author ? ' · 作者 ' + esc(a.author) : ''}
        ${a.topic ? ' · 主题 ' + esc(a.topic) : ''}
      </div>
      ${a.summary ? `<div class="summ">${esc(a.summary.slice(0,460))}${a.summary.length>460?'…':''}</div>` : ''}
      <div class="card-actions">
        <a href="${esc(a.link)}" target="_blank" rel="noopener">原文</a>
        ${a.textise ? `<a href="${esc(a.textise)}" target="_blank" rel="noopener">Textise 文本视图</a>` : ''}
      </div>
    </div>`).join('') : `<p style="color:var(--muted)">${freshOnly ? '本次没有来自「全球新闻池」的报道，可取消「仅看非 RSS 新报道」或换一个检索词。' : '当前筛选下没有报道，可取消「仅显示可公开访问」或扩大时间范围。'}</p>`;
}
function drawDayChart(data){
  const svg = document.getElementById('dayChart');
  if(!data || !data.length){ svg.innerHTML = '<text x="12" y="30" fill="#6b7280" font-size="12">暂无时间分布数据</text>'; return; }
  const W = 1000, H = 150, pad = 28, n = data.length;
  const max = Math.max(...data.map(d => d.count), 1);
  const bw = Math.max(6, (W - pad*2) / n - 4);
  let bars = '';
  data.forEach((d,i) => {
    const x = pad + i * ((W - pad*2) / n);
    const h = (d.count / max) * 100;
    bars += `<rect x="${x.toFixed(1)}" y="${(110-h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="#3b82f6" rx="2"><title>${esc(d.day)}: ${d.count} 篇</title></rect>`;
    if(n <= 16 || i % Math.ceil(n/16) === 0)
      bars += `<text x="${(x+bw/2).toFixed(1)}" y="132" fill="#6b7280" font-size="10" text-anchor="middle">${esc(d.day)}</text>`;
    if(d.count > 0)
      bars += `<text x="${(x+bw/2).toFixed(1)}" y="${(105-h).toFixed(1)}" fill="#1e40af" font-size="10" text-anchor="middle">${d.count}</text>`;
  });
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `<line x1="${pad}" y1="110" x2="${W-pad}" y2="110" stroke="#e5e7eb"/>${bars}`;
}
function renderSrcBars(sources){
  const el = document.getElementById('srcBars');
  if(!sources.length){ el.innerHTML = '<div class="hint">暂无来源数据</div>'; return; }
  const max = sources[0].count || 1;
  el.innerHTML = sources.map(x => `
    <div class="srcbar"><div class="nm" title="${esc(x.source)}">${esc(x.source)}</div>
      <div class="bar" style="width:${Math.max(2, x.count/max*62).toFixed(1)}%"></div>
      <div class="ct">${x.count} 篇</div></div>`).join('');
}

/* ---------------- 历史（本机 localStorage） ---------------- */

const HIST_KEY = 'mi_history_v1';
function loadHistory(){
  let items = [];
  try{ items = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); }catch(e){}
  document.getElementById('historyChips').innerHTML = items.length
    ? items.map(h => `<span class="history-chip" onclick="rerun('${esc(h.topic).replace(/'/g,"\\'")}','${h.timespan}')" title="一键重跑"><b>${esc(h.topic)}</b> · ${h.total} 篇 · ${TIMESPAN_LABEL[h.timespan]||h.timespan}</span>`).join('')
    : '<span class="hint">暂无检索记录，完成一次检索后会自动出现在这里。</span>';
}
function saveHistory(rec){
  let items = [];
  try{ items = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); }catch(e){}
  items = items.filter(h => h.topic !== rec.request.topic);
  items.unshift({topic: rec.request.topic, enkw: rec.request.en_keywords,
                 timespan: rec.request.timespan, total: rec.stats.total, ts: Date.now()});
  try{ localStorage.setItem(HIST_KEY, JSON.stringify(items.slice(0,12))); }catch(e){}
}
function rerun(topic, timespan){
  document.getElementById('topic').value = topic;
  document.getElementById('timespan').value = timespan || '30d';
  document.getElementById('enkw').value = '';
  doSearch({topic, timespan});
}

/* v2.4：总结提炼相关逻辑（LLM 设置 / 自动提炼 / 内置机翻算法 / 报告渲染 / AI 指令）已按需求整体移除 */

/* ---------------- 初始化 ---------------- */

document.getElementById('topic').addEventListener('keydown', ev => { if(ev.key === 'Enter') doSearch(); });
loadHistory();
