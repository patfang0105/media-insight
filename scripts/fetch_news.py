#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Media Insight · 全球新闻池生成脚本

在 GitHub Actions（境外服务器）上每 3 小时运行一次：
  按多个话题抓取 GDELT DOC API 的境外报道 → 合并去重 → 写出 news-data.json

设计要点：
  * 抓取发生在境外服务器，页面只读同域的 news-data.json，因此国内浏览器
    不需要直连 GDELT，也不受 CORS / 429 限流 / 跨境连通性影响。
  * 严格遵守 GDELT 的 5 秒频率限制（每次请求间隔 6.2 秒），429 时退避重试。
  * 与仓库中已有的 news-data.json 合并，池子随时间累积，覆盖面越来越广。
  * 若本次全部抓取失败，保留上一次的数据并标记 stale，绝不写空文件。
  * 只使用 Python 标准库，无需安装依赖。
"""
import datetime as dt
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

API = 'https://api.gdeltproject.org/api/v2/doc/doc'
GNEWS = 'https://news.google.com/rss/search'
OUT = 'news-data.json'
MAX_TOTAL = 1600          # 新闻池上限，控制文件体积（约 400-600 KB）
KEEP_DAYS = 45            # 旧数据最多保留 45 天
GAP = 6.2                 # GDELT 官方要求两次请求间隔 >= 5 秒
MAX_SECONDS = 720         # 单次运行总时间预算，避免限流时长时间占用 runner
UA = 'MediaInsight-NewsPool/1.0 (public news aggregator; contact: github.com/patfang0105)'
UA_BROWSER = 'Mozilla/5.0 (compatible; MediaInsight-NewsPool/1.0)'

# (中文主题标签, GDELT 查询, 浏览器本地打分的英文关键词, Google News 备用查询)
# 话题覆盖面尽量广：地缘、经贸、科技、金融、能源、气候、外交、安全……
# GDELT 是主源；当它被限流时，Google News RSS 作为独立备用源补位，
# 两者都在境外服务器抓取，写入同一个新闻池。
TOPICS = [
    ('APEC / 亚太峰会',        '(APEC OR summit OR "Asia Pacific") sourcelang:english',       'apec summit asia pacific',                       'APEC summit'),
    ('中美关系与贸易',          '(China OR "United States" OR bilateral OR tariffs) sourcelang:english', 'china us united states bilateral trade tariffs', 'US China trade tariffs'),
    ('关税与全球贸易',          '(tariffs OR "trade war" OR WTO OR exports OR imports) sourcelang:english', 'tariffs trade war wto exports imports',          'global tariffs trade war'),
    ('人工智能与监管',          '("artificial intelligence" OR AI OR regulation OR "AI Act") sourcelang:english', 'artificial intelligence ai regulation ai act',    'AI regulation artificial intelligence'),
    ('半导体与出口管制',        '(semiconductor OR chips OR "export controls" OR Nvidia) sourcelang:english', 'semiconductor chips export controls nvidia',     'semiconductor chips export controls'),
    ('美联储与全球利率',        '("Federal Reserve" OR "interest rates" OR inflation OR ECB) sourcelang:english', 'federal reserve interest rates inflation ecb central bank', 'Federal Reserve interest rates inflation'),
    ('俄乌局势与制裁',          '(Ukraine OR Russia OR NATO OR sanctions) sourcelang:english', 'ukraine russia nato sanctions',                  'Ukraine Russia sanctions'),
    ('中东局势',               '(Israel OR Gaza OR "Middle East" OR Iran) sourcelang:english', 'israel gaza middle east iran',                   'Middle East Israel Iran'),
    ('能源与油价',             '(oil OR OPEC OR energy OR LNG OR "gas prices") sourcelang:english', 'oil opec energy lng gas prices',                 'oil prices OPEC energy'),
    ('气候变化与绿色转型',      '(climate OR COP OR emissions OR "renewable energy") sourcelang:english', 'climate cop emissions renewable energy',          'climate change emissions COP'),
    ('欧洲政治与选举',          '(EU OR Europe OR Brussels OR election OR parliament) sourcelang:english', 'eu europe brussels election parliament',         'European Union politics election'),
    ('全球金融市场',            '(markets OR stocks OR bonds OR dollar OR currency) sourcelang:english', 'markets stocks bonds dollar currency',            'global markets stocks dollar'),
    ('科技平台与反垄断',        '("Big Tech" OR antitrust OR platform OR "social media") sourcelang:english', 'big tech antitrust platform social media',       'Big Tech antitrust regulation'),
    ('供应链与稀土',            '("supply chain" OR manufacturing OR "rare earths" OR shipping) sourcelang:english', 'supply chain manufacturing rare earths shipping', 'supply chain rare earths'),
    ('公共卫生与世卫',          '(health OR WHO OR pandemic OR vaccine OR disease) sourcelang:english', 'health who pandemic vaccine disease',              'global health WHO vaccine'),
    ('移民与边境',             '(migration OR border OR refugees OR asylum) sourcelang:english', 'migration border refugees asylum',                 'migration border refugees'),
    ('国防与安全',             '(defense OR military OR security OR weapons OR arms) sourcelang:english', 'defense military security weapons arms',          'defense military security'),
    ('国际组织与外交',          '(UN OR diplomacy OR G20 OR G7 OR "foreign minister") sourcelang:english', 'un diplomacy g20 g7 foreign minister',            'UN diplomacy G20 summit'),
    ('新兴市场与发展中经济体',  '(India OR Brazil OR Africa OR "emerging markets" OR IMF) sourcelang:english', 'india brazil africa emerging markets imf',       'emerging markets IMF India'),
    ('加密货币与金融科技',      '(crypto OR bitcoin OR fintech OR "digital currency") sourcelang:english', 'crypto bitcoin fintech digital currency',         'bitcoin crypto fintech'),
    ('全球综合要闻',            '(world OR global OR international OR economy OR policy) sourcelang:english', 'world global international economy policy',       'world news global economy'),
]

STOP = set(('the a an and or but of to in on at by for from with as is are was were be been it its '
            'this that these those their they them he she his her we our you your i me my not no '
            'so than then can will would could should may might must have has had do does did about '
            'into over under after before between through above below up down out off more most other '
            'some such only own same just now said says say new one two also which who what when where '
            'why how all any both each few').split())


def log(msg):
    print('[news-pool] ' + msg, flush=True)


def to_iso(s):
    """GDELT seendate '20261121T003000Z' -> '2026-11-21T00:30:00Z'"""
    s = (s or '').strip()
    m = re.match(r'^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$', s)
    if m:
        return '%s-%s-%sT%s:%s:%sZ' % m.groups()
    try:
        return dt.datetime.fromisoformat(s.replace('Z', '+00:00')).astimezone(
            dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    except Exception:
        return ''


def fetch(query, timespan='1m', tries=3):
    params = {
        'query': query, 'mode': 'artlist', 'maxrecords': '250',
        'format': 'json', 'sort': 'datedesc', 'timespan': timespan,
    }
    url = API + '?' + urllib.parse.urlencode(params)
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=35) as r:
                raw = r.read().decode('utf-8', 'ignore')
            if raw.lstrip().lower().startswith('please limit'):
                raise RuntimeError('GDELT rate-limit message')
            data = json.loads(raw)
            return data.get('articles') or [], ''
        except urllib.error.HTTPError as e:
            err = 'HTTP %s' % e.code
            wait = 22 * (k + 1) if e.code == 429 else 8
        except Exception as e:
            err = type(e).__name__ + ': ' + str(e)[:80]
            wait = 10 * (k + 1)
        if k < tries - 1:
            log('  %s → 等待 %ss 后重试 (%d/%d)' % (err, wait, k + 1, tries))
            time.sleep(wait)
        else:
            return [], err
    return [], 'unknown'


def title_keywords(title, limit=14):
    words = [w for w in re.findall(r'[A-Za-z][A-Za-z-]{2,}', title or '')
             if w.lower() not in STOP]
    seen, out = set(), []
    for w in words:
        lw = w.lower()
        if lw not in seen:
            seen.add(lw)
            out.append(lw)
        if len(out) >= limit:
            break
    return ' '.join(out)


def normalize(art, label, kw):
    title = re.sub(r'<[^>]+>', '', art.get('title') or '').strip()
    link = (art.get('url') or '').strip()
    if not title or not link:
        return None
    return {
        'title': title,
        'link': link,
        'source': (art.get('domain') or 'unknown').strip(),
        'date': to_iso(art.get('seendate')),
        'summary': '',                       # artlist 模式不提供摘要，页面会如实标注
        'country': (art.get('sourcecountry') or '').strip(),
        'topic': label,
        'keywords': (kw + ' ' + title_keywords(title)).strip(),
    }


def to_rss_date(s):
    """RSS pubDate (RFC 822) -> ISO 8601 UTC"""
    try:
        d = parsedate_to_datetime(s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return d.astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    except Exception:
        return ''


def fetch_gnews(query, label, kw, tries=2):
    """Google News RSS 备用源：GDELT 被限流时仍能取到境外报道。"""
    url = GNEWS + '?' + urllib.parse.urlencode({
        'q': query, 'hl': 'en-US', 'gl': 'US', 'ceid': 'US:en'})
    err = ''
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA_BROWSER})
            with urllib.request.urlopen(req, timeout=14) as r:
                raw = r.read().decode('utf-8', 'ignore')
            root = ET.fromstring(raw)
            out = []
            for it in root.findall('.//item'):
                title = (it.findtext('title') or '').strip()
                link = (it.findtext('link') or '').strip()
                if not title or not link:
                    continue
                desc = html.unescape(it.findtext('description') or '')
                summ = re.sub(r'<[^>]+>', ' ', desc)
                summ = re.sub(r'\s+', ' ', summ).strip()
                # Google News 的 description 常是「标题 + 来源」的重复，不算有效摘要
                if summ.lower().startswith(title.lower()[:35]):
                    summ = ''
                src_el = it.find('source')
                source = (src_el.text or '').strip() if src_el is not None else ''
                out.append({
                    'title': title,
                    'link': link,
                    'source': source or 'Google News',
                    'date': to_rss_date(it.findtext('pubDate') or ''),
                    'summary': summ[:600],
                    'country': '',
                    'topic': label,
                    'keywords': (kw + ' ' + title_keywords(title)).strip(),
                })
            return out, ''
        except Exception as e:
            err = type(e).__name__ + ': ' + str(e)[:70]
            if k < tries - 1:
                time.sleep(3)
    return [], err


def load_existing():
    try:
        with open(OUT, 'r', encoding='utf-8') as f:
            d = json.load(f)
        arts = d.get('articles') or []
        if isinstance(arts, list) and arts:
            return arts
    except Exception:
        pass
    return []


def main():
    now = dt.datetime.now(dt.timezone.utc)
    cutoff = now - dt.timedelta(days=KEEP_DAYS)
    old = load_existing()
    log('已有新闻池 %d 篇' % len(old))

    pool = {}
    warnings = []
    ok_topics = 0

    # 本地首次生成初始数据时可用 MI_MAX_TOPICS 限制话题数，加快速度；
    # GitHub Actions 定时运行时不设置该变量，跑完整话题表。
    limit = int(os.environ.get('MI_MAX_TOPICS', '0') or '0')
    todo = TOPICS[:limit] if 0 < limit < len(TOPICS) else TOPICS

    # 先把旧数据放入池子（保证本次就算全失败也有内容）
    for a in old:
        key = a.get('link') or a.get('title')
        if key and key not in pool:
            pool[key] = a

    started = time.monotonic()
    for i, (label, query, kw, gq) in enumerate(todo):
        if time.monotonic() - started > MAX_SECONDS:
            warnings.append('达到单次运行时间预算，剩余话题留待下一轮抓取。')
            break
        if i:
            time.sleep(GAP)
        arts, err = fetch(query)
        garts, gerr = [], ''
        # GDELT 被限流时，用 Google News RSS 作为独立备用源补位
        if not arts:
            garts, gerr = fetch_gnews(gq, label, kw)

        def merge(items):
            n = 0
            for item in items:
                key = item.get('link')
                if not key:
                    continue
                if key in pool:
                    prev = pool[key]
                    if label not in (prev.get('topic') or ''):
                        prev['topic'] = (prev.get('topic', '') + ' / ' + label).strip(' /')
                    prev['keywords'] = (prev.get('keywords', '') + ' ' + kw).strip()[:400]
                    if not prev.get('summary') and item.get('summary'):
                        prev['summary'] = item['summary']
                    continue
                pool[key] = item
                n += 1
            return n

        norm = []
        for a in arts:
            it = normalize(a, label, kw)
            if it:
                norm.append(it)
        added = merge(norm) + merge(garts)

        if arts or garts:
            ok_topics += 1
        else:
            warnings.append('%s：GDELT %s / Google News %s'
                            % (label, err or '无返回', gerr or '无返回'))
        log('[%2d/%d] %-16s GDELT %3d + GNews %3d → 新增 %3d 篇'
            % (i + 1, len(todo), label[:14], len(arts), len(garts), added))

    def in_range(a):
        d = a.get('date') or ''
        if not d:
            return True          # 无日期的保留，由前端按时间范围提示
        try:
            t = dt.datetime.fromisoformat(d.replace('Z', '+00:00'))
            return t >= cutoff
        except Exception:
            return True

    articles = [a for a in pool.values() if in_range(a)]
    articles.sort(key=lambda a: a.get('date') or '', reverse=True)
    if len(articles) > MAX_TOTAL:
        articles = articles[:MAX_TOTAL]

    stale = ok_topics == 0 and len(old) > 0
    prev_generated = ''
    try:
        with open(OUT, 'r', encoding='utf-8') as f:
            prev_generated = (json.load(f).get('generated_at') or '')
    except Exception:
        pass
    generated_at = now.strftime('%Y-%m-%dT%H:%M:%SZ')
    if stale:
        warnings.insert(0, '本次全部话题抓取失败，已保留上一次成功的新闻池数据。')
        # 时间戳不前进，避免页面误以为数据是新的
        if prev_generated:
            generated_at = prev_generated

    out = {
        'generated_at': generated_at,
        'stale': stale,
        'count': len(articles),
        'sources': len(set((a.get('source') or '?') for a in articles)),
        'topics': [t[0] for t in TOPICS],
        'ok_topics': ok_topics,
        'warnings': warnings[:20],
        'articles': articles,
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    log('写出 %s：%d 篇 / %d 家来源 / %d 个话题成功 / %.1f KB'
        % (OUT, out['count'], out['sources'], ok_topics,
           os.path.getsize(OUT) / 1024.0))
    if not articles:
        log('警告：新闻池为空（首次运行且 GDELT 全部限流），请稍后手动重跑 workflow')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
