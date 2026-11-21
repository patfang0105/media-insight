'use strict';

/* ============================================================
 * Media Insight · 纯静态版核心逻辑
 * 数据源：全球新闻池（同域 news-data.json，GitHub Actions 境外抓取）
 *         / 用户自建 RSS 聚合站 / GDELT DOC API / Google gtx 翻译
 * 全部在浏览器内运行，无服务端
 * ============================================================ */

const POOL_URL = 'news-data.json';   // 与页面同域，国内浏览器可直接读取
const RSS_URL = 'https://patfang0105.github.io/my-rss-blog/rss-data.json';
const GDELT_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
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

const TIMESPAN_GDELT = { '24h':'24h', '7d':'1w', '30d':'1m', '180d':'3m' };
const TIMESPAN_DAYS  = { '24h':1, '7d':7, '30d':30, '180d':180 };
const TIMESPAN_LABEL = { '24h':'最近24小时','7d':'最近7天','30d':'最近30天','180d':'最近180天' };
const SRC_LABEL = { pool:'全球新闻池', rss:'RSS 精选源', gdelt:'实时检索 GDELT' };

const STOPWORDS = new Set(('the a an and or but if of to in on at by for from with as is are was were be been being '
  + 'it its this that these those there here their they them he she his her we our you your i me my '
  + 'not no nor so than then too very can will would could should may might must have has had do does did '
  + 'about into over under after before between during through above below up down out off again further '
  + 'once more most other some such only own same s t just don now said says say new one two also which who '
  + 'what when where why how all any both each few more other some such').split(/\s+/));

const ATTITUDE_WORDS = {
  '警示/担忧': ['warn','warning','warned','risk','risks','threat','concern','concerns','fear','pressure','vulnerab','fragil'],
  '呼吁/建议': ['urge','urged','call for','calls for','called for','should','must','need to','recommend','push for'],
  '批评/质疑': ['critic','criticise','criticize','question','doubt','challenge','accuse','blame','flaw','failure'],
  '肯定/看好': ['welcome','praise','boost','strong','resilien','opportunity','optimis','growth','gain','benefit'],
  '分歧/博弈': ['dispute','tension','clash','divide','split','rival','compete','bargain','leverage','standoff']
};

const state = {
  record: null,
  digest: null,
  warnings: [],
  digesting: false,     // 提炼任务进行中，防止并发
  digestSeq: 0,         // 任务序号，新检索会让旧任务的结果作废
  pendingAuto: false    // 有新检索在等待自动提炼
};

