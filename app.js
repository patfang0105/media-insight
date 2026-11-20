'use strict';

/* ============================================================
 * Media Insight · 纯静态版核心逻辑
 * 数据源：用户自建 RSS 聚合站 / GDELT DOC API / MyMemory 翻译
 * 全部在浏览器内运行，无服务端
 * ============================================================ */

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
  selected: new Set(),
  digest: null,
  warnings: []
};

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

/* ---------------- 翻译（MyMemory，双方向） ---------------- */

const transCache = new Map();
async function mymemory(text, from, to){
  const key = from + '|' + to + '|' + text;
  if(transCache.has(key)) return transCache.get(key);
  const url = MYMEMORY + '?' + new URLSearchParams({ q: text.slice(0,450), langpair: from + '|' + to });
  const r = await fetchWithTimeout(url, {}, 9000);
  if(!r.ok) throw new Error('翻译接口 HTTP ' + r.status);
  const d = await r.json();
  let out = (d.responseData && d.responseData.translatedText) || '';
  out = out.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&').trim();
  if(!out || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(out)) throw new Error('翻译接口未返回有效结果');
  transCache.set(key, out);
  return out;
}
async function translateTopic(text){
  if(!text || !hasChinese(text)) return { text: text, ok: !!text };
  try{
    const out = await mymemory(text, 'zh-CN', 'en');
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
    // 尊重源站 cache-control / ETag，浏览器自动走 304 条件请求；绝不使用 no-store 强制下载
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
  note.textContent = '正在从源站刷新…';
  try{
    await fetchRss(true);
    note.textContent = `已更新 ${rssMeta.count} 篇 · ${new Date(rssMeta.at).toLocaleString('zh-CN')}`;
  }catch(e){
    note.textContent = '刷新失败：' + e.message + '（工具仍可使用本机缓存）';
  }finally{
    btn.disabled = false;
  }
}
async function fetchGdelt(q, timespan){
  const query = '"' + q + '"' + (hasChinese(q) ? '' : ' sourcelang:english');
  const params = new URLSearchParams({
    query, mode:'artlist', maxrecords:'250', format:'json',
    sort:'datedesc', timespan: TIMESPAN_GDELT[timespan] || '1m'
  });
  const r = await fetchWithTimeout(GDELT_API + '?' + params, {}, 22000);
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
}

/* ---------------- 检索、打分、统计 ---------------- */

function scoreArticle(a, terms){
  const title = (a.title || '').toLowerCase();
  const summ  = (a.summary || '').toLowerCase();
  const extra = ((a.author || '') + ' ' + (a.source || '')).toLowerCase();
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
  let paywall = 0, withSummary = 0;
  for(const a of articles){
    if(a.date){
      const d = isoDay(a.date);
      if(d) byDay[d] = (byDay[d] || 0) + 1;
    }
    const s = a.source || '未知来源';
    bySrc[s] = (bySrc[s] || 0) + 1;
    if(a.paywall) paywall++;
    if(a.summary) withSummary++;
  }
  const days = Object.keys(byDay).sort();
  const topSources = Object.entries(bySrc).sort((a,b) => b[1]-a[1]).slice(0,10)
    .map(([source,count]) => ({source,count}));
  const total = articles.length;
  const heat = total >= 50 ? '高' : total >= 20 ? '中' : total > 0 ? '低' : '无命中';
  return {
    total, media_count: Object.keys(bySrc).length, paywall_count: paywall,
    summary_count: withSummary, heat_label: heat,
    by_day: days.map(day => ({day, count: byDay[day]})),
    top_sources: topSources
  };
}
async function doSearch(preset){
  hideError();
  const topic = (preset && preset.topic) || document.getElementById('topic').value.trim();
  if(!topic){ showError('请输入话题或主题'); return; }
  const sources = [];
  if(document.getElementById('srcRss').checked) sources.push('rss');
  if(document.getElementById('srcGdelt').checked) sources.push('gdelt');
  if(!sources.length){ showError('请至少选择一个检索源'); return; }

  const timespan = (preset && preset.timespan) || document.getElementById('timespan').value;
  const mode = document.getElementById('mode').value;
  let enkw = document.getElementById('enkw').value.trim();

  const btn = document.getElementById('goBtn');
  btn.disabled = true;
  setLoading(true, '正在翻译话题并检索境外媒体数据库…');
  document.getElementById('result').classList.add('hidden');
  state.warnings = [];
  state.selected = new Set();
  state.digest = null;

  try{
    let autoTranslated = false;
    if(!enkw){
      const t = await translateTopic(topic);
      enkw = t.text; autoTranslated = t.ok;
    }
    document.getElementById('enkw').value = enkw;

    setLoading(true, '正在抓取并匹配报道…');
    const pool = [];
    if(sources.includes('rss')){
      try{ pool.push(...await fetchRss()); }
      catch(e){ state.warnings.push('RSS 精选源抓取失败：' + e.message); }
    }
    if(sources.includes('gdelt')){
      try{ pool.push(...await fetchGdelt(enkw || topic, timespan)); }
      catch(e){ state.warnings.push('GDELT 未返回数据：' + e.message + '（可稍后重试，或仅用 RSS 源）'); }
    }
    if(!pool.length) throw new Error('所有检索源均未取到数据，请检查网络或稍后重试');

    const terms = tokenize(enkw || topic);
    const cutoff = Date.now() - (TIMESPAN_DAYS[timespan] || 30) * 86400000;
    const hits = [];
    for(const a of pool){
      if(a.date){ const t = new Date(a.date).getTime(); if(!isNaN(t) && t < cutoff) continue; }
      const { score, hitAll } = scoreArticle(a, terms);
      if(score <= 0) continue;
      if(mode === 'all' && !hitAll) continue;
      hits.push({ a, score });
    }
    hits.sort((x,y) => (y.score - x.score) ||
      ((new Date(y.a.date||0).getTime()||0) - (new Date(x.a.date||0).getTime()||0)));

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
  const snapNote = rssMeta.at
    ? ` · 数据源：${rssMeta.source}（${new Date(rssMeta.at).toLocaleString('zh-CN')}${rssMeta.stale ? '，离线缓存' : ''}）`
    : '';
  document.getElementById('heatNote').textContent =
    (rec.request.auto_translated ? `中文话题已自动译为「${rec.request.en_keywords}」。` : '') +
    `检索范围：${TIMESPAN_LABEL[rec.request.timespan]} · 检索源：${rec.request.sources.join(' + ')}` +
    snapNote +
    (rec.warnings.length ? ' · ⚠ ' + rec.warnings.join('；') : '');
  drawDayChart(s.by_day);
  renderSrcBars(s.top_sources);
  document.getElementById('result').classList.remove('hidden');
  document.getElementById('digestResult').classList.add('hidden');
  document.getElementById('digestActions').style.display = 'none';
  document.getElementById('digestHint').textContent =
    '勾选文章后点「总结提炼」，即可在此生成中文摘译与观点提炼；结果可下载为文档。';
  document.getElementById('aiPrompt').value = buildAIPrompt(rec);
  renderArticles();
  loadHistory();
}
function renderArticles(){
  const rec = state.record;
  if(!rec) return;
  const openOnly = document.getElementById('openOnly').checked;
  const list = rec.articles.map((a,i) => ({a,i})).filter(({a}) => !openOnly || !a.paywall);
  document.getElementById('artCount').textContent = list.length;
  document.getElementById('articles').innerHTML = list.length ? list.map(({a,i}) => `
    <div class="art ${state.selected.has(i) ? 'sel' : ''}" id="art-${i}">
      <div class="hd">
        <input type="checkbox" id="ck-${i}" ${state.selected.has(i)?'checked':''} onchange="toggleSel(${i})">
        <h3><a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.title)}</a></h3>
      </div>
      <div class="meta">
        <span class="tag ${a.origin}">${a.origin === 'rss' ? 'RSS 精选源' : 'GDELT 全球库'}</span>
        <b>${esc(a.source)}</b> · ${fmtDate(a.date)}
        <span class="tag ${a.paywall ? 'pay':'open'}">${esc(a.access)}</span>
        ${a.country ? ' · ' + esc(a.country) : ''}
        ${a.author ? ' · 作者 ' + esc(a.author) : ''}
      </div>
      ${a.summary ? `<div class="summ">${esc(a.summary.slice(0,460))}${a.summary.length>460?'…':''}</div>` : ''}
      <div class="card-actions">
        <a href="${esc(a.link)}" target="_blank" rel="noopener">原文</a>
        ${a.textise ? `<a href="${esc(a.textise)}" target="_blank" rel="noopener">Textise 文本视图</a>` : ''}
      </div>
    </div>`).join('') : '<p style="color:var(--muted)">当前筛选下没有报道，可取消「仅显示可公开访问」或扩大时间范围。</p>';
  updateSelCount();
}
function toggleSel(i){
  if(state.selected.has(i)) state.selected.delete(i); else state.selected.add(i);
  const el = document.getElementById('art-' + i);
  if(el) el.classList.toggle('sel', state.selected.has(i));
  updateSelCount();
}
function selectAll(on){
  const openOnly = document.getElementById('openOnly').checked;
  state.record.articles.forEach((a,i) => {
    if(openOnly && a.paywall) return;
    if(on) state.selected.add(i); else state.selected.delete(i);
  });
  renderArticles();
}
function selectOpen(){
  state.selected = new Set(state.record.articles.map((a,i) => !a.paywall ? i : -1).filter(i => i >= 0));
  renderArticles();
}
function updateSelCount(){
  const n = state.selected.size;
  document.getElementById('selCount').textContent = n;
  const b = document.getElementById('digestBtn');
  if(b) b.textContent = n ? `✦ 总结提炼选中文章（${n}）` : '✦ 总结提炼选中文章';
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

/* ---------------- 总结提炼：入口 ---------------- */

async function doDigest(){
  if(!state.record) return;
  const chosen = [...state.selected].sort((a,b) => a-b).map(i => state.record.articles[i]).filter(Boolean);
  if(!chosen.length){ showError('请先勾选至少一篇文章，再点「总结提炼」'); return; }
  hideError();
  const btn = document.getElementById('digestBtn');
  btn.disabled = true;
  document.getElementById('digestHint').textContent = '正在生成中文总结提炼…';

  let md = '', engine = '', degraded = '';
  const cfg = loadLLM();
  if(cfg.key){
    try{
      md = await llmDigest(chosen, cfg);
      engine = 'LLM 智能摘译（' + (cfg.model || 'gpt-4o-mini') + '）';
    }catch(e){
      degraded = 'LLM 调用失败，已自动降级为内置提炼：' + e.message;
      md = await extractiveDigest(chosen);
      engine = '内置提炼（免配置）';
    }
  }else{
    md = await extractiveDigest(chosen);
    engine = '内置提炼（免配置）';
  }

  const rec = state.record;
  const head = `# 「${rec.request.topic}」境外媒体总结提炼报告\n\n`
    + `> **生成时间**：${new Date().toLocaleString('zh-CN')}　|　**提炼引擎**：${engine}\n`
    + `> **选中报道**：${chosen.length} 篇 / ${new Set(chosen.map(a => a.source)).size} 家来源　|　`
    + `**检索词**：${rec.request.en_keywords}　|　**时间范围**：${TIMESPAN_LABEL[rec.request.timespan]}\n`
    + (degraded ? `> ⚠ ${degraded}\n` : '')
    + `> 本报告仅基于各媒体**公开提供的标题与摘要**生成，不含付费墙全文；请遵守原文版权。\n\n---\n\n`;
  md = head + md;

  const foot = `\n\n---\n\n## 信息局限与合规说明\n\n`
    + `- 本报告为**基于公开摘要的提炼**，不是全文翻译或全文摘要；付费墙报道仅使用其公开导语。\n`
    + `- 本次选中报道中，**${chosen.filter(a=>a.paywall).length} 篇需订阅**、**${chosen.filter(a=>!a.summary).length} 篇无公开摘要**，相关条目不得据此推断全文细节。\n`
    + `- 内置提炼采用规则式关键句抽取与免费机翻，措辞可能与原文存在偏差；重要判断请回溯原文链接核对。\n`
    + `- 材料仅供内部研判使用，转载与引用请遵循原文版权与订阅条款。\n`;
  md += foot;

  state.digest = { md, engine, chosen, degraded };
  document.getElementById('digestResult').innerHTML = mdToHtml(md);
  document.getElementById('digestResult').classList.remove('hidden');
  document.getElementById('digestActions').style.display = 'flex';
  document.getElementById('digestHint').textContent =
    `已生成（${engine}）${degraded ? ' · ' + degraded : ''}。可下载为 Markdown / HTML 文档。`;
  btn.disabled = false;
  document.getElementById('digestPanel').scrollIntoView({behavior:'smooth', block:'start'});
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
async function translateBatch(texts){
  // 并发受限的机翻；失败保留英文并标记
  const out = [];
  for(let i = 0; i < texts.length; i += 2){
    const chunk = texts.slice(i, i+2);
    const res = await Promise.all(chunk.map(async t => {
      if(!t) return {zh:'', ok:false};
      try{ return {zh: await mymemory(t, 'en', 'zh-CN'), ok:true}; }
      catch(e){ return {zh:'', ok:false}; }
    }));
    out.push(...res);
    if(i + 2 < texts.length) await new Promise(r => setTimeout(r, 250));
  }
  return out;
}
async function extractiveDigest(chosen){
  const rec = state.record;
  const terms = tokenize(rec.request.en_keywords || rec.request.topic);
  const maxTranslate = 12;

  // 1) 抽取关键句
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

  // 2) 机翻（标题 + 首个关键句），控制请求量
  const toTrans = [];
  items.slice(0, maxTranslate).forEach(it => {
    toTrans.push(it.a.title.slice(0,180));
    toTrans.push((it.keySents[0] || '').slice(0,260));
  });
  let zh = [];
  try{ zh = await translateBatch(toTrans); }
  catch(e){ zh = toTrans.map(() => ({zh:'', ok:false})); }
  let transFail = 0;
  items.forEach((it, k) => {
    if(k < maxTranslate){
      it.zhTitle = zh[k*2] ? zh[k*2].zh : '';
      it.zhKey   = zh[k*2+1] ? zh[k*2+1].zh : '';
      if(!zh[k*2+1] || !zh[k*2+1].ok) transFail++;
    }else{ it.zhTitle = ''; it.zhKey = ''; }
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
  md += `| 选中报道 | ${chosen.length} 篇 |\n| 涉及来源 | ${Object.keys(srcCount).length} 家 |\n`;
  md += `| 需订阅 / 仅标题 | ${chosen.filter(a=>a.paywall).length} / ${chosen.filter(a=>!a.summary).length} 篇 |\n`;
  md += `| 时间跨度 | ${span} |\n| 提炼引擎 | 内置规则式提炼（免配置） |\n\n`;
  md += `**主要来源**：` + Object.entries(srcCount).sort((a,b)=>b[1]-a[1]).slice(0,8)
          .map(([s,c]) => `${s}（${c}）`).join('、') + `\n\n`;
  if(kws.length) md += `**高频主题词**：` + kws.slice(0,10).map(([w,c]) => `\`${w}\`(${c})`).join('、') + `\n\n`;

  md += `## 二、逐篇中文摘译与要点\n\n`;
  md += `> 说明：以下「中文要点」由免费机翻生成，措辞可能与原文有偏差；\`原文关键句\` 保留英文以便核对。\n\n`;
  items.forEach((it, k) => {
    const a = it.a;
    md += `### ${k+1}. ${it.zhTitle || a.title}\n\n`;
    md += `- **来源**：${a.source}　|　**日期**：${fmtDate(a.date)}　|　**访问级别**：${a.access}\n`;
    md += `- **原文标题**：${a.title}\n`;
    md += `- **原文链接**：${a.link}\n`;
    if(it.tags.length) md += `- **提炼标签**：${it.tags.join('、')}\n`;
    if(it.zhKey) md += `- **中文要点**：${it.zhKey}\n`;
    else if(it.keySents[0]) md += `- **中文要点**：（机翻未成功，请见下方英文关键句）\n`;
    else md += `- **中文要点**：该条目无公开摘要，仅能提供标题，不得据此推断正文内容。\n`;
    it.keySents.forEach(s => { md += `  > 原文关键句：${s}\n`; });
    md += `\n`;
  });

  md += `## 三、观点提炼与信号\n\n`;
  md += `### 共识线索\n\n`;
  if(shared.length){
    md += `多篇报道共同聚焦：${shared.map(([w,c]) => `\`${w}\`（${c} 篇提及）`).join('、')}。` +
          `这表明境外媒体对该话题的关注集中在上述维度，可作为研判主线。\n\n`;
  }else{
    md += `选中报道的高频词重叠度较低，议题分布较分散，尚不足以归纳出明确共识。建议扩大选样或聚焦单一子话题后再提炼。\n\n`;
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
    md += `> ⚠ 本次有 ${transFail} 篇的要点机翻未成功（免费接口限额或网络波动），已保留英文关键句。\n\n`;
  }
  if(chosen.length > maxTranslate){
    md += `> 为保证响应速度，仅对前 ${maxTranslate} 篇执行了机翻，其余条目保留英文原文与标签。\n\n`;
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
    `公开摘要: ${a.summary || '（无公开摘要，仅标题）'}\n链接: ${a.link}`).join('\n\n');

  const system = '你是一名专业的境外媒体舆情分析员，面向中文读者做摘译与提炼。'
    + '严格依据给定材料，不得编造、补全或推测付费墙全文内容；对「仅标题/仅导语」的条目必须明确说明信息受限。'
    + '输出为结构化中文 Markdown。';
  const user = `话题：${rec.request.topic}（英文检索词：${rec.request.en_keywords}）\n`
    + `共选中 ${chosen.length} 篇境外媒体报道，材料如下（均为公开标题与公开摘要，非全文）：\n\n`
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

/* ---------------- 下载 ---------------- */

function downloadBlob(name, content, type){
  const blob = new Blob([content], {type: type || 'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function safeName(s){ return (s || 'media-insight').replace(/[\\/:*?"<>|\s]+/g,'_').slice(0,40); }
function htmlDoc(title, bodyHtml){
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(title) + '</title><style>'
    + 'body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;max-width:900px;margin:0 auto;padding:28px;color:#1f2937;line-height:1.8}'
    + 'h1{border-bottom:3px solid #1a56db;padding-bottom:10px}h2{border-left:4px solid #1a56db;padding-left:10px;margin-top:30px}'
    + 'h3{color:#1e40af}blockquote{background:#f1f5f9;border-left:3px solid #94a3b8;margin:10px 0;padding:8px 14px;color:#475569}'
    + 'table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #d1d5db;padding:6px 10px;font-size:13px}th{background:#eff6ff}'
    + 'code{background:#f1f5f9;padding:1px 5px;border-radius:4px}pre{background:#f8fafc;padding:12px;overflow:auto}'
    + 'a{color:#1a56db}hr{border:none;border-top:1px solid #e5e7eb;margin:24px 0}'
    + '</style></head><body>' + bodyHtml + '</body></html>';
}
function downloadDigest(fmt){
  if(!state.digest) return;
  const name = safeName(state.record.request.topic) + '_总结提炼';
  if(fmt === 'md') downloadBlob(name + '.md', state.digest.md, 'text/markdown;charset=utf-8');
  else downloadBlob(name + '.html', htmlDoc(name, mdToHtml(state.digest.md)), 'text/html;charset=utf-8');
}
function buildPackMd(rec){
  const s = rec.stats, r = rec.request;
  let md = `# 「${r.topic}」境外媒体报道素材包\n\n`;
  md += `> 检索时间：${new Date(r.created_at).toLocaleString('zh-CN')}　|　英文检索词：${r.en_keywords}\n`;
  md += `> 时间范围：${TIMESPAN_LABEL[r.timespan]}　|　检索源：${r.sources.join(' + ')}　|　共 ${s.total} 篇 / ${s.media_count} 家来源，热度：${s.heat_label}\n\n`;
  md += `## 一、报道概览\n\n| 项目 | 数值 |\n|---|---|\n`;
  md += `| 相关报道 | ${s.total} |\n| 涉及媒体/机构 | ${s.media_count} |\n| 需订阅报道 | ${s.paywall_count} |\n| 含公开摘要 | ${s.summary_count} |\n`;
  md += `| 时间分布 | ${s.by_day.map(d=>d.day+'('+d.count+')').join('、') || '无'} |\n\n`;
  md += `## 二、关键报道清单\n\n`;
  rec.articles.forEach((a,i) => {
    md += `### ${i+1}. ${a.title}\n\n`;
    md += `- **来源**：${a.source}　|　**日期**：${fmtDate(a.date)}　|　**访问级别**：${a.access}\n`;
    md += `- **链接**：${a.link}\n`;
    if(a.author) md += `- **作者**：${a.author}\n`;
    if(a.summary) md += `- **公开摘要**：${a.summary}\n`;
    else md += `- **公开摘要**：（无，仅标题可用）\n`;
    md += `\n`;
  });
  md += `---\n\n> 合规声明：本素材包仅收录各媒体公开提供的标题与摘要/导语，不绕过付费验证；付费墙报道须自行订阅阅读。材料仅供内部研判，请遵守原文版权。\n`;
  return md;
}
function downloadPack(fmt){
  if(!state.record) return;
  const name = safeName(state.record.request.topic) + '_素材包';
  if(fmt === 'md') downloadBlob(name + '.md', buildPackMd(state.record), 'text/markdown;charset=utf-8');
  else downloadBlob(name + '.html', htmlDoc(name, mdToHtml(buildPackMd(state.record))), 'text/html;charset=utf-8');
}

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