/* ---------------- 全球新闻池：页面同域只读 ----------------
 * 抓取由 GitHub Actions 在境外服务器每 3 小时完成，结果写入仓库的
 * news-data.json。浏览器只读本站点自己的文件，因此不跨境、无 CORS、
 * 不受 GDELT 5 秒限流影响，也完全不触碰 my-rss-blog。
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
  if(/^\d{8}T\d{6}Z$/.test(s)){          // GDELT seendate: 20261119T120000Z
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

/* ---------------- 翻译（Google gtx 优先 / MyMemory 兜底，双方向） ----------------
 * 全量提炼需要翻译几十到几百篇，gtx 支持较长文本且可并发，
 * 单条失败时自动降级到 MyMemory，两者都失败才保留英文原文。
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
  const timer = setTimeout(() => ctl.abort(), 15000);
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
  const r = await fetchWithTimeout(url, {}, 9000);
  if(!r.ok) throw new Error('翻译接口 HTTP ' + r.status);
  const d = await r.json();
  let out = (d.responseData && d.responseData.translatedText) || '';
  out = out.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&').trim();
  if(!out || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(out)) throw new Error('翻译接口未返回有效结果');
  return out;
}
async function translateText(text, from, to){
  const key = from + '|' + to + '|' + text;
  if(transCache.has(key)) return transCache.get(key);
  let out = null, lastErr = null;
  for(let attempt = 0; attempt < 2; attempt++){
    try{ out = await gtx(text, from, to); break; }
    catch(e){ lastErr = e; if(attempt === 0) await new Promise(r => setTimeout(r, 800)); }
  }
  if(out === null){
    try{ out = await mymemory(text, from, to); }
    catch(e){ throw lastErr || e; }
  }
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
let lastGdeltAt = 0;
async function gdeltThrottle(){
  // GDELT 官方要求两次请求间隔 ≥5 秒；页面内做节流，避免连续检索被限流
  const wait = 6500 - (Date.now() - lastGdeltAt);
  if(wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGdeltAt = Date.now();
}
async function fetchGdelt(q, timespan){
  // 旧版把整个检索词加引号做精确短语匹配，召回极低；改为多词 OR 召回，再由本地相关度打分过滤
  const words = (q || '').replace(/["'()]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w.toLowerCase())).slice(0, 5);
  const core = words.length > 1 ? '(' + words.join(' OR ') + ')' : (words[0] || q);
  const query = core + ' sourcelang:english';
  const params = new URLSearchParams({
    query, mode:'artlist', maxrecords:'250', format:'json',
    sort:'datedesc', timespan: TIMESPAN_GDELT[timespan] || '1m'
  });
  const url = GDELT_API + '?' + params;
  let lastErr;
  for(let attempt = 0; attempt < 2; attempt++){
    await gdeltThrottle();
    try{
      const r = await fetchWithTimeout(url, {}, 12000);
      if(r.status === 429) throw new Error('GDELT 接口限流（429）');
      if(!r.ok) throw new Error('GDELT HTTP ' + r.status);
      const txt = await r.text();
      if(txt.trim().startsWith('Please limit')) throw new Error('GDELT 接口限流');
      const d = JSON.parse(txt);
      return (d.articles || []).map(it => ({
        origin: 'gdelt',
        title: stripHtml(it.title),
        link: it.url || '',
        source: it.domain || '未知来源',
        author: '',
        date: parseDate(it.seendate),
        summary: '',
        country: it.sourcecountry || ''
      }));
    }catch(e){
      // 429 响应不带 CORS 头，浏览器会报成 "Failed to fetch"，这里翻译成可理解的提示
      const raw = (e && e.message) || String(e);
      const msg = /Failed to fetch|NetworkError|Load failed|TypeError/i.test(raw)
        ? '网络不可达或 GDELT 限流（浏览器端限流常表现为网络错误）'
        : raw;
      lastErr = new Error(msg);
      if(attempt === 0) await new Promise(r => setTimeout(r, 5500));  // 限流后等待再试一次
    }
  }
  throw lastErr || new Error('GDELT 未返回数据');
}

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
  let paywall = 0, withSummary = 0, poolCount = 0, realtime = 0, fromRss = 0;
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
    else if(a.origin === 'gdelt') realtime++;
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
    realtime_count: realtime, rss_count: fromRss, heat_label: heat,
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
  if(document.getElementById('srcGdelt').checked) sources.push('gdelt');
  if(!sources.length){ showError('请至少选择一个检索源；推荐勾选「全球新闻池」'); return; }

  const timespan = (preset && preset.timespan) || document.getElementById('timespan').value;
  const mode = document.getElementById('mode').value;
  let enkw = document.getElementById('enkw').value.trim();

  const btn = document.getElementById('goBtn');
  btn.disabled = true;
  state.digestSeq++;                 // 让上一次检索的后台提炼结果作废
  setLoading(true, '正在翻译话题并检索境外媒体数据库…');
  document.getElementById('result').classList.add('hidden');
  state.warnings = [];
  state.digest = null;

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
    if(sources.includes('gdelt')){
      tasks.push(fetchGdelt(enkw || topic, timespan).catch(e => {
        srcErrors.push('实时检索 GDELT：' + e.message);
        state.warnings.push('实时检索（GDELT）未返回数据：' + e.message +
          '（已自动重试一次）；可稍后点「开始检索」重试');
        return [];
      }));
    }
    const pool = (await Promise.all(tasks)).flat();

    // 不再自动回退 RSS：用户明确要求「不依赖 RSS 也能检索」，
    // 拉取订阅快照会掩盖真实失败。改为如实报错并给出可操作的建议。
    if(!pool.length){
      throw new Error('本次未取到任何报道' +
        (srcErrors.length ? '（' + srcErrors.join('；') + '）' : '') +
        '。建议：勾选「全球新闻池」（境外服务器每 3 小时更新、页面同域读取，国内网络可用），或稍后重试实时检索。');
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
      state.warnings.push('检索词「' + (enkw || topic) + '」未在本次数据中命中；已放宽为按时间范围列出最多 60 篇。全球新闻池按预设的长期话题定期抓取，冷门或突发话题可能尚未入池，可换个检索词、缩短英文检索词，或加勾「实时检索 GDELT」。');
      hits = pool.filter(a => !a.date || isNaN(new Date(a.date).getTime()) ||
                              new Date(a.date).getTime() >= cutoff)
                 .slice(0, 60).map(a => ({ a, score: 1 }));
    }
    hits.sort((x,y) => (y.score - x.score) ||
      ((new Date(y.a.date||0).getTime()||0) - (new Date(x.a.date||0).getTime()||0)));

    // 新闻池可达上千篇；为避免免费机翻接口被瞬间打满、页面长时间卡住，
    // 按相关度取前 N 篇进入清单与提炼，并如实提示（不是静默丢弃）
    const MAX_ARTICLES = 300;
    if(hits.length > MAX_ARTICLES){
      const dropped = hits.length - MAX_ARTICLES;
      hits = hits.slice(0, MAX_ARTICLES);
      state.warnings.push(`本次命中 ${hits.length + dropped} 篇，为控制免费翻译接口负载，清单与提炼按相关度取前 ${MAX_ARTICLES} 篇；可缩小英文检索词或改用「全部关键词命中」获得更精确结果。`);
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
    // 自动提炼：检索完成即后台生成，覆盖全部命中报道，无需任何选择
    if(loadAutoCfg().enabled && articles.length){
      autoDigest().catch(e => console.warn('自动提炼失败：', e));
    }
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
    ` · 全球新闻池 ${s.pool_count} 篇 / 实时检索 ${s.realtime_count} 篇 / RSS 精选源 ${s.rss_count} 篇` +
    snapNote +
    (rec.warnings.length ? ' · ⚠ ' + rec.warnings.join('；') : '');
  const srcNote = document.getElementById('sourceNote');
  if(srcNote){
    const parts = [];
    if(s.pool_count) parts.push(`全球新闻池 ${s.pool_count} 篇（GitHub Actions 在境外服务器抓取，页面同域读取，独立于你的 RSS 站）`);
    if(s.realtime_count) parts.push(`实时检索 ${s.realtime_count} 篇（本次浏览器直连 GDELT）`);
    if(s.rss_count) parts.push(`RSS 精选源 ${s.rss_count} 篇（你的订阅快照）`);
    srcNote.textContent = parts.length ? '来源构成：' + parts.join('　+　') : '来源构成：本次无命中报道。';
  }
  drawDayChart(s.by_day);
  renderSrcBars(s.top_sources);
  document.getElementById('result').classList.remove('hidden');
  document.getElementById('digestResult').classList.add('hidden');
  document.getElementById('digestHint').textContent = loadAutoCfg().enabled
    ? `正在为全部 ${rec.articles.length} 篇命中报道生成中文摘译与要点…（结果直接在本区查看）`
    : '自动提炼已关闭；可在上方开启，或点「↻ 重新生成全部」手动生成。';
  document.getElementById('aiPrompt').value = buildAIPrompt(rec);
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
        <span class="tag ${a.origin}">${a.origin === 'rss' ? 'RSS 精选源' : a.origin === 'pool' ? '全球新闻池' : '实时检索 GDELT'}</span>
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
    </div>`).join('') : `<p style="color:var(--muted)">${freshOnly ? '本次没有来自「全球新闻池 / 实时检索」的报道，可取消「仅看非 RSS 新报道」或换一个检索词。' : '当前筛选下没有报道，可取消「仅显示可公开访问」或扩大时间范围。'}</p>`;
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

/* ---------------- LLM 设置（可选） ---------------- */

const LLM_KEY = 'mi_llm_v1';
function loadLLM(){
  try{ return JSON.parse(localStorage.getItem(LLM_KEY) || '{}'); }catch(e){ return {}; }
}
function fillLLM(){
  const c = loadLLM();
  document.getElementById('llmBase').value  = c.base || '';
  document.getElementById('llmKey').value   = c.key || '';
  document.getElementById('llmModel').value = c.model || '';
  document.getElementById('llmState').textContent = c.key ? '已在本机保存配置，提炼时将自动调用 LLM' : '未配置，使用内置免配置提炼';
}
function saveLLM(){
  const c = {
    base: document.getElementById('llmBase').value.trim(),
    key: document.getElementById('llmKey').value.trim(),
    model: document.getElementById('llmModel').value.trim() || 'gpt-4o-mini'
  };
  try{ localStorage.setItem(LLM_KEY, JSON.stringify(c)); }catch(e){}
  fillLLM();
  showError(''); hideError();
}
function clearLLM(){
  try{ localStorage.removeItem(LLM_KEY); }catch(e){}
  document.getElementById('llmBase').value = '';
  document.getElementById('llmKey').value = '';
  document.getElementById('llmModel').value = '';
  fillLLM();
}
function toggleLLM(){
  document.getElementById('llmBox').classList.toggle('hidden');
  fillLLM();
}

/* ---------------- 自动提炼设置（保存在本机浏览器） ---------------- */

const AUTO_KEY = 'mi_auto_digest_v1';
function loadAutoCfg(){
  try{
    const c = JSON.parse(localStorage.getItem(AUTO_KEY) || 'null');
    if(c && typeof c === 'object') return { enabled: c.enabled !== false };
  }catch(e){}
  return { enabled: true };
}
function saveAutoCfg(c){
  try{ localStorage.setItem(AUTO_KEY, JSON.stringify(c)); }catch(e){}
}
function onAutoCfgChange(){
  const enabled = document.getElementById('autoDigest').checked;
  saveAutoCfg({ enabled });
  const note = document.getElementById('autoCfgNote');
  if(note) note.textContent = enabled
    ? '已开启：每次检索完成后，自动为全部命中报道生成中文摘译与要点，无需任何选择操作。'
    : '已关闭：本次检索不会自动生成，可点「↻ 重新生成全部」手动生成。';
}
function fillAutoCfg(){
  document.getElementById('autoDigest').checked = loadAutoCfg().enabled;
  onAutoCfgChange();
}

/* ---------------- 总结提炼：入口（全量自动，无需选择） ---------------- */

/* 检索完成后由系统调用：覆盖全部命中报道 */
async function autoDigest(force){
  const rec = state.record;
  if(!rec || !rec.articles.length) return;
  if(!force && !loadAutoCfg().enabled) return;
  if(state.digesting){ state.pendingAuto = true; return; }
  await runDigest(rec.articles.slice(), '自动');
}

/* 兼容入口：重新生成全部 */
async function doDigest(){ await autoDigest(true); }

async function runDigest(chosen, mode){
  if(state.digesting) return;
  state.digesting = true;
  const seq = ++state.digestSeq;
  hideError();
  const regen = document.getElementById('regenBtn');
  if(regen) regen.disabled = true;
  const hint = document.getElementById('digestHint');
  hint.textContent = `正在为全部 ${chosen.length} 篇命中报道生成中文摘译与要点…（篇数较多时约需 1 分钟）`;

  // 内置提炼逐条机翻时回报进度
  const onProgress = (done, total, phase, retryCount) => {
    hint.textContent = phase === 'retry'
      ? `正在补译 ${retryCount} 条被限流的译文…（共 ${chosen.length} 篇）`
      : `正在生成中文摘译与要点… 机翻进度 ${done}/${total}（共 ${chosen.length} 篇）`;
  };

  let md = '', engine = '', degraded = '';
  try{
    const cfg = loadLLM();
    if(cfg.key){
      try{
        md = await llmDigest(chosen, cfg);
        engine = 'LLM 智能摘译（' + (cfg.model || 'gpt-4o-mini') + '）';
      }catch(e){
        degraded = 'LLM 调用失败，已自动降级为内置提炼：' + e.message;
        md = await extractiveDigest(chosen, onProgress);
        engine = '内置提炼（免配置）';
      }
    }else{
      md = await extractiveDigest(chosen, onProgress);
      engine = '内置提炼（免配置）';
    }
  }catch(e){
    state.digesting = false;
    if(regen) regen.disabled = false;
    hint.textContent = '提炼失败：' + e.message;
    showError('总结提炼失败：' + e.message);
    return;
  }

  const rec = state.record;
  const head = `# 「${rec.request.topic}」境外媒体总结提炼报告\n\n`
    + `> **生成时间**：${new Date().toLocaleString('zh-CN')}　|　**提炼引擎**：${engine}\n`
    + `> **生成方式**：检索后自动生成，覆盖全部命中报道（无需选择）　|　`
    + `**提炼报道**：${chosen.length} 篇 / ${new Set(chosen.map(a => a.source)).size} 家来源\n`
    + `> **检索词**：${rec.request.en_keywords}　|　**时间范围**：${TIMESPAN_LABEL[rec.request.timespan]}　|　`
    + `**命中总量**：${rec.stats.total} 篇\n`
    + (degraded ? `> ⚠ ${degraded}\n` : '')
    + `> 本报告仅基于各媒体**公开提供的标题与摘要**生成，不含付费墙全文；请遵守原文版权。\n\n---\n\n`;
  md = head + md;

  const foot = `\n\n---\n\n## 信息局限与合规说明\n\n`
    + `- 本报告覆盖本次检索命中的**全部 ${chosen.length} 篇报道**，逐篇给出中文摘译与要点；但基于公开摘要，不是全文翻译。\n`
    + `- 全部报道中，**${chosen.filter(a=>a.paywall).length} 篇需订阅**、**${chosen.filter(a=>!a.summary).length} 篇无公开摘要**，相关条目不得据此推断全文细节。\n`
    + `- 内置提炼采用规则式关键句抽取与免费机翻，措辞可能与原文存在偏差；每篇均保留英文原文关键句以便核对。\n`
    + `- 材料仅供内部研判使用，转载与引用请遵循原文版权与订阅条款。\n`;
  md += foot;

  state.digesting = false;
  if(regen) regen.disabled = false;
  if(seq !== state.digestSeq){
    // 已有更新的检索：丢弃过期结果，并为新结果补跑一次自动提炼
    if(state.pendingAuto){ state.pendingAuto = false; setTimeout(() => autoDigest().catch(()=>{}), 30); }
    return;
  }

  state.digest = { md, engine, chosen, degraded, mode };
  document.getElementById('digestResult').innerHTML = mdToHtml(md);
  document.getElementById('digestResult').classList.remove('hidden');
  hint.textContent =
    `已自动生成（${engine}，覆盖全部 ${chosen.length} 篇）${degraded ? ' · ' + degraded : ''}。报告已在本区完整呈现，可直接在页面查看。`;
  if(state.pendingAuto){ state.pendingAuto = false; setTimeout(() => autoDigest().catch(()=>{}), 30); }
}

/* ---------------- 总结提炼：内置免配置算法 ---------------- */

function splitSentences(text){
  return (text || '').replace(/\s+/g,' ')
    .split(/(?<=[.!?])\s+(?=[A-Z"“])/)
    .map(s => s.trim())
    .filter(s => s.length > 25 && s.length < 500);
}
function scoreSentence(s, terms){
  let sc = 0;
  const low = s.toLowerCase();
  if(/\d/.test(s)) sc += 2;
  if(/["“”']/.test(s)) sc += 1;
  if(/\b(percent|%|billion|million|trillion|yuan|dollar|yuan|tonne|gw|tariff|rate)\b/i.test(s)) sc += 2;
  terms.forEach(t => { if(low.includes(t)) sc += 2; });
  if(s.length >= 60 && s.length <= 240) sc += 1;
  if(/\b(said|says|warned|urged|argued|according to|told)\b/i.test(s)) sc += 1;
  return sc;
}
function topKeywords(texts, terms){
  const freq = {};
  texts.forEach(t => (t || '').toLowerCase().replace(/[^a-z0-9\s-]/g,' ').split(/\s+/).forEach(w => {
    if(w.length > 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w) && !terms.includes(w))
      freq[w] = (freq[w] || 0) + 1;
  }));
  return Object.entries(freq).sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,14);
}
async function translateBatch(texts, onProgress){
  // 并发池：覆盖全部文章；单条失败自动降级为英文，不阻断其余条目
  const out = new Array(texts.length);
  let cursor = 0, done = 0;
  const CONCURRENCY = 5;
  async function worker(){
    for(;;){
      const i = cursor++;
      if(i >= texts.length) return;
      const t = texts[i];
      if(!t || !t.trim()){ out[i] = {zh:'', ok:false}; }
      else{
        try{ out[i] = {zh: await translateText(t, 'en', 'zh-CN'), ok:true}; }
        catch(e){ out[i] = {zh:'', ok:false}; }
      }
      done++;
      if(onProgress) onProgress(done, texts.length);
    }
  }
  const n = Math.min(CONCURRENCY, texts.length);
  await Promise.all(Array.from({length: n}, worker));

  // 并发阶段被限流的条目：低并发错峰补译一次；设条数上限与总时限，避免接口整体限流时页面久等
  const failed = [];
  for(let i = 0; i < texts.length; i++){
    if(!(out[i] && out[i].ok) && texts[i] && texts[i].trim()) failed.push(i);
  }
  const retryList = failed.slice(0, 24);
  if(retryList.length && onProgress) onProgress(texts.length, texts.length, 'retry', retryList.length);
  const deadline = Date.now() + 30000;
  let rc = 0;
  async function retryWorker(){
    for(;;){
      if(Date.now() > deadline) return;
      const k = rc++;
      if(k >= retryList.length) return;
      const i = retryList[k];
      transCache.delete('en|zh-CN|' + texts[i]);
      try{ out[i] = {zh: await translateText(texts[i], 'en', 'zh-CN'), ok:true}; }
      catch(e){ /* 保持降级，保留英文原文 */ }
      await new Promise(r => setTimeout(r, 200));
    }
  }
  await Promise.all(Array.from({length: Math.min(3, retryList.length)}, retryWorker));
  return out;
}
function firstSentence(s){
  if(!s) return '';
  const m = s.match(/^[^。！？!?；;]+[。！？!?；;]?/);
  let t = (m ? m[0] : s).trim();
  if(t.length > 150) t = t.slice(0,150) + '…';
  return t;
}
async function extractiveDigest(chosen, onProgress){
  const rec = state.record;
  const terms = tokenize(rec.request.en_keywords || rec.request.topic);

  // 1) 逐篇抽取关键句：覆盖全部命中报道，不设上限
  const items = chosen.map((a, idx) => {
    const sents = splitSentences(a.summary);
    const ranked = sents.map((s,j) => ({s, sc: scoreSentence(s, terms), j}))
      .sort((x,y) => y.sc - x.sc || x.j - y.j);
    const keySents = ranked.slice(0,2).map(x => x.s);
    const tags = [];
    if(/\d/.test(a.summary || '')) tags.push('含关键数据');
    if(/["“”]/.test(a.summary || '')) tags.push('含直接引语');
    if(a.paywall) tags.push('基于公开摘要');
    if(!a.summary) tags.push('仅标题可用');
    return { a, idx, keySents, tags };
  });

  // 2) 机翻：每篇「标题 + 关键句段落」两条，覆盖全部文章
  const toTrans = [];
  items.forEach(it => {
    toTrans.push((it.a.title || '').slice(0,200));
    toTrans.push(it.keySents.join(' ').slice(0,900));
  });
  let zh = [];
  try{ zh = await translateBatch(toTrans, onProgress); }
  catch(e){ zh = toTrans.map(() => ({zh:'', ok:false})); }
  let transFail = 0;
  items.forEach((it, k) => {
    it.zhTitle   = (zh[k*2] && zh[k*2].ok) ? zh[k*2].zh : '';
    it.zhExcerpt = (zh[k*2+1] && zh[k*2+1].ok) ? zh[k*2+1].zh : '';
    if(it.keySents.length && !it.zhExcerpt) transFail++;   // 无摘要条目不计失败
  });

  // 3) 汇总分析
  const srcCount = {};
  chosen.forEach(a => { srcCount[a.source] = (srcCount[a.source]||0) + 1; });
  const dates = chosen.map(a => a.date).filter(Boolean).sort();
  const span = dates.length ? `${isoDay(dates[0])} ~ ${isoDay(dates[dates.length-1])}` : '日期信息不足';
  const kws = topKeywords(chosen.map(a => (a.title||'') + ' ' + (a.summary||'')), terms);
  const shared = kws.filter(([w,c]) => c >= Math.max(3, Math.ceil(chosen.length/3))).slice(0,8);

  const attitude = {};
  chosen.forEach(a => {
    const text = ((a.title||'') + ' ' + (a.summary||'')).toLowerCase();
    Object.entries(ATTITUDE_WORDS).forEach(([label, words]) => {
      if(words.some(w => text.includes(w))){
        if(!attitude[label]) attitude[label] = new Set();
        attitude[label].add(a.source);
      }
    });
  });

  const numbers = [];
  chosen.forEach(a => {
    const m = (a.summary || '').match(/[^.!?]*\b\d[\d,.]*\s*(%|percent|billion|million|trillion|yuan|dollars?|tonnes?|gw|basis points)\b[^.!?]*/gi);
    if(m) m.slice(0,1).forEach(x => numbers.push({src:a.source, text:x.trim().slice(0,220)}));
  });

  // 4) 输出 Markdown
  let md = `## 一、提炼概览\n\n`;
  md += `| 项目 | 数值 |\n|---|---|\n`;
  md += `| 提炼报道 | ${chosen.length} 篇（全部命中） |\n| 涉及来源 | ${Object.keys(srcCount).length} 家 |\n`;
  md += `| 来源构成 | 全球新闻池 ${chosen.filter(a=>a.origin==='pool').length} 篇 / 实时检索 ${chosen.filter(a=>a.origin==='gdelt').length} 篇 / RSS 精选源 ${chosen.filter(a=>a.origin==='rss').length} 篇 |\n`;
  md += `| 需订阅 / 仅标题 | ${chosen.filter(a=>a.paywall).length} / ${chosen.filter(a=>!a.summary).length} 篇 |\n`;
  md += `| 时间跨度 | ${span} |\n| 提炼引擎 | 内置规则式提炼（免配置） |\n\n`;
  md += `**主要来源**：` + Object.entries(srcCount).sort((a,b)=>b[1]-a[1]).slice(0,8)
          .map(([s,c]) => `${s}（${c}）`).join('、') + `\n\n`;
  if(kws.length) md += `**高频主题词**：` + kws.slice(0,10).map(([w,c]) => `\`${w}\`(${c})`).join('、') + `\n\n`;

  md += `## 二、逐篇中文摘译与要点（全部 ${chosen.length} 篇）\n\n`;
  md += `> 说明：「中文要点 / 中文摘译」由免费机翻生成，措辞可能与原文有偏差；每篇均保留英文原文关键句以便核对。全球新闻池与实时检索（GDELT）条目仅提供标题与链接、无公开摘要，故只给出中文标题译名，不得据此推断正文内容。\n\n`;
  items.forEach((it, k) => {
    const a = it.a;
    md += `### ${k+1}. ${it.zhTitle || a.title}\n\n`;
    md += `- **来源**：${a.source}　|　**日期**：${fmtDate(a.date)}　|　**访问级别**：${a.access}\n`;
    md += `- **原文标题**：${a.title}\n`;
    md += `- **原文链接**：${a.link}\n`;
    if(it.tags.length) md += `- **提炼标签**：${it.tags.join('、')}\n`;
    if(it.keySents.length && it.zhExcerpt){
      const ex = it.zhExcerpt.length > 420 ? it.zhExcerpt.slice(0,420) + '…' : it.zhExcerpt;
      md += `- **中文要点**：${firstSentence(it.zhExcerpt)}\n`;
      md += `- **中文摘译**：${ex}\n`;
    }else if(!it.keySents.length){
      const srcNote = a.origin === 'pool' ? '，来自全球新闻池'
                    : a.origin === 'gdelt' ? '，来自实时检索' : '';
      md += `- **中文要点**：${it.zhTitle || a.title}（该条目无公开摘要，仅提供标题与链接${srcNote}，不得据此推断正文内容）\n`;
    }else{
      md += `- **中文要点**：（机翻未成功，请见下方英文原文关键句）\n`;
    }
    it.keySents.forEach(s => { md += `  > 原文关键句：${s}\n`; });
    md += `\n`;
  });

  md += `## 三、观点提炼与信号\n\n`;
  md += `### 共识线索\n\n`;
  if(shared.length){
    md += `多篇报道共同聚焦：${shared.map(([w,c]) => `\`${w}\`（${c} 篇提及）`).join('、')}。` +
          `这表明境外媒体对该话题的关注集中在上述维度，可作为研判主线。\n\n`;
  }else{
    md += `全部报道的高频词重叠度较低，议题分布较分散，尚不足以归纳出明确共识。建议聚焦单一子话题后再提炼。\n\n`;
  }
  md += `### 立场与侧重差异\n\n`;
  const attEntries = Object.entries(attitude).sort((a,b) => b[1].size - a[1].size);
  if(attEntries.length){
    attEntries.forEach(([label, srcs]) => {
      md += `- **${label}**：见于 ${[...srcs].slice(0,6).join('、')}${srcs.size>6?' 等':''} 的报道。\n`;
    });
  }else{
    md += `- 未从公开摘要中识别出明显的态度词，立场差异需阅读全文后判断。\n`;
  }
  md += `\n`;
  md += `### 值得关注的信号（数据 / 引语）\n\n`;
  if(numbers.length){
    numbers.slice(0,6).forEach(n => { md += `- ${n.src}：${n.text}\n`; });
  }else{
    md += `- 公开摘要中未提取到显著数字型信号。\n`;
  }
  md += `\n`;

  if(transFail > 0){
    md += `> ⚠ 本次有 ${transFail} 篇的摘译机翻未成功（网络波动或免费接口限额），已保留英文原文关键句。\n\n`;
  }
  return md;
}

/* ---------------- 总结提炼：LLM 增强 ---------------- */

async function llmDigest(chosen, cfg){
  const rec = state.record;
  const base = (cfg.base || 'https://api.openai.com/v1').replace(/\/+$/,'');
  const model = cfg.model || 'gpt-4o-mini';
  const material = chosen.map((a,i) =>
    `[${i+1}] 标题: ${a.title}\n来源: ${a.source} | 日期: ${fmtDate(a.date)} | 访问级别: ${a.access}\n` +
    `公开摘要: ${(a.summary || '（无公开摘要，仅标题）').slice(0,320)}\n链接: ${a.link}`).join('\n\n');

  const system = '你是一名专业的境外媒体舆情分析员，面向中文读者做摘译与提炼。'
    + '严格依据给定材料，不得编造、补全或推测付费墙全文内容；对「仅标题/仅导语」的条目必须明确说明信息受限。'
    + '输出为结构化中文 Markdown。';
  const user = `话题：${rec.request.topic}（英文检索词：${rec.request.en_keywords}）\n`
    + `共 ${chosen.length} 篇境外媒体报道（全部命中），材料如下（均为公开标题与公开摘要，非全文）：\n\n`
    + material + `\n\n请完成：\n`
    + `1. **提炼概览**：选样构成、来源分布、时间跨度、信息完整度；\n`
    + `2. **逐篇中文摘译**：每条给出「中文标题 + 2-3 句核心观点摘译」，注明来源与日期；付费墙条目须标注「基于公开摘要」；\n`
    + `3. **观点提炼**：归纳主流判断、立场分歧与共识，区分「有材料支撑」与「尚无法判断」；\n`
    + `4. **值得关注的信号**：数字、直接引语、政策动向，逐条注明出处；\n`
    + `5. **信息局限**：列出仅标题/仅导语的条目，说明哪些结论不能据此得出。\n`
    + `不要输出材料之外的任何事实、数据或引语。`;

  const r = await fetchWithTimeout(base + '/chat/completions', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + cfg.key },
    body: JSON.stringify({ model, messages:[{role:'system',content:system},{role:'user',content:user}], temperature:0.3 })
  }, 60000);
  if(!r.ok){
    let detail = '';
    try{ const d = await r.json(); detail = (d.error && d.error.message) || ''; }catch(e){}
    throw new Error('HTTP ' + r.status + (detail ? '：' + detail.slice(0,120) : '') +
      '（若为 CORS 报错，请改用支持跨域的兼容接口）');
  }
  const d = await r.json();
  const content = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  if(!content) throw new Error('模型未返回内容');
  return content.trim() + '\n';
}

/* ---------------- Markdown → HTML ---------------- */

function inlineMd(s){
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function mdToHtml(md){
  const lines = md.split('\n');
  let out = '', i = 0;
  while(i < lines.length){
    const ln = lines[i];
    if(/^```/.test(ln)){
      let buf = []; i++;
      while(i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out += '<pre><code>' + esc(buf.join('\n')) + '</code></pre>'; continue;
    }
    if(/^\s*\|/.test(ln) && i+1 < lines.length && /^\s*\|[\s:|-]+\|/.test(lines[i+1])){
      const rows = [];
      while(i < lines.length && /^\s*\|/.test(lines[i])){ rows.push(lines[i]); i++; }
      const cells = r => r.trim().replace(/^\||\|$/g,'').split('|').map(c => c.trim());
      let t = '<table><thead><tr>' + cells(rows[0]).map(c => '<th>'+inlineMd(c)+'</th>').join('') + '</tr></thead><tbody>';
      rows.slice(2).forEach(r => { t += '<tr>' + cells(r).map(c => '<td>'+inlineMd(c)+'</td>').join('') + '</tr>'; });
      out += t + '</tbody></table>'; continue;
    }
    if(/^###\s+/.test(ln)){ out += '<h3>' + inlineMd(ln.replace(/^###\s+/,'')) + '</h3>'; i++; continue; }
    if(/^##\s+/.test(ln)){  out += '<h2>' + inlineMd(ln.replace(/^##\s+/,''))  + '</h2>'; i++; continue; }
    if(/^#\s+/.test(ln)){   out += '<h1>' + inlineMd(ln.replace(/^#\s+/,''))  + '</h1>'; i++; continue; }
    if(/^>\s?/.test(ln)){
      let buf = [];
      while(i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/,''));
      out += '<blockquote>' + inlineMd(buf.join(' ')) + '</blockquote>'; continue;
    }
    if(/^\s*[-*]\s+/.test(ln)){
      let buf = [];
      while(i < lines.length && /^\s*[-*]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*[-*]\s+/,''));
      out += '<ul>' + buf.map(x => '<li>'+inlineMd(x)+'</li>').join('') + '</ul>'; continue;
    }
    if(/^---+\s*$/.test(ln)){ out += '<hr>'; i++; continue; }
    if(!ln.trim()){ i++; continue; }
    let para = [ln]; i++;
    while(i < lines.length && lines[i].trim() && !/^(#|>|```|\||\s*[-*]\s|---)/.test(lines[i])) para.push(lines[i++]);
    out += '<p>' + inlineMd(para.join(' ')) + '</p>';
  }
  return out;
}

/* 下载功能已按需求移除：总结提炼报告直接在页面「4 · 总结提炼结果」区完整呈现 */

/* ---------------- AI 分析指令 ---------------- */

function buildAIPrompt(rec){
  return `请围绕话题「${rec.request.topic}」（英文检索词：${rec.request.en_keywords}）完成境外媒体舆情分析。\n`
    + `素材：共 ${rec.stats.total} 篇报道 / ${rec.stats.media_count} 家来源，时间范围 ${TIMESPAN_LABEL[rec.request.timespan]}，`
    + `其中 ${rec.stats.paywall_count} 篇需订阅（仅公开摘要可用）。\n\n`
    + `请完成：\n1. 报道概览与热度：总量、来源构成、时间分布与走势；\n`
    + `2. 关键报道摘译：挑选 8-12 篇给出中文摘译（标题译名 + 核心观点，注明来源与日期）；\n`
    + `3. 观点提炼：主流判断、立场分歧、值得关注的信号。\n\n`
    + `严格约束：仅依据公开标题与摘要，不得编造或补全付费墙全文内容；对「仅标题/仅导语」条目须明确标注信息受限。\n`
    + `输出为结构化中文分析报告（Markdown）。`;
}
function togglePrompt(){ document.getElementById('promptBox').classList.toggle('hidden'); }
function copyPrompt(){
  const t = document.getElementById('aiPrompt');
  t.select();
  try{ document.execCommand('copy'); }catch(e){ navigator.clipboard && navigator.clipboard.writeText(t.value); }
  const b = event && event.target;
  if(b) { const old = b.textContent; b.textContent = '已复制 ✓'; setTimeout(()=>b.textContent=old, 1500); }
}

/* ---------------- 初始化 ---------------- */

document.getElementById('topic').addEventListener('keydown', ev => { if(ev.key === 'Enter') doSearch(); });
loadHistory();
fillLLM();
fillAutoCfg();
