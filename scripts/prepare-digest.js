#!/usr/bin/env node

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const USER_DIR = join(homedir(), '.content-signal-radar');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const CUSTOM_SOURCES_PATH = join(USER_DIR, 'custom-sources.json');
const SEEN_SIGNALS_PATH = join(USER_DIR, 'seen-signals.json');
const NO_SEEN = process.argv.includes('--no-seen');
// Fallback is deliberately opt-in: ordinary/repeated runs must not turn a
// same-day dedup result into a "new signal insufficient" message.
const ALLOW_SEEN_FALLBACK = process.argv.includes('--allow-seen-fallback');

const FEED_X_URL = process.env.FEED_X_URL || 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const FEED_PODCASTS_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const FEED_BLOGS_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json';

const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'summarize-blogs.md',
  'digest-intro.md',
  'translate.md'
];

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function clip(text = '', max = 280) {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

// 正文展示：默认接近全文，只有极长才截断（推文/即刻通常远小于此上限）
const BODY_TEXT_MAX = 1200;
const TITLE_BODY_MAX = 1000;
const REPLY_TEXT_MAX = 180;
const INFO_SECTION_CAP = 10;   // 知情（X）最多条数
const DRAFT_SECTION_CAP = 10;  // 成稿原料（非 X）最多条数
const DRAFT_MATERIAL_TYPES = new Set(['blog_post', 'podcast_episode', 'bilibili_dynamic']); // 2026-10-26：jike_post 移出成稿原料

function isXSignal(item = {}) {
  return item.type === 'x_tweet';
}

function isDraftMaterial(item = {}) {
  return DRAFT_MATERIAL_TYPES.has(item.type);
}

/** 万能/旧腔评价仅作内部/附录，不得进正文评价行 */
function isGenericReviewNote(note = '') {
  const n = String(note || '').trim();
  if (!n) return true;
  if (/^保留理由：/.test(n)) return true;
  if (/分数刚过线/.test(n)) return true;
  if (/主题词没命中/.test(n) && /先当热度/.test(n)) return true;
  if (/形式分偏低/.test(n)) return true;
  // 旧腔禁句（2026-10-26 扩帖切口改革）
  if (/能否扩成帖/.test(n)) return true;
  if (/别停在 Agent/.test(n)) return true;
  if (/值得看：这条多出来的具体信息/.test(n)) return true;
  if (/值得看：/.test(n) && /（钩子：/.test(n)) return true;
  if (/不要和同题空话合并/.test(n)) return true;
  if (/^看点：/.test(n) || /\]\s*看点：/.test(n)) return true;
  if (/抽一条可复用判断框架|不搬运目录/.test(n)) return true;
  if (/标签说明/.test(n)) return true;
  // 正文评价必须是「扩帖切口：…」人话一句
  if (!/^扩帖切口：/.test(n)) return true;
  return false;
}

/** 从 item/tweet 上可选字段取高赞回复摘要；没有正文则返回空数组（渲染层标「评论未取到」） */
function extractTopReplies(source = {}) {
  const raw =
    source.topReplies ||
    source.replySummaries ||
    source.top_replies ||
    source.replyTexts ||
    source.comments ||
    [];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw
    .map((r) => {
      if (typeof r === 'string') return { text: r.trim(), likes: 0, author: '' };
      const text = String(r.text || r.summary || r.content || r.body || '').trim();
      if (!text) return null;
      return {
        text,
        likes: Number(r.likes || r.favorite_count || r.likeCount || 0) || 0,
        author: String(r.author || r.handle || r.user?.screen_name || r.user?.name || '').replace(/^@/, ''),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.likes - a.likes)
    .slice(0, 3);
}

/** 展示层去 HTML：先解实体再剥标签，避免即刻 RSS 的 &lt;br&gt; 残留 */
function stripHtmlForDisplay(text = '') {
  let s = String(text || '');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  s = s
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    // RSS/即刻摘要常在标签中途被截断，清掉尾部残缺标签
    .replace(/<(?:img\b|br\b)?[^>]*$/gi, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}

function signalBodyText(item = {}) {
  const raw = stripHtmlForDisplay(item.fullText || item.summary || item.title || '')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(raw, BODY_TEXT_MAX);
}

function includesAny(text = '', keywords = []) {
  const lower = text.toLowerCase();
  return (keywords || []).some(keyword => lower.includes(String(keyword).toLowerCase()));
}

function keywordMatches(lowerText, keyword) {
  const normalized = String(keyword || '').trim().toLowerCase();
  if (!normalized) return false;

  // Avoid one-letter focus topics (for example "X") matching almost every
  // long-form article through ordinary words. Require token boundaries there.
  if (/^[a-z0-9]$/i.test(normalized)) {
    return new RegExp(`(^|[^a-z0-9])${normalized}([^a-z0-9]|$)`, 'i').test(lowerText);
  }

  return lowerText.includes(normalized);
}

function matchedKeywords(text = '', keywords = []) {
  const lower = text.toLowerCase();
  return (keywords || [])
    .map(keyword => String(keyword).trim())
    .filter(Boolean)
    .filter(keyword => keywordMatches(lower, keyword));
}

function shanghaiDayStartMs(date = new Date()) {
  const todayStr = date.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD
  return new Date(`${todayStr}T00:00:00+08:00`).getTime();
}

function hoursAgo(isoString) {
  if (!isoString) return 48;
  const ts = new Date(isoString).getTime();
  if (Number.isNaN(ts)) return 48;
  return Math.max(0, (Date.now() - ts) / 36e5);
}

function normalizeRecency(hours) {
  if (hours <= 6) return 1;
  if (hours <= 12) return 0.9;
  if (hours <= 24) return 0.75;
  if (hours <= 48) return 0.55;
  return 0.35;
}

function normalizeEngagement(metrics = {}) {
  const likes = metrics.likes || 0;
  const retweets = metrics.retweets || 0;
  const replies = metrics.replies || 0;
  const raw = likes + retweets * 2 + replies * 1.5;
  if (raw >= 5000) return 1;
  if (raw >= 1000) return 0.8;
  if (raw >= 300) return 0.65;
  if (raw >= 100) return 0.5;
  if (raw > 0) return 0.35;
  return 0.15;
}


/** Reply heuristic: feed has isQuote but often no inReplyToId/isReply. */
function isReplyTweet(tweet = {}) {
  if (tweet.isQuote) return false; // quote-tweets count as main-post form
  if (tweet.isReply === true || tweet.inReplyToId || tweet.in_reply_to_status_id) return true;
  const text = String(tweet.text || '').trim();
  return /^@[\w]+/.test(text);
}

/** Writability: default 0.55; >=0.8 only for clear tutorial/list/adaptable angle + substance. */
function scoreWriteability(text = '') {
  const raw = String(text || '');
  const t = raw.toLowerCase();
  const wordCount = t.trim().split(/\s+/).filter(Boolean).length;
  const hasSubstance = wordCount >= 25 || raw.replace(/\s+/g, ' ').trim().length >= 120;
  const hasTutorial = /\b(how to|step[- ]by[- ]step|guide|tutorial|checklist|playbook|walkthrough)\b/.test(t)
    || /教程|清单|步骤|怎么做|如何做/.test(raw)
    || /(^|\n)\s*(?:[-*•]|\d+[.)])\s+\S+/m.test(raw);
  const hasAngle = /\b(why |lesson|mistake|unpopular|contrarian|framework|takeaway|here'?s how)\b/.test(t)
    || /为什么|教训|误区|框架|可改编|写作角度/.test(raw);
  if ((hasTutorial || hasAngle) && hasSubstance) return 0.85;
  if (hasTutorial || (hasAngle && wordCount >= 18)) return 0.8;
  // Soft keyword alone must not jump to 0.8
  if (includesAny(t, ['why', 'how', 'learn', 'mistake', 'distribution', 'brand', 'agent', 'product', 'workflow'])) {
    return hasSubstance ? 0.65 : 0.55;
  }
  return 0.55;
}


function normalizeConfig(input = {}) {
  return {
    name: input.name || 'Content Signal Radar',
    platform: input.platform || 'openclaw',
    language: input.language || 'zh',
    timezone: input.timezone || 'Asia/Shanghai',
    frequency: input.frequency || 'daily',
    deliveryTime: input.deliveryTime || '09:00',
    weeklyDay: input.weeklyDay || 'monday',
    delivery: input.delivery || { method: 'stdout' },
    focusTopics: input.focusTopics || [
      // AI / 技术方向
      'agent', 'llm', 'gpt', 'claude', 'model', 'inference', 'fine-tun',
      'ai tool', 'ai product', 'ai workflow',
      // 独立开发 / 出海
      'indie', 'solopreneur', 'build in public', 'ship', 'launch', 'saas',
      'mrr', 'arr', 'revenue', 'monetiz',
      // 内容 / 品牌
      'personal brand', 'creator', 'audience', 'distribution', 'growth',
      'newsletter', 'x thread', 'viral',
      // 产品 / 工具
      'product', 'workflow', 'automation', 'integration', 'api',
      'builder', 'maker', 'founder',
      // 中文关键词
      'AI 产品', 'AI 出海', '出海', '独立开发'
    ],
    contentGoals: input.contentGoals || ['product_insights', 'x_posts', 'learning'],
    outputSections: input.outputSections || ['brief', 'x_angles', 'product_signals', 'action_items'],
    outputMode: input.outputMode || 'balanced',
    sourceProfiles: input.sourceProfiles || ['default', 'maple'],
    disabledSections: input.disabledSections || ['xiaohongshu_topics'],
    reservedSourceProfiles: input.reservedSourceProfiles || ['zh_creators'],
    sourceWeights: input.sourceWeights || {
      _catwu: 1.2,
      zarazhangrui: 1.25,
      levelsio: 1.15,
      tdinh_me: 1.0,
      lexfridman: 0.35,
      leerob: 1.2,
      steipete: 1.1,
      naval: 0.35,
      thedankoe: 0.35,
      gregisenberg: 1.0,
      rauchg: 1.15,
      karpathy: 1.1
    },
    sourceWeightReasons: input.sourceWeightReasons || {
      zarazhangrui: '高密度 agent / builder 信号,且和你的关注方向高度一致',
      _catwu: '产品与 builder 视角兼具,噪音相对低',
      leerob: 'AI 产品、开发者工具、分发视角稳定',
      levelsio: '独立开发 + 分发 + 出海视角强',
      rauchg: '产品范式变化和 platform 视角常有高信号',
      steipete: '开发者工具与 AI 工作流洞察稳定',
      karpathy: '技术方向权重大,但不一定每天都直接可写'
    },
    scoring: {
      relevance: input.scoring?.relevance ?? 0.35,
      writeability: input.scoring?.writeability ?? 0.18,
      actionability: input.scoring?.actionability ?? 0.2,
      novelty: input.scoring?.novelty ?? 0.12,
      engagement: input.scoring?.engagement ?? 0.10,
      recency: input.scoring?.recency ?? 0.05,
      minimum: input.scoring?.minimum ?? 0.58,
      sourceWeightCap: input.scoring?.sourceWeightCap ?? 1.3
    },
    limits: {
      brief: input.limits?.brief ?? 5,
      x_angles: input.limits?.x_angles ?? 3,
      product_signals: input.limits?.product_signals ?? 3,
      x_drafts: 0,
      action_items: input.limits?.action_items ?? 3
    },
    onboardingComplete: input.onboardingComplete ?? false
  };
}

async function fetchJSON(url) {
  if (!url) return null;
  // Support local absolute paths and file:// URLs (e.g. FEED_X_URL override).
  if (url.startsWith('file://') || url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(url)) {
    const filePath = url.startsWith('file://') ? decodeURIComponent(url.slice('file://'.length)) : url;
    try {
      const text = await readFile(filePath, 'utf8');
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function fetchRSSFeed(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.error(`[fetchRSSFeed] HTTP ${res.status} for ${url}`);
      return [];
    }
    const text = await res.text();
    const items = [];
    const itemPattern = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
    let match;
    while ((match = itemPattern.exec(text)) !== null) {
      const block = match[1];
      const getTag = (tag) => {
        const m = block.match(new RegExp(`<${tag}(?:[^>]*)><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'))
                || block.match(new RegExp(`<${tag}(?:[^>]*)>([^<]*)<\\/${tag}>`, 'i'));
        return m ? m[1].trim() : '';
      };
      const getLinkAttr = () => {
        const m = block.match(/<link[^>]+href=["']([^"']+)["']/i);
        return m ? m[1] : getTag('link');
      };
      const title = getTag('title');
      const link = getLinkAttr() || getTag('link');
      const summary = getTag('summary') || getTag('description') || getTag('content');
      const pubDate = getTag('published') || getTag('updated') || getTag('pubDate');
      if (title || summary) {
        items.push({ title, link, summary, pubDate });
      }
    }
    return items;
  } catch (err) {
    console.error(`[fetchRSSFeed] Error fetching ${url}: ${err.message}`);
    return [];
  }
}

async function loadTextPrompt(filename, localPromptsDir, userPromptsDir) {
  const userPath = join(userPromptsDir, filename);
  const localPath = join(localPromptsDir, filename);
  if (existsSync(userPath)) return readFile(userPath, 'utf-8');
  if (existsSync(localPath)) return readFile(localPath, 'utf-8');
  return null;
}

async function loadLocalSourceProfiles(configDir) {
  const path = join(configDir, 'default-sources.json');
  const raw = JSON.parse(await readFile(path, 'utf-8'));
  if (raw.profiles) return raw.profiles;
  return { default: raw };
}

async function loadCustomSources() {
  if (!existsSync(CUSTOM_SOURCES_PATH)) {
    return { x_accounts: [], blogs: [], podcasts: [], jike_accounts: [], bilibili_accounts: [], zh_creators: { enabled: false, sources: [] } };
  }
  try {
    const parsed = JSON.parse(await readFile(CUSTOM_SOURCES_PATH, 'utf-8'));
    return {
      x_accounts: parsed.x_accounts || [],
      blogs: parsed.blogs || [],
      podcasts: parsed.podcasts || [],
      jike_accounts: parsed.jike_accounts || [],
      bilibili_accounts: parsed.bilibili_accounts || [],
      zh_creators: parsed.zh_creators || { enabled: false, sources: [] }
    };
  } catch {
    return { x_accounts: [], blogs: [], podcasts: [], jike_accounts: [], bilibili_accounts: [], zh_creators: { enabled: false, sources: [] } };
  }
}

function mergeSources(profiles, enabledProfiles, customSources) {
  const merged = { x_accounts: [], blogs: [], podcasts: [], jike_accounts: [], bilibili_accounts: [] };
  for (const profileName of enabledProfiles) {
    const profile = profiles[profileName];
    if (!profile) continue;
    merged.x_accounts.push(...(profile.x_accounts || []));
    merged.blogs.push(...(profile.blogs || []));
    merged.podcasts.push(...(profile.podcasts || []));
    merged.jike_accounts.push(...(profile.jike_accounts || []));
    merged.bilibili_accounts.push(...(profile.bilibili_accounts || []));
  }
  merged.x_accounts.push(...(customSources.x_accounts || []));
  merged.blogs.push(...(customSources.blogs || []));
  merged.podcasts.push(...(customSources.podcasts || []));
  merged.jike_accounts.push(...(customSources.jike_accounts || []));
  merged.bilibili_accounts.push(...(customSources.bilibili_accounts || []));

  return {
    x_accounts: uniqBy(merged.x_accounts, item => (item.handle || '').toLowerCase()),
    blogs: uniqBy(merged.blogs, item => item.indexUrl || item.name),
    podcasts: uniqBy(merged.podcasts, item => item.playlistId || item.channelHandle || item.url || item.name),
    jike_accounts: uniqBy(merged.jike_accounts, item => item.uuid || item.rsshub),
    bilibili_accounts: uniqBy(merged.bilibili_accounts, item => item.uid || item.rsshub)
  };
}

function filterFeedBySources(feedX, feedPodcasts, feedBlogs, mergedSources) {
  const allowedHandles = new Set((mergedSources.x_accounts || []).map(a => (a.handle || '').toLowerCase()));
  const allowedPodcastKeys = new Set((mergedSources.podcasts || []).map(p => p.name));
  const allowedBlogKeys = new Set((mergedSources.blogs || []).map(b => b.name));

  return {
    x: (feedX?.x || []).filter(item => allowedHandles.has((item.handle || '').toLowerCase())),
    podcasts: (feedPodcasts?.podcasts || []).filter(item => allowedPodcastKeys.has(item.name)),
    blogs: (feedBlogs?.blogs || []).filter(item => allowedBlogKeys.has(item.name))
  };
}

async function fetchDirectRSSSources(mergedSources) {
  const results = {
    jike: [],
    rss_blogs: [],
    bilibili: [],
    rssFetchStats: { blogs: {}, jike: {}, bilibili: {}, blogFetchedTotal: 0, blogZeroSources: [] }
  };

  // 抓即刻账号（2026-10-26 起配置可为空；抓到也不进正文两区）
  const jikeAccounts = mergedSources.jike_accounts || [];
  if (jikeAccounts.length > 0) {
    console.error(`[fetchDirectRSS] Fetching ${jikeAccounts.length} jike accounts...`);
  }
  const jikeResults = await Promise.all(
    jikeAccounts.map(async (account) => {
      if (!account.rsshub) return [];
      const items = await fetchRSSFeed(account.rsshub);
      results.rssFetchStats.jike[account.name] = items.length;
      console.error(`[fetchDirectRSS] jike ${account.name}: ${items.length} items`);
      return items.slice(0, 5).map(item => ({
        type: 'jike_post',
        handle: account.name,
        name: account.name,
        title: item.title || clip(item.summary, 60),
        summary: clip(item.summary, 280),
        url: item.link || '',
        publishedAt: item.pubDate || null,
        metrics: { likes: 0, retweets: 0, replies: 0 },
        source: 'jike'
      }));
    })
  );
  results.jike = jikeResults.flat();

  // 抓 type: 'rss' 的 blogs
  const rssBlogs = (mergedSources.blogs || []).filter(b => b.type === 'rss' && b.indexUrl);
  if (rssBlogs.length > 0) {
    console.error(`[fetchDirectRSS] Fetching ${rssBlogs.length} RSS blogs...`);
  }
  const rssResults = await Promise.all(
    rssBlogs.map(async (blog) => {
      const items = await fetchRSSFeed(blog.indexUrl);
      results.rssFetchStats.blogs[blog.name] = items.length;
      if (items.length === 0) results.rssFetchStats.blogZeroSources.push(blog.name);
      console.error(`[fetchDirectRSS] rss blog ${blog.name}: ${items.length} items`);
      return items.slice(0, 3).map(item => ({
        type: 'blog_post',
        name: blog.name,
        author: blog.name,
        title: item.title || '',
        summary: clip(item.summary, 280),
        url: item.link || '',
        publishedAt: item.pubDate || null,
        metrics: { likes: 0, retweets: 0, replies: 0 },
        source: 'rss_blog'
      }));
    })
  );
  results.rss_blogs = rssResults.flat();
  results.rssFetchStats.blogFetchedTotal = results.rss_blogs.length;

  // 抓 Bilibili 账号
  const bilibiliAccounts = mergedSources.bilibili_accounts || [];
  if (bilibiliAccounts.length > 0) {
    console.error(`[fetchDirectRSS] Fetching ${bilibiliAccounts.length} bilibili accounts...`);
  }
  const bilibiliResults = await Promise.all(
    bilibiliAccounts.map(async (account) => {
      if (!account.rsshub) return [];
      const items = await fetchRSSFeed(account.rsshub);
      results.rssFetchStats.bilibili[account.name] = items.length;
      console.error(`[fetchDirectRSS] bilibili ${account.name}: ${items.length} items`);
      return items.slice(0, 3).map(item => ({
        type: 'bilibili_dynamic',
        handle: account.name,
        name: account.name,
        title: item.title || clip(item.summary, 60),
        summary: clip(item.summary, 280),
        url: item.link || '',
        publishedAt: item.pubDate || null,
        metrics: { likes: 0, retweets: 0, replies: 0 },
        source: 'bilibili'
      }));
    })
  );
  results.bilibili = bilibiliResults.flat();

  return results;
}

function getSourceWeight(signal, config) {
  const cap = config.scoring?.sourceWeightCap ?? 1.3;
  if (signal.type === 'x_tweet') {
    const weight = config.sourceWeights?.[signal.handle] ?? 1;
    return Math.min(weight, cap);
  }
  return 1;
}

function getSourceReason(handle, config) {
  return config.sourceWeightReasons?.[handle] || null;
}

function applyOutputModeBoosts(base, mode, signal) {
  if (mode === 'signal_only') {
    if (signal.type === 'blog_post' || signal.type === 'podcast_episode') return base + 0.04;
    return base;
  }
  if (mode === 'x_draft') {
    if (signal.type === 'x_tweet') return base + 0.05;
    return base;
  }
  return base;
}

// Low-signal detection: returns a penalty multiplier (0.0 - 1.0)
// 1.0 = no penalty, lower = punished for being low-signal
function lowSignalPenalty(text = '') {
  const t = text.toLowerCase();

  // === Hard low-signal patterns → heavy penalty (0.2) ===

  // Pure RT / retweet with no added commentary
  if (/^rt\s+@/.test(t) || /^rt\s*:/.test(t)) return 0.2;

  // Pure emoji replies (3+ emoji, total word count < 10)
  const emojiMatches = t.match(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu) || [];
  const wordCount = t.trim().split(/\s+/).length;
  if (emojiMatches.length >= 3 && wordCount < 10) return 0.2;

  // Hollow agreement / empty affirmation
  const hollowAgreement = [
    /^(agree|agreed|agreeing)[\s!.]*$/,
    /^\+1[\s!.]*$/,
    /^this[\s!.]*$/,
    /^facts?[\s!.]*$/,
    /^(real|true|truth)[\s!.]*$/,
    /^(so true|exactly|100%|💯)[\s!.]*$/,
    /^(yep|yup|yes|yessir)[\s!.]*$/,
  ];
  for (const pattern of hollowAgreement) {
    if (pattern.test(t.trim())) return 0.2;
  }

  // "just joined" / "just started" type
  const justJoinedPatterns = [
    /just (joined|started|signed up|created)/,
    /new here/,
    /day\s*1\b/,
    /first (day|week) (at|on|with)/,
  ];
  for (const pattern of justJoinedPatterns) {
    if (pattern.test(t)) return 0.2;
  }

  // Original hard low-signal patterns (0.25)
  const hardLowSignal = [
    /congratulat/,
    /happy birthday/,
    /welcome (to|aboard)/,
    /excited to (announce|share|join)/,
    /thrilled to/,
    /honored to/,
    /proud to (announce|share)/,
    /just hit \d+k/,
    /\d+k followers/,
    /follow(ers)? milestone/,
    /thank you (all|everyone|so much)/,
    /gm\b/,
    /\bgm\b/,
    /good morning everyone/,
    /vibes?(\s|$)/,
    /let's go[!🚀]/,
    /🚀🚀/,
    /🙏🙏/,
  ];
  for (const pattern of hardLowSignal) {
    if (pattern.test(t)) return 0.25;
  }

  // === Soft low-signal patterns → mild penalty (0.55) ===

  // "thread 👇" / "a thread" but only a title, no substance (short)
  const threadTeaserPatterns = [
    /thread\s*👇/,
    /a thread\s*[👇⬇️↓:]/,
    /\bthread\b.*\b(on|about)\b/,
  ];
  for (const pattern of threadTeaserPatterns) {
    if (pattern.test(t) && wordCount <= 20) return 0.55;
  }

  // Self-promotion without technical detail
  const selfPromoPatterns = [
    /\bmy new\b/,
    /\bi just (launched|shipped|released|published|dropped)\b/,
    /\bwe just (launched|shipped|released|published|dropped)\b/,
    /\bjust (launched|shipped|released) my\b/,
    /\bcheck out (my|our)\b/,
  ];
  const hasTechDetail = /\b(api|sdk|cli|stack|architecture|benchmark|performance|latency|throughput|token|model|inference|fine.?tun|integration|pipeline|agent|workflow|automation)\b/.test(t);
  for (const pattern of selfPromoPatterns) {
    if (pattern.test(t) && !hasTechDetail) return 0.55;
  }

  // Original soft low-signal patterns (0.65)
  const softLowSignal = [
    /new (post|article|blog|video|thread) (is )?(out|live|up)/,
    /just published/,
    /check (this|it) out/,
    /link in bio/,
    /swipe (left|right|up)/,
    /dropping (soon|today|now)/,
    /beautiful(ly)?/,
    /aesthetic/,
    /design flex/,
    /nice work/,
    /great (job|work|post)/,
  ];
  for (const pattern of softLowSignal) {
    if (pattern.test(t)) return 0.65;
  }

  // Very short tweets with no real substance — but exempt if they contain strong signal keywords
  const strongSignalKeywords = ['agent', 'product', 'launch', 'ship', 'workflow', 'automation', 'ai', 'compute', 'model', 'inference', 'distribution', 'brand', 'revenue', 'indie', 'creator'];
  if (wordCount <= 6 && !strongSignalKeywords.some(k => t.includes(k))) return 0.5;

  return 1.0;
}

// Signal intent classifier: helps assign a signal to the right section
// Returns: 'x_angle' | 'product_signal' | 'both' | 'neither'
function classifySignalIntent(text = '', type = '') {
  const t = text.toLowerCase();

  if (type === 'blog_post' || type === 'podcast_episode') return 'product_signal';

  // Product signal: concrete actions, tools, launches, technical signals
  const productPatterns = [
    /\b(launch|ship|release|deploy|update|build|built|building)\b/,
    /\b(product|feature|api|sdk|cli|tool|plugin|integration)\b/,
    /\b(agent|workflow|automation|pipeline|infra|stack)\b/,
    /\b(pricing|revenue|mrr|arr|monetiz|paid|subscription)\b/,
    /\b(roadmap|mvp|experiment|prototype|demo)\b/,
    /\b(claude|gpt|gemini|llm|model|inference|fine.?tun)\b/,
    /\b(github|npm|docker|vercel|aws|supabase)\b/,
    /support(s|ed|ing)?\s+\w+/,
    /now\s+(support|available|live|works)/,
  ];

  // X angle: opinion, insight, judgment, narrative — writable as a take
  const anglePatterns = [
    /\b(why|how|when|what if)\b.*\?/,
    /\b(lesson|learn|mistake|realize|notice|observe)\b/,
    /\b(opinion|think|believe|argue|feel|predict)\b/,
    /\b(unpopular|contrarian|honest|truth|real talk)\b/,
    /\b(insight|trend|shift|change|pattern|signal)\b/,
    /\b(future|next|coming|emerging)\b/,
    /\b(distribution|brand|audience|creator|personal)\b/,
    /\b(opportunity|risk|bet|warning|danger)\b/,
    /\b(huge|massive|major|critical|important)\s+\w+/,
    /there\s+is\s+a\s+(huge|big|great|massive)/,
    /\bimagine\s+if\b/,
    /\b(one.way door|tipping point|turning point)\b/,
  ];

  const isProduct = productPatterns.some(p => p.test(t));
  const isAngle = anglePatterns.some(p => p.test(t));

  // Security signals → always product (actionable)
  if (/\b(attack|vulnerability|malware|supply.chain|exploit|breach)\b/.test(t)) return 'product_signal';

  if (isProduct && isAngle) return 'both';
  if (isProduct) return 'product_signal';
  if (isAngle) return 'x_angle';

  // Fallback: short punchy tweets with no clear category → x_angle (pithy takes)
  const wordCount = t.trim().split(/\s+/).length;
  if (wordCount <= 15) return 'x_angle';

  return 'neither';
}

// Compute section-specific score based on signalIntent
// x_angle: boost writeability ×1.3, novelty ×1.2
// product_signal: boost actionability ×1.3, relevance ×1.15
// 'both' gets the higher of the two; 'neither' gets base score
function computeSectionScore(scoring, signalIntent) {
  const { relevance, writeability, actionability, novelty, engagement, recency } = scoring;
  if (signalIntent === 'x_angle') {
    return relevance * 0.35 + writeability * 1.3 * 0.18 + actionability * 0.2 + novelty * 1.2 * 0.12 + engagement * 0.10 + recency * 0.05;
  }
  if (signalIntent === 'product_signal') {
    return relevance * 1.15 * 0.35 + writeability * 0.18 + actionability * 1.3 * 0.2 + novelty * 0.12 + engagement * 0.10 + recency * 0.05;
  }
  if (signalIntent === 'both') {
    const xScore = relevance * 0.35 + writeability * 1.3 * 0.18 + actionability * 0.2 + novelty * 1.2 * 0.12 + engagement * 0.10 + recency * 0.05;
    const pScore = relevance * 1.15 * 0.35 + writeability * 0.18 + actionability * 1.3 * 0.2 + novelty * 0.12 + engagement * 0.10 + recency * 0.05;
    return Math.max(xScore, pScore);
  }
  // 'neither' — no section boost
  return relevance * 0.35 + writeability * 0.18 + actionability * 0.2 + novelty * 0.12 + engagement * 0.10 + recency * 0.05;
}

// Per-handle deduplication: if a handle has 3+ signals, keep only the top 2 by total score
function deduplicateByHandle(signals) {
  const handleMap = new Map();
  for (const signal of signals) {
    const key = (signal.handle || signal.author || '').toLowerCase();
    if (!key) continue;
    if (!handleMap.has(key)) handleMap.set(key, []);
    handleMap.get(key).push(signal);
  }

  const toRemove = new Set();
  for (const [, group] of handleMap) {
    if (group.length < 3) continue;
    // Sort descending by total score, mark all beyond top 2 for removal
    group.sort((a, b) => b.scoring.total - a.scoring.total);
    for (let i = 2; i < group.length; i++) {
      toRemove.add(group[i]);
    }
  }

  return signals.filter(s => !toRemove.has(s));
}

// ============================================================================
// Review-need detection — flag anomalies, then auto-resolve
// ============================================================================
// detectReviewNeed(): marks which signals have anomalies worth checking
// autoResolveReview(): deterministically decides keep/demote for each anomaly
//   — NO LLM involved, fully deterministic rules
// ============================================================================

function detectReviewNeed({ engagement, relevance, sourceWeight, wordCount, signalIntent, penalty, type }) {
  const reasons = [];

  // High engagement but low topic match — might be emotional/viral OR genuinely important
  if (engagement >= 0.65 && relevance <= 0.45) {
    reasons.push('HIGH_ENG_LOW_MATCH');
  }

  // Strong source but low engagement — could be early/alpha signal worth catching
  if (sourceWeight >= 1.1 && engagement <= 0.35) {
    reasons.push('HIGH_SOURCE_LOW_ENG');
  }

  // Very short text — keyword matching is unreliable
  // jike_post: title is always truncated preview; skip SHORT_TEXT check
  if (wordCount < 15 && type !== 'jike_post' && type !== 'bilibili_dynamic') {
    reasons.push('SHORT_TEXT');
  }

  // Already penalized but engagement is decent — might be a false negative
  if (penalty < 0.8 && engagement >= 0.5) {
    reasons.push('PENALIZED_BUT_ENGAGED');
  }

  return {
    needed: reasons.length > 0,
    reason: reasons.length > 0 ? reasons.join(',') : null
  };
}

// Auto-resolve needsReview signals without LLM.
// Returns: { keep: Signal[], demote: Signal[] }
// Signals in `keep` get a standardized reviewNote replacing the REVIEW_PLACEHOLDER.
// Signals in `demote` are excluded from the final report entirely.
function autoResolveReview(scoredSignals) {
  const keep = [];
  const demote = [];
  const appendix = [];

  for (const signal of scoredSignals) {
    if (!signal.needsReview) {
      keep.push(signal);
      continue;
    }

    const reasons = (signal.reviewReason || '').split(',');
    const { engagement, penalty, relevance } = signal.scoring;

    // Rule 1: SHORT_TEXT only, AND low engagement → not worth keeping
    if (reasons.length === 1 && reasons[0] === 'SHORT_TEXT' && engagement < 0.35) {
      demote.push(signal);
      continue;
    }

    // Rule 2: SHORT_TEXT only, AND hard-penalized (penalty <= 0.25) → demote
    if (reasons.every(r => r === 'SHORT_TEXT' || r === 'PENALIZED_BUT_ENGAGED')
        && penalty <= 0.25) {
      demote.push(signal);
      continue;
    }

    // Rule 3: HIGH_ENG_LOW_MATCH — high engagement overrides low keyword match → keep
    if (reasons.includes('HIGH_ENG_LOW_MATCH')) {
      signal.reviewNote = '保留理由：主题词没命中，但互动很强，先当热度信号看具体在吵什么';
      signal.needsReview = false;
      keep.push(signal);
      continue;
    }

    // Rule 4: HIGH_SOURCE_LOW_ENG — do NOT occupy top-N; park in appendix / demote score
    if (reasons.includes('HIGH_SOURCE_LOW_ENG')) {
      signal.reviewNote = '附录：关注账号但互动偏低，只观察不进正文前十';
      signal.appendixOnly = true;
      signal.needsReview = false;
      // Cap so source weight alone cannot push it into high-signal top-N
      signal.scoring.total = Number(Math.min(signal.scoring.total, 0.5).toFixed(3));
      appendix.push(signal);
      continue;
    }

    // Rule 5: PENALIZED_BUT_ENGAGED — engagement redeems it
    if (reasons.includes('PENALIZED_BUT_ENGAGED') && engagement >= 0.5) {
      signal.reviewNote = '保留理由：形式分偏低，互动还行，看有没有一句能用的结论';
      signal.needsReview = false;
      keep.push(signal);
      continue;
    }

    // Default: keep if total score is above a relaxed threshold (0.52)
    if (signal.scoring.total >= 0.52) {
      signal.reviewNote = '保留理由：分数刚过线，先存着；除非有一句硬判断，否则别急着写';
      signal.needsReview = false;
      keep.push(signal);
    } else {
      demote.push(signal);
    }
  }

  return { keep, demote, appendix };
}

function buildScoredSignals(filtered, config) {
  const keywords = config.focusTopics || [];
  const weights = config.scoring || {};
  const signals = [];

  for (const account of filtered.x || []) {
    for (const tweet of account.tweets || []) {
      // Only main posts; drop reply/comment threads. Quotes (isQuote) stay.
      if (isReplyTweet(tweet)) continue;

      const text = tweet.text || '';
      const textLower = text.toLowerCase();
      const relevance = includesAny(text, keywords) ? 1 : 0.45;
      const writeability = scoreWriteability(text);
      const actionability = includesAny(textLower, ['launch', 'ship', 'workflow', 'process', 'experiment', 'agent', 'automation']) ? 0.85 : 0.5;
      const novelty = tweet.isQuote ? 0.55 : 0.7;
      const penalty = lowSignalPenalty(text);
      const engagement = normalizeEngagement({ likes: tweet.likes, retweets: tweet.retweets, replies: tweet.replies });
      const recency = normalizeRecency(hoursAgo(tweet.createdAt));
      const baseScore = (
        relevance * weights.relevance +
        writeability * weights.writeability +
        actionability * weights.actionability +
        novelty * weights.novelty +
        engagement * weights.engagement +
        recency * weights.recency
      );
      const sourceWeight = Math.min(config.sourceWeights?.[account.handle] ?? 1, weights.sourceWeightCap ?? 1.3);
      let weightedScore = applyOutputModeBoosts(baseScore * sourceWeight * penalty, config.outputMode, { type: 'x_tweet' });
      // High-source + very low engagement: demote so source weight alone cannot take top-N
      if (sourceWeight >= 1.1 && engagement <= 0.35) {
        weightedScore = Math.min(weightedScore, 0.5);
      }
      const signalIntent = classifySignalIntent(text, 'x_tweet');

      const scoringObj = {
        relevance,
        writeability,
        actionability,
        novelty,
        engagement,
        recency,
      };
      const sectionScore = computeSectionScore(scoringObj, signalIntent) * sourceWeight * penalty;

      // ── needsReview: flag anomalies for secondary analysis ──
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const review = detectReviewNeed({
        engagement, relevance, sourceWeight, wordCount, signalIntent, penalty
      });

      const normalizedText = text.replace(/\s+/g, ' ').trim();
      const topReplies = extractTopReplies(tweet);
      signals.push({
        type: 'x_tweet',
        author: account.name,
        handle: account.handle,
        // 接近全文：标题行即正文主展示，仅极长截断
        title: clip(normalizedText, TITLE_BODY_MAX),
        summary: clip(normalizedText, BODY_TEXT_MAX),
        fullText: normalizedText,
        topReplies,
        url: tweet.url,
        publishedAt: tweet.createdAt,
        isQuote: !!tweet.isQuote,
        isReply: false,
        signalIntent,
        metrics: {
          likes: tweet.likes || 0,
          retweets: tweet.retweets || 0,
          replies: tweet.replies || 0
        },
        explainability: {
          sourceReason: getSourceReason(account.handle, config),
          modeEffect: config.outputMode === 'x_draft' ? '当前模式偏向可写性更高的内容' : config.outputMode === 'signal_only' ? '当前模式偏向高信号判断' : '当前模式为平衡输出',
          lowSignalPenalty: penalty < 1 ? `低信号惩罚 ×${penalty}` : null
        },
        needsReview: review.needed,
        reviewReason: review.reason,
        scoring: {
          relevance,
          writeability,
          actionability,
          novelty,
          engagement,
          recency,
          base: Number(baseScore.toFixed(3)),
          sourceWeight,
          penalty,
          total: Number(weightedScore.toFixed(3)),
          sectionScore: Number(sectionScore.toFixed(3))
        }
      });
    }
  }

  // 即刻动态
  for (const signal of filtered.x || []) {
    if (signal.type !== 'jike_post' && signal.type !== 'bilibili_dynamic') continue;
    // jike title is a truncated preview (e.g. "发布了: ..."); strip prefix and fall back to title when summary is empty
    const jikeContent = signal.summary || signal.title.replace(/^(发布了|转发了):\s*/, '');
    const text = `${signal.title} ${jikeContent}`.trim();
    const relevance = includesAny(text, keywords) ? 1 : 0.45;
    const writeability = scoreWriteability(text);
    const actionability = includesAny(text.toLowerCase(), ['launch', 'ship', 'workflow', 'process', 'experiment', 'agent', 'automation']) ? 0.85 : 0.5;
    const novelty = 0.7;
    const engagement = 0.3;
    const recency = normalizeRecency(hoursAgo(signal.publishedAt));
    const penalty = lowSignalPenalty(text);
    const baseScore = (
      relevance * weights.relevance +
      writeability * weights.writeability +
      actionability * weights.actionability +
      novelty * weights.novelty +
      engagement * weights.engagement +
      recency * weights.recency
    );
    const sourceWeight = 1.05;
    const weightedScore = applyOutputModeBoosts(baseScore * sourceWeight * penalty, config.outputMode, { type: 'jike_post' });
    const signalIntent = classifySignalIntent(text, 'jike_post');

    const scoringObj = { relevance, writeability, actionability, novelty, engagement, recency };
    const sectionScore = computeSectionScore(scoringObj, signalIntent) * sourceWeight * penalty;

    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const review = detectReviewNeed({
      engagement, relevance, sourceWeight, wordCount, signalIntent, penalty, type: 'jike_post'
    });

    signals.push({
      type: 'jike_post',
      author: signal.name,
      handle: signal.handle,
      title: signal.title,
      summary: signal.summary,
      fullText: String(jikeContent || signal.summary || signal.title || '').replace(/\s+/g, ' ').trim(),
      url: signal.url,
      publishedAt: signal.publishedAt,
      signalIntent,
      metrics: signal.metrics || { likes: 0, retweets: 0, replies: 0 },
      explainability: {
        sourceReason: `即刻账号 ${signal.name}`,
        modeEffect: config.outputMode === 'x_draft' ? '当前模式偏向可写性更高的内容' : '按默认模式处理',
        lowSignalPenalty: penalty < 1 ? `低信号惩罚 ×${penalty}` : null
      },
      needsReview: review.needed,
      reviewReason: review.reason,
      scoring: {
        relevance,
        writeability,
        actionability,
        novelty,
        engagement,
        recency,
        base: Number(baseScore.toFixed(3)),
        sourceWeight,
        penalty,
        total: Number(weightedScore.toFixed(3)),
        sectionScore: Number(sectionScore.toFixed(3))
      }
    });
  }

  for (const blog of filtered.blogs || []) {
    const text = `${blog.title || ''} ${blog.description || ''} ${clip(blog.content || '', 500)}`;
    const topicHits = matchedKeywords(text, keywords);
    const hasTopicHit = topicHits.length > 0;
    const relevance = hasTopicHit ? 1 : 0.34;
    const writeability = hasTopicHit ? 0.65 : 0.52;
    const actionability = includesAny(text, ['agent', 'workflow', 'API', 'product']) ? 0.8 : 0.5;
    const novelty = 0.72;
    const engagement = 0.2;
    const recency = normalizeRecency(hoursAgo(blog.publishedAt));
    const baseScore = (
      relevance * weights.relevance +
      writeability * weights.writeability +
      actionability * weights.actionability +
      novelty * weights.novelty +
      engagement * weights.engagement +
      recency * weights.recency
    );
    const sourceWeight = getSourceWeight({ type: 'blog_post' }, config);
    const weightedScore = applyOutputModeBoosts(baseScore * sourceWeight, config.outputMode, { type: 'blog_post' });

    const blogScoringObj = { relevance, writeability, actionability, novelty, engagement, recency };
    const blogSectionScore = computeSectionScore(blogScoringObj, 'product_signal') * sourceWeight;

    signals.push({
      type: 'blog_post',
      author: blog.name,
      title: blog.title,
      summary: clip(blog.description || blog.content || '', BODY_TEXT_MAX),
      fullText: clip(blog.description || blog.content || '', BODY_TEXT_MAX),
      url: blog.url,
      publishedAt: blog.publishedAt,
      signalIntent: 'product_signal',
      explainability: {
        sourceReason: '博客源当前未单独加权,按内容信号本身排序',
        topicGate: hasTopicHit ? `命中 focus topic: ${topicHits.slice(0, 5).join(', ')}` : '未命中 focus topic, 降低 relevance 以过滤泛博客噪音',
        modeEffect: config.outputMode === 'signal_only' ? 'signal_only 对深度内容略有加权' : '按默认模式处理'
      },
      scoring: {
        relevance,
        writeability,
        actionability,
        novelty,
        engagement,
        recency,
        base: Number(baseScore.toFixed(3)),
        sourceWeight,
        total: Number(weightedScore.toFixed(3)),
        sectionScore: Number(blogSectionScore.toFixed(3))
      }
    });
  }

  for (const podcast of filtered.podcasts || []) {
    const text = `${podcast.title || ''} ${clip(podcast.transcript || '', 500)}`;
    const relevance = includesAny(text, keywords) ? 1 : 0.5;
    const writeability = 0.7;
    const actionability = includesAny(text, ['agent', 'product', 'workflow', 'creator']) ? 0.8 : 0.5;
    const novelty = 0.68;
    const engagement = 0.2;
    const recency = normalizeRecency(hoursAgo(podcast.publishedAt));
    const baseScore = (
      relevance * weights.relevance +
      writeability * weights.writeability +
      actionability * weights.actionability +
      novelty * weights.novelty +
      engagement * weights.engagement +
      recency * weights.recency
    );
    const sourceWeight = getSourceWeight({ type: 'podcast_episode' }, config);
    const weightedScore = applyOutputModeBoosts(baseScore * sourceWeight, config.outputMode, { type: 'podcast_episode' });

    const podScoringObj = { relevance, writeability, actionability, novelty, engagement, recency };
    const podSectionScore = computeSectionScore(podScoringObj, 'product_signal') * sourceWeight;

    signals.push({
      type: 'podcast_episode',
      author: podcast.name,
      title: podcast.title,
      summary: clip(podcast.transcript || '', BODY_TEXT_MAX),
      fullText: clip(podcast.transcript || '', BODY_TEXT_MAX),
      url: podcast.url,
      publishedAt: podcast.publishedAt,
      signalIntent: 'product_signal',
      explainability: {
        sourceReason: '播客源当前未单独加权,按内容信号本身排序',
        modeEffect: config.outputMode === 'signal_only' ? 'signal_only 对深度内容略有加权' : '按默认模式处理'
      },
      scoring: {
        relevance,
        writeability,
        actionability,
        novelty,
        engagement,
        recency,
        base: Number(baseScore.toFixed(3)),
        sourceWeight,
        total: Number(weightedScore.toFixed(3)),
        sectionScore: Number(podSectionScore.toFixed(3))
      }
    });
  }

  // Per-handle dedup: if 3+ signals from same handle, keep only top 2
  const deduped = deduplicateByHandle(signals);

  return deduped.sort((a, b) => b.scoring.total - a.scoring.total);
}

// -- Seen-signals deduplication (cross-day) ----------------------------------
async function loadSeenSignals() {
  if (!existsSync(SEEN_SIGNALS_PATH)) return {};
  try {
    const raw = await readFile(SEEN_SIGNALS_PATH, 'utf8');
    const seenMap = JSON.parse(raw);
    // Natural-day TTL: only today's seen URLs suppress today's run. This avoids
    // a rolling 24h window blocking yesterday-afternoon high signals from the
    // next daily digest.
    const todayStart = shanghaiDayStartMs();
    return Object.fromEntries(
      Object.entries(seenMap).filter(([, ts]) => Number(ts) >= todayStart)
    );
  } catch {
    return {};
  }
}

function getTodayStartMs() {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  return new Date(todayStr + 'T00:00:00+08:00').getTime();
}

async function saveSeenSignals(seenMap, newUrls) {
  // Natural-day TTL: only keep entries from today in Asia/Shanghai.
  const todayStart = shanghaiDayStartMs();
  const pruned = Object.fromEntries(
    Object.entries(seenMap).filter(([, ts]) => Number(ts) >= todayStart)
  );
  // Add new
  const now = Date.now();
  for (const url of newUrls) {
    if (url) pruned[url] = now;
  }
  await writeFile(SEEN_SIGNALS_PATH, JSON.stringify(pruned, null, 2), 'utf8');
}

// Seen fallback: recover high-score seen signals when today is too sparse
function recoverSeenSignals(scoredSignals, seenMap, minimum) {
  const fallbackThreshold = Math.max(0.62, minimum + 0.08);
  const recovered = [];
  const seenUrls = new Set(Object.keys(seenMap));
  for (const signal of scoredSignals) {
    if (!signal.url || !seenUrls.has(signal.url)) continue;
    if (signal.scoring.total >= fallbackThreshold) {
      recovered.push({
        ...signal,
        repeatObservation: true,
        reviewNote: `🔄 seen fallback: 高分内容(${signal.scoring.total.toFixed(2)})昨天已阅，今天信号不足时补回`
      });
    }
  }
  // Sort by total score desc, keep top
  recovered.sort((a, b) => b.scoring.total - a.scoring.total);
  return recovered;
}

function filterSeenSignals(scoredSignals, seenMap) {
  const unseen = scoredSignals.filter(s => !s.url || !seenMap[s.url]);
  const skipped = scoredSignals.length - unseen.length;
  if (skipped > 0) {
    process.stderr.write(`[seen-signals] Filtered ${skipped} already-seen signal(s)\n`);
  }
  return unseen;
}

function buildDraftCandidates(scoredSignals, config) {
  // x_drafts section removed — return empty
  return [];
}

function buildModeViews(scoredSignals, config) {
  const highSignals = scoredSignals.filter(signal => signal.scoring.total >= config.scoring.minimum);
  return {
    signal_only: highSignals.slice(0, Math.max(config.limits.brief, 3)).map(signal => ({
      type: signal.type,
      title: signal.title,
      author: signal.author,
      score: signal.scoring.total,
      whyItMatters: `它不是普通更新,因为它直接指向 ${config.focusTopics.slice(0, 2).join(' / ')} 的判断变化。`,
      sourceUrl: signal.url
    }))
    // x_draft view removed
  };
}

function recoverFallbackSignals(rawSignals, currentSignals, seenMap, config, minCount = 5) {
  const currentUrls = new Set((currentSignals || []).map(s => s.url).filter(Boolean));
  const seenUrls = new Set(Object.keys(seenMap || {}));
  const highSignalCount = (currentSignals || [])
    .filter(s => s.scoring.total >= config.scoring.minimum).length;
  if (highSignalCount >= minCount) return { signals: currentSignals, recovered: [] };

  const recoveryFloor = Math.max(0.62, config.scoring.minimum + 0.08);
  // A fallback is context, never a substitute for the day's new signals.
  // Keep exactly one best candidate even when the gap to minCount is larger.
  const recovered = (rawSignals || [])
    .filter(s => s.url && seenUrls.has(s.url) && !currentUrls.has(s.url))
    .filter(s => s.scoring?.total >= recoveryFloor)
    .sort((a, b) => (b.scoring.total || 0) - (a.scoring.total || 0))
    .slice(0, 1)
    .map(s => ({
      ...s,
      repeatObservation: true,
      reviewNote: [s.reviewNote, '今日新增高信号不足，补充 1 条历史高分观察（重复观察）'].filter(Boolean).join('；'),
      explainability: {
        ...(s.explainability || {}),
        seenFallback: `今日新增高信号不足，补充 1 条历史高分观察；恢复门槛 ${recoveryFloor.toFixed(2)}`
      }
    }));

  return {
    signals: [...(currentSignals || []), ...recovered]
      .sort((a, b) => (b.scoring?.total || 0) - (a.scoring?.total || 0)),
    recovered
  };
}

function buildSourceWeightSummary(config) {
  return Object.entries(config.sourceWeights || {})
    .sort((a, b) => b[1] - a[1])
    .map(([handle, weight]) => ({
      handle,
      weight,
      reason: config.sourceWeightReasons?.[handle] || null
    }));
}

function countSignalsByType(signals = []) {
  return signals.reduce((acc, signal) => {
    const key = signal.type || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildHealthSummary(output) {
  const rawCounts = output.stats?.rawCounts || {};
  const postSeenCounts = output.stats?.postSeenCounts || {};
  const highSignalCounts = output.stats?.highSignalCounts || {};
  const demotedCounts = output.stats?.demotedCounts || {};
  const seenFilteredCounts = output.stats?.seenFilteredCounts || {};

  const rows = [
    { label: 'X', type: 'x_tweet' },
    { label: '即刻', type: 'jike_post' },
    { label: 'Blogs', type: 'blog_post' },
    { label: 'Podcasts', type: 'podcast_episode' }
  ];

  return rows.map(({ label, type }) => {
    const raw = rawCounts[type] || 0;
    const postSeen = postSeenCounts[type] || 0;
    const high = highSignalCounts[type] || 0;
    const seenFiltered = seenFilteredCounts[type] || 0;
    const demoted = demotedCounts[type] || 0;
    const meta = [];
    if (seenFiltered > 0) meta.push(`seen -${seenFiltered}`);
    if (demoted > 0) meta.push(`demoted -${demoted}`);
    const suffix = meta.length > 0 ? ` (${meta.join(', ')})` : '';
    return `- ${label}: ${raw} raw / ${postSeen} post-seen / ${high} high-signal${suffix}`;
  });
}

function renderMarkdown(output) {
  return renderRadar(output);
}

// ============================================================================
// Radar Renderer v2 — editorial daily radar, not debug panel
// ============================================================================

function renderRadar(output) {
  // ── Data ──
  const allSignals = output.scoredSignals || [];
  const topSignals = allSignals.filter(s => s.scoring.total >= output.config.scoring.minimum && !s.appendixOnly);
  const totalTweets = output.stats?.totalTweets || 0;
  // xDrafts removed — section no longer used
  const lowSignalCount = allSignals.filter(s =>
    s.scoring.penalty !== undefined && s.scoring.penalty < 1 && s.scoring.total < output.config.scoring.minimum
  ).length;

  // ── Topic helpers ──
  const extractTopic = (text = '') => {
    const t = text.toLowerCase();
    if (/supply.chain|npm|axios|malware|attack|security|vulnerab/.test(t)) return 'security';
    if (/context.window|memory|token.limit|long.context/.test(t)) return 'context';
    if (/agent(?:s)?/.test(t)) return 'agent';
    if (/lark|enterprise|github enterprise|teams|slack/.test(t)) return 'enterprise_workflow';
    if (/claude code|codex|cursor|copilot|coding agent/.test(t)) return 'coding_agent';
    if (/brand|audience|creator|newsletter|content/.test(t)) return 'creator';
    if (/revenue|mrr|arr|pricing|monetiz/.test(t)) return 'revenue';
    if (/indie|solopreneur|bootstrapped|side.project/.test(t)) return 'indie';
    if (/distribution|growth|viral|reach|impression/.test(t)) return 'distribution';
    if (/model|llm|inference|training|fine.?tun/.test(t)) return 'model';
    if (/product|launch|ship|release|feature|roadmap/.test(t)) return 'product';
    if (/workflow|automation|tool|stack|infra/.test(t)) return 'workflow';
    return 'general';
  };

  const topicLabel = {
    security: '🔒 安全',
    context: '🧠 上下文',
    agent: '🤖 Agent',
    enterprise_workflow: '🏢 企业工作流',
    coding_agent: '💻 编码 Agent',
    creator: '✍️ 创作者',
    revenue: '💰 营收',
    indie: '🧑‍💻 独立开发',
    distribution: '📣 分发',
    model: '🧬 模型',
    product: '📦 产品',
    workflow: '⚙️ 工作流',
    general: '📌 综合',
  };

  // ── 分区列表（知情 X / 成稿非 X）；挑选在 signalNote 就绪后执行 ──
  let signalItems = [];
  let infoItems = [];
  let draftItems = [];
  let demotedForNote = [];

  // ── buildLead(): dynamic editorial judgment ──
  const buildLead = () => {
    if (signalItems.length === 0) return '今天没有足够强的高信号内容，宁缺毋滥。';

    // Count topic distribution
    const topicCounts = {};
    for (const item of signalItems) {
      const topic = extractTopic((item.title || '') + ' ' + (item.summary || ''));
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    }
    const sorted = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]);
    const dominant = sorted[0];
    const secondary = sorted[1];
    const topItem = signalItems[0];
    const topAuthor = topItem.handle ? `@${topItem.handle}` : topItem.author || '头部信号源';

    const leadTemplates = {
      security: `今天的信号集中在**安全**方向——${topAuthor} 的内容引出了供应链信任这个绕不开的话题。${secondary ? `同时 ${topicLabel[secondary[0]] || secondary[0]} 方向也有 ${secondary[1]} 条值得留意。` : ''}安全信号的特点是：一旦出现，不是"可以关注"，是"必须检查"。`,
      context: `上下文管理成了今天的主旋律。${topAuthor} 指出的问题本质上不是模型不够强，而是人和工具之间的信息带宽还没跟上。${secondary ? `另外 ${topicLabel[secondary[0]] || secondary[0]} 也冒出了 ${secondary[1]} 条信号。` : ''}`,
      agent: `Agent 话题今天密度最高，${topAuthor} 的观点值得展开——评价 agent 的框架正在从"能做什么"转向"能不能持续超出预期"。${secondary ? `${topicLabel[secondary[0]] || secondary[0]} 方向也有 ${secondary[1]} 条相关信号。` : ''}这个方向还在加速，连续两天出现同类信号就值得写成帖子。`,
      enterprise_workflow: `企业工作流方向今天有明确信号。${topAuthor} 的动态说明 AI 工具正在从"可选增强"变成"默认基础设施"。${secondary ? `同时 ${topicLabel[secondary[0]] || secondary[0]} 也值得留意。` : ''}这个市场慢但粘性高。`,
      coding_agent: `编码 agent 今天是主角。${topAuthor} 的内容指向一个正在发生的事实：工程师的核心技能正在从"写代码"转向"审查和决策"。${secondary ? `此外 ${topicLabel[secondary[0]] || secondary[0]} 也有 ${secondary[1]} 条信号。` : ''}`,
      creator: `创作者经济的信号今天最密。${topAuthor} 说的本质上是：发布频率不再是护城河，判断密度才是。${secondary ? `${topicLabel[secondary[0]] || secondary[0]} 同样有 ${secondary[1]} 条信号值得看。` : ''}`,
      distribution: `分发逻辑的信号今天冒出来了。${topAuthor} 的内容暗示触达本身正在成为稀缺资源——比产品能力更难复制。${secondary ? `${topicLabel[secondary[0]] || secondary[0]} 也有 ${secondary[1]} 条。` : ''}`,
      model: `模型层面今天有新动向。${topAuthor} 的信号指向能力拉平的窗口在压缩，留给产品差异化的时间正在变少。${secondary ? `另外 ${topicLabel[secondary[0]] || secondary[0]} 方向也有信号值得注意。` : ''}`,
    };

    const dominantTopic = dominant[0];
    if (leadTemplates[dominantTopic]) return leadTemplates[dominantTopic];

    // Fallback: generic but still data-driven
    const topTopics = sorted.slice(0, 3).map(([t, c]) => `${topicLabel[t] || t}(${c}条)`).join('、');
    return `今天的信号分布在 ${topTopics}。${topAuthor} 贡献了最强的一条——不是新闻价值高，而是它暴露了判断框架的变化。${signalItems.length >= 5 ? '信号密度不错，值得花时间过一遍。' : '信号不多但质量可以。'}`;
  };

  // ── signalNote(item): 1-2 sentence editorial comment ──
  const isGithubRepoSignal = (item) => {
    const url = item.url || '';
    const sourceName = (item.author || item.name || item.source || '').toLowerCase();
    return /github\.com\/[^/\s?#]+\/[^/\s?#]+\/?(?:[?#].*)?$/.test(url) || sourceName.includes('github trending');
  };

  // Editorial note: 正文评价只保留一句人话，固定前缀「扩帖切口：…」
  // 必须点名读者能写成帖的具体角度；写不出 → null 降级移出正文前十。
  const usedSignalNotes = new Set();

  const asAngleNote = (angle) => {
    if (!angle) return null;
    let a = String(angle).trim()
      .replace(/^扩帖切口：\s*/, '')
      .replace(/^\[.*?\]\s*/, '')
      .replace(/^看点：\s*/, '')
      .replace(/^值得看：\s*/, '')
      .replace(/\s*→\s*可写性高.*$/, '')
      .trim();
    if (!a || a.length < 6) return null;
    if (/能否扩成帖|别停在 Agent|值得看：这条多出来|不要和同题空话合并|^看点：|抽一条可复用判断框架|不搬运目录/.test(a)) return null;
    const note = `扩帖切口：${clip(a, 72)}`;
    return note;
  };

  /**
   * Blog/newsletter angles must come from the body: a product action, a number,
   * or a contrarian claim. Title-only "抽框架" lines are not an angle.
   */
  const blogConcreteAngles = (item) => {
    const title = stripHtmlForDisplay(item.title || '').replace(/\s+/g, ' ').trim();
    let body = stripHtmlForDisplay(item.fullText || item.summary || item.description || item.content || '')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (title && body.startsWith(title)) {
      body = body.slice(title.length).replace(/^[\s:：\-—|]+/, '').trim();
    }
    if (body.length < 24) return [];
    const numberRe = /\d+(?:\.\d+)?\s*%|\$\s?\d|\b\d+(?:\.\d+)?\s*(?:x|×|倍)\b|\d+\s*(?:万|亿|小时|分钟|天|美元|元|家)|\b\d{1,3}(?:,\d{3})+\b/i;
    const contrarianRe = /不是.{0,24}而是|其实|反而|反常识|反直觉|别再|不要只|不应该|unlike|however|\bstill\b|actually|most people|overestimat|underestimat|rather than|\bI still\b|\bbut I\b/i;
    const actionRe = /发布|上线|推出|支持|新增|下线|定价|涨价|降价|免费|订阅|换成|替代|开放|shipp?ed|launch(?:ed)?|priced|pricing|now supports|\badds\b|\badded\b|replaces|free tier|\bbeta\b/i;
    return body
      .split(/(?<=[。！？.!?])\s*/)
      .map((s) => s.trim().replace(/^["“]+|["”]+$/g, ''))
      .filter((s) => s.length >= 18 && !/抽一条可复用判断框架|不搬运目录/.test(s))
      .map((s) => {
        let score = 0;
        if (numberRe.test(s)) score += 4;
        if (contrarianRe.test(s)) score += 3;
        if (actionRe.test(s)) score += 3;
        if (title && s.startsWith(title.slice(0, 24))) score -= 2;
        return { s, score };
      })
      .filter((row) => row.score >= 3)
      .sort((a, b) => b.score - a.score)
      .map((row) => clip(row.s, 64));
  };

  const takeBlogAngle = (item) => {
    for (const angle of blogConcreteAngles(item)) {
      const note = asAngleNote(angle);
      if (!note || usedSignalNotes.has(note)) continue;
      return note;
    }
    return null;
  };

  /** 从作者原文抽硬判断/具体动作，再压成可写切口；没有则 null */
  const pickAuthorClaim = (raw = '') => {
    const cleaned = stripHtmlForDisplay(raw)
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return null;
    const parts = cleaned
      .split(/(?<=[。！？.!?])/)
      .map((s) => s.trim().replace(/^@\w+\s+/, ''))
      .filter((s) => s.length >= 12);
    const hardRe = /不应该|不该|应该|意味着|关键是|关键在|本质|核心|其实|不是.{0,16}而是|与其|不如|别只|不要|立刻|具体|换成|替代|判断|结论|工作流|所以我想|终于把|做完|overestimate|underestimate|develop a system/;
    const hard = parts.find((s) => hardRe.test(s));
    if (hard) {
      // 压成切口：去掉纯开场套话；纠正型碎碎念不够成切口则丢弃
      let claim = hard.replace(/^(Great interview\.?\s*)/i, '').trim();
      if (claim.length < 10) claim = hard;
      if (/^(记错了|更正|补充一下|其实我想说)/.test(claim) && claim.length < 40) return null;
      if (/^(RT\b|发布了)/i.test(claim)) return null;
      return clip(claim, 56);
    }
    return null; // 不再用「首句截断」充评价
  };

  /** 返回不含前缀的具体扩帖角度；写不出返回 null */
  const whyWorthReading = (rawText, item = {}) => {
    const t = stripHtmlForDisplay(rawText || '');
    const lower = t.toLowerCase();
    const handle = String(item.handle || item.author || '').toLowerCase();

    // 具名高信号切口（示例口径）
    if (/huge launch|one huge launch|showing up every day|make a video every day|大发布|每天.{0,6}(露脸|出现|发)/.test(lower)
        || (handle.includes('zarazhangrui') && /launch|timeline|every day/.test(lower))) {
      return '别押大发布、押每天露脸的内容系统';
    }
    if (/可视化|自动化流水线|自动化管理|定时任务|自动化任务/.test(t)
        || (handle.includes('khazix') && /agent|流水线|管理界面/.test(lower))) {
      return '游戏化/可视化管理界面：把散落的 Agent 定时任务收成一张可操作看板';
    }
    if (/约束语言|语言大师/.test(t)) {
      return 'Agent 产品本质是约束语言——下一波赢家更像语言大师而不是功能清单党';
    }
    if (/yobiru friends|personal agent.{0,40}(分享|朋友|亲朋)|对外发布或分享/.test(lower) || /personal agent.{0,30}(share|friend)/.test(lower)) {
      return 'personal agent 对外分享/互聊/协商日程：把私人助手做成可分发关系网';
    }
    if (/sent from ai agent|sent from iphone/.test(lower)) {
      return '「Sent from AI agent」会不会变成新签名文化——工具痕迹本身成身份信号';
    }
    if (/小龙虾|科幻片成真|私人助理/.test(t) && /coding agent|claude|沉迷/.test(lower + t)) {
      return '老板第一次用 Coding Agent 的科幻感 vs 天天用的人的平淡——门槛下降后的沉浸落差';
    }
    if (/earliest|early.?stage|前\s*100|早期/.test(lower) && /audience|用户|builder|验证|测想法/.test(lower)) {
      return '早期优势是用受众测想法/找种子用户，不是分发本身';
    }
    if (/security audit|unattended upgrades|disconnect|断开|\bvps\b|take them down|下线|停机/.test(lower)) {
      return '安全事件下的自保清单：全站审计 + unattended upgrades，可复用成操作帖';
    }
    if (/供应链|\bnpm\b|postinstall|依赖投毒/.test(lower)) {
      return '供应链/依赖投毒：锁版本、审 postinstall、扫来源——写成检查清单帖';
    }
    if (/\bphp\b/.test(lower) && (/end of php|不看好|\bvibe\b|ai-assisted/.test(lower))) {
      return 'AI vibe coding 语境下旧栈（PHP）还有没有生存切口——技术选型争论帖';
    }
    if (/planning|规划/.test(lower) && /coding|编码|workflow|工作流/.test(lower)) {
      return '规划模型 vs 编码模型的分工工作流，可当 Agent 编排对照案例';
    }
    if (/drop-?in|replacement|faster|替代|更快/.test(lower) && /tsrs|tool|runtime|运行/.test(lower)) {
      return '具体工具替换+量级收益：写成「换栈/换工具」短案例，别和 Agent 空话混写';
    }
    if (/proactive|off your plate|主动|替你/.test(lower) && /claude|\bagent\b|助手/.test(lower)) {
      return '产品叙事从「能做什么」转向「主动替你扛事」——对照自己的 Agent 定位';
    }
    if (/两极|分化|极化/.test(t) && /agent|Agent/.test(t)) {
      return 'Agent 技术终点 vs 产品终点两极化，拆成对照帖';
    }
    if (/kindle|刷机|koreader|电子书/.test(lower) && /ai|rss|开源/.test(lower)) {
      return 'Kindle 刷机 + AI RSS 的硬件改造开源切口';
    }
    if (/忍住|不更新|不拍|系列/.test(t) && /恶搞|anthropic|达里奥|视频/.test(lower + t)) {
      return '忍住不拍系列恶搞的内容取舍——什么题材该停、什么判断该留';
    }
    if (/thariq|boris/.test(lower) && /claude code|skill|agent sdk|离职|负责人|社区/.test(lower + t)) {
      return '分清 Thariq（社区/Skill 教学）与 Boris（Claude Code 产品线）——别把人事信号误读成产品停摆';
    }

    // 兜底：作者硬判断压成切口；写不出返回 null → 降级
    const claim = pickAuthorClaim(t);
    if (claim && claim.length >= 10) return claim;
    return null;
  };

  /** 撞车后换一条具体切口；仍写不出则 null */
  const uniqueConcreteNote = (item) => {
    const text = stripHtmlForDisplay(item.fullText || item.summary || item.title || '')
      .replace(/\s+/g, ' ')
      .trim();
    const angles = [];
    const why = whyWorthReading(text, item);
    if (why) angles.push(why);
    const claim = pickAuthorClaim(text);
    if (claim) angles.push(claim);
    if (item.type === 'blog_post' || item.type === 'podcast_episode') {
      angles.push(...blogConcreteAngles(item));
    }
    if (isGithubRepoSignal(item) && item.title) {
      angles.push(`开源上榜「${clip(item.title, 28)}」：看需求方向与 demake 点，别当长文读`);
    }
    for (const a of angles) {
      const note = asAngleNote(a);
      if (note && !usedSignalNotes.has(note)) return note;
    }
    return null;
  };

  // 返回「扩帖切口：…」；写不出具体角度 → null 降级不进正文
  const signalNote = (item) => {
    // 即刻不进正文两区（双保险；成稿类型已剔除）
    if (item.type === 'jike_post') return null;

    const text = stripHtmlForDisplay((item.fullText || item.title || '') + ' ' + (item.summary || ''));
    let note = null;

    if (isGithubRepoSignal(item)) {
      note = asAngleNote(
        item.title
          ? `开源上榜「${clip(item.title, 28)}」：看需求方向与 demake 点，别当长文读`
          : '开源上榜：看需求方向与 demake 点，别当长文读'
      );
    } else if (item.type === 'blog_post' || item.type === 'podcast_episode') {
      // Body action / number / contrarian line only. No title-template filler.
      note = takeBlogAngle(item);
      if (!note) return null;
      usedSignalNotes.add(note);
      return note;
    } else {
      const why = whyWorthReading(text, item);
      note = asAngleNote(why);
    }

    if (!note || usedSignalNotes.has(note)) {
      note = uniqueConcreteNote(item);
    }
    if (!note) return null;
    usedSignalNotes.add(note);
    return note;
  };

  const bodyEditorialNote = (item) => {
    // 正文只收「扩帖切口：…」；旧腔/万能备注一律走 signalNote 重写或降级
    if (item.reviewNote && !isGenericReviewNote(item.reviewNote)) {
      let note = item.reviewNote.trim();
      if (!/^扩帖切口：/.test(note)) note = asAngleNote(note);
      if (note && !usedSignalNotes.has(note)) {
        usedSignalNotes.add(note);
        return note;
      }
    }
    return signalNote(item);
  };

  // ── 正文分区挑选：知情（X）与成稿原料（非 X）分开；成稿绝不拿 X 充数 ──
  const pickWithNotes = (candidates, cap) => {
    const picked = [];
    for (const item of candidates) {
      if (picked.length >= cap) break;
      const note = bodyEditorialNote(item);
      if (!note) {
        demotedForNote.push(item);
        continue;
      }
      item._bodyNote = note;
      picked.push(item);
    }
    return picked;
  };

  const xCandidates = topSignals.filter(isXSignal); // 知情仅 X
  const draftCandidatesPool = topSignals.filter((s) => isDraftMaterial(s) && s.type !== 'jike_post');
  // 成稿区：只留 blog/podcast 等；不与 X 混排、不用即刻/X 补位
  infoItems = pickWithNotes(xCandidates, INFO_SECTION_CAP);
  draftItems = pickWithNotes(draftCandidatesPool, DRAFT_SECTION_CAP);
  signalItems = [...infoItems, ...draftItems];

  // ── engagementBadge(item) ──
  const fmtK = (n) => {
    if (!n || n <= 0) return '';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  };
  const engagementBadge = (item) => {
    const m = item.metrics || {};
    const parts = [];
    if (m.likes > 0) parts.push(`♥ ${fmtK(m.likes)}`);
    if (m.retweets > 0) parts.push(`🔁 ${fmtK(m.retweets)}`);
    if (m.replies > 0) parts.push(`💬 ${fmtK(m.replies)}`);
    return parts.length > 0 ? parts.join(' · ') : '';
  };

  // ── sourceTag(item) ──
  const sourceTag = (item) => {
    if (item.handle) {
      const url = item.url || `https://x.com/${item.handle}`;
      return `[@${item.handle}](${url})`;
    }
    if (item.author) return item.author;
    const typeEmoji = { x_tweet: '🐦', blog_post: '📝', podcast_episode: '🎙️', jike_post: '🟡', bilibili_dynamic: '📺' };
    return typeEmoji[item.type] || '📌';
  };

  // ── makeDraftText(draft): concise, varied templates ──
  const makeDraftText = (draft) => {
    const text = (draft.title || '') + ' ' + (draft.summary || '');
    const topic = extractTopic(text);
    const url = draft.sourceUrl;
    const author = draft.author ? `@${draft.author}` : '';

    const templates = {
      security: `你用 npm install 那一刻，信任的不是自己的代码，是整条供应链。\n\n${author ? author + ' 暴露的问题' : '最近的案例'}说明：攻击者不需要攻破你，只需要攻破你信任的依赖。\n\n三件事现在就值得做：锁版本、审 postinstall、定期扫依赖来源。\n\n${url}`,

      agent: `评价 agent 产品的标准变了。\n\n不看功能清单了——看一件事：它有没有做出过你没预料到的结果。\n\n${author ? author + ' 的判断' : '这个观点'}指向一个更大的变化：产品评价从"完整性"转向"惊喜密度"。做内容也一样——读者记住的是超出预期的判断，不是信息搬运。\n\n${url}`,

      enterprise_workflow: `AI 工具进企业的信号越来越明确了。\n\n不是 API 层面的接入，是直接替换内部工具链。采购逻辑从"安不安全"转向"能不能替代现有方案"。\n\n这个市场比 to-C 慢，但一旦卡位，切换成本极高。${author ? ` ${author} 的动态值得持续追。` : ''}\n\n${url}`,

      coding_agent: `工程师的工作边界已经移动了。\n\n核心稀缺能力从"写"变成"判断"——定义问题、审查输出、决策采纳。${author ? ` ${author} 说得直接` : '信号很明确'}，这个变化比大多数人意识到的快。\n\n${url}`,

      context: `模型够用了，瓶颈转到了上下文管理。\n\n不是 AI 能力不够，是人给的上下文质量跟不上。这会直接改变产品设计的优先级——谁能帮用户更好地组织输入，谁就有产品优势。\n\n${url}`,

      creator: `创作者的护城河正在迁移。\n\n从发布频率到判断密度，从覆盖面到观点锐度。${author ? `${author} 的实践` : '这个方向'}值得深挖——内容竞争的维度在变。\n\n${url}`,

      distribution: `分发能力比产品能力更难复制。\n\n${author ? `${author} 的观点` : '这条信号'}戳到了一个被低估的事实：触达本身正在成为最稀缺的资源。\n\n${url}`,

      revenue: `定价比功能复杂度更关键——这是独立产品从 0 到 MRR 路上最容易搞错的环节。\n\n${author ? `${author} 的经验` : '这条信号'}值得对照自己的项目想一遍。\n\n${url}`,

      indie: `小团队的最大优势：不需要开会就能改方向。\n\n${author ? `${author} 的做法` : '这条信号'}可以直接映射到自己的项目决策。\n\n${url}`,

      model: `模型能力拉平的速度在加快，留给产品差异化的窗口正在变窄。\n\n这不是"关注一下"的事——是"现在就得想清楚自己的差异化到底靠什么"。\n\n${url}`,

      product: `产品好坏越来越不取决于功能多少，而取决于判断对不对。\n\n${author ? `${author} 的信号` : '这条内容'}暴露了一个转折点——值得停下来想一遍。\n\n${url}`,

      workflow: `Workflow 自动化每推进一步，就有一类人的工作方式要被重新定义。\n\n${author ? `${author} 的分享` : '这条信号'}指向一个正在发生的边界移动。\n\n${url}`,
    };

    return templates[topic] || `${draft.suggestedOpening || '今天有一条值得深想的信号。'}\n\n${draft.angle || '它不是新闻，而是底层判断框架在移动。'}\n\n${url}`;
  };

  // ── buildActions(): dynamic next steps ──
  const buildActions = () => {
    const actions = [];

    // 1. Most writable signal → recommend writing a post
    const mostWritable = signalItems.find(s =>
      s.scoring.writeability >= 0.8
      && !s.appendixOnly
      && (s.scoring.engagement || 0) > 0.35
    );
    if (mostWritable) {
      const author = mostWritable.handle ? `@${mostWritable.handle}` : mostWritable.author || '';
      actions.push(`**写帖优先**：${author ? author + ' 的' : ''}「${clip(mostWritable.title, 40)}」可写性最高，建议明早扩成 X 长帖`);
    } else if (signalItems.length > 0) {
      actions.push(`**写帖建议**：今天 top signal「${clip(signalItems[0].title, 40)}」虽然可写性一般，但话题热度够，可以试试短评式发布`);
    }

    // 2. Emerging topics: topics that appeared 2+ times
    const topicCounts = {};
    for (const item of signalItems) {
      const topic = extractTopic((item.title || '') + ' ' + (item.summary || ''));
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    }
    const emerging = Object.entries(topicCounts)
      .filter(([t, c]) => c >= 2 && t !== 'general')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    if (emerging.length > 0) {
      const tags = emerging.map(([t, c]) => `${topicLabel[t] || t}(${c}条)`).join('、');
      actions.push(`**追踪主题**：${tags} 今天重复出现，加入持续观察列表`);
    }

    // 3. Source coverage check
    const sourceTypes = new Set(signalItems.map(s => s.type));
    const missing = [];
    if (!sourceTypes.has('blog_post')) missing.push('博客');
    if (!sourceTypes.has('podcast_episode')) missing.push('播客');
    if (!sourceTypes.has('x_tweet')) missing.push('推文');
    if (missing.length > 0) {
      actions.push(`**源覆盖**：今天缺少 ${missing.join('、')} 来源的高信号，考虑扩充对应信号源`);
    }

    // 4. Fallback if nothing specific
    if (actions.length === 0) {
      actions.push('今天信号较少，建议回顾本周积累的信号，看看有没有跨天重复出现的主题');
    }

    return actions;
  };

  // ════════════════════════════
  //  Render
  // ════════════════════════════
  const lines = [];

  // Header
  lines.push(`# 📡 ${output.config.name}`);
  lines.push('');
  const dateStr = new Date(output.generatedAt).toLocaleString('zh-CN', { timeZone: output.config.timezone, hour12: false });
  const reviewCount = signalItems.filter(s => s.needsReview === true).length;
  const reviewSuffix = reviewCount > 0 ? ` · ${reviewCount} 条待二次确认` : '';
  lines.push(`> ${dateStr} · 知情 ${infoItems.length} · 成稿 ${draftItems.length} · 共 ${topSignals.length} 条高信号 · ${totalTweets} 条原始推文${reviewSuffix}`);
  lines.push('');

  // 今日判断
  lines.push('## 今日判断');
  lines.push('');
  lines.push(buildLead());
  lines.push('');

  // 分区渲染：知情（X）/ 成稿原料（非 X）
  const renderSignalEntry = (item, index) => {
    const blob = (item.fullText || item.title || '') + ' ' + (item.summary || '');
    const topic = extractTopic(blob);
    const badge = engagementBadge(item);
    const source = sourceTag(item);
    const label = topicLabel[topic] || '📌 综合';
    const isRecovered = item.repeatObservation;
    const body = signalBodyText(item);
    const note = item._bodyNote || bodyEditorialNote(item) || '扩帖切口：（本条评价降级，仅保留原文）';

    const out = [];
    out.push(`**${index}.** ${body}`);
    out.push(`\`${label}\`${isRecovered ? ' · 🔄 重复观察' : ''} · ${source}${badge ? ' · ' + badge : ''}`);
    out.push('');
    out.push(`> ${note}`);
    if (isXSignal(item)) {
      const replies = Array.isArray(item.topReplies) ? item.topReplies : [];
      if (replies.length > 0) {
        out.push('评论摘要：');
        for (const r of replies.slice(0, 3)) {
          const who = r.author ? `@${r.author}：` : '';
          out.push(`- ${who}${clip(r.text, REPLY_TEXT_MAX)}`);
        }
      } else {
        out.push('评论未取到');
      }
    }
    if (item.url) out.push(`[→ 原文](${item.url})`);
    out.push('');
    return out;
  };

  lines.push('---');
  lines.push('');
  lines.push('## 知情（X）');
  lines.push('');
  lines.push('> 定位：了解最新');
  lines.push('');
  if (infoItems.length === 0) {
    lines.push('_今日暂无足够强的 X 高信号。_');
    lines.push('');
  } else {
    for (const [i, item] of infoItems.entries()) {
      lines.push(...renderSignalEntry(item, i + 1));
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('## 成稿原料（非 X）');
  lines.push('');
  lines.push('> 定位：可扩早档帖的一手（博客 / 官网 / 播客等）；不成则宁缺，不拿即刻或 X 充数');
  lines.push('');
  const rssStats = output.rssFetchStats || {};
  const blogFetched = Number(rssStats.blogFetchedTotal || 0);
  const blogZero = Array.isArray(rssStats.blogZeroSources) ? rssStats.blogZeroSources : [];
  if (draftItems.length === 0) {
    const zeroHint = blogFetched === 0
      ? `今日新源/博客抓到 0 条，成稿区为空（未用即刻/X 充数）${blogZero.length ? `；0 条源：${blogZero.slice(0, 8).join('、')}${blogZero.length > 8 ? '…' : ''}` : ''}`
      : `今日成稿原料不足（RSS 博客抓到 ${blogFetched} 条但未进高信号前十；未用即刻/X 充数）`;
    lines.push(`_${zeroHint}_`);
    lines.push('');
  } else {
    for (const [i, item] of draftItems.entries()) {
      lines.push(...renderSignalEntry(item, i + 1));
    }
    if (blogFetched === 0) {
      lines.push('_注：当日 RSS 博客抓到 0；上方成稿若有条目来自远程 feed-blogs/播客，非即刻充数。_');
      lines.push('');
    } else if (blogZero.length > 0) {
      lines.push(`_注：部分博客源抓到 0：${blogZero.slice(0, 8).join('、')}${blogZero.length > 8 ? '…' : ''}_`);
      lines.push('');
    }
  }

  // 附录：权重源低互动（不占正文前十）
  const appendixItems = (output.appendixSignals || []).slice(0, 5);
  if (appendixItems.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('### 附录：权重源低互动');
    lines.push('');
    for (const item of appendixItems) {
      const source = sourceTag(item);
      const badge = engagementBadge(item);
      lines.push(`- ${item.title}`);
      lines.push(`  ${source}${badge ? ' · ' + badge : ''} · ${item.reviewNote || '附录观察'}`);
      if (item.url) lines.push(`  [→ 原文](${item.url})`);
      lines.push('');
    }
  }

  // 下一步（collapsed into a compact block）
  lines.push('---');
  lines.push('');
  lines.push('### 下一步');
  lines.push('');
  for (const action of buildActions()) {
    lines.push(`- ${action}`);
  }
  lines.push('');

  // Stats footer（collapsed into a single line）
  const stats = output.stats || {};
  const footerParts = [
    `${stats.xBuilders || 0} builders`,
    `${totalTweets} tweets`,
    `${stats.blogPosts || 0} blogs`,
    `rss-blogs-fetched ${blogFetched}`,
    blogZero.length ? `rss-zero ${blogZero.length}` : null,
    `${stats.podcastEpisodes || 0} podcasts`,
    `知情${infoItems.length}+成稿${draftItems.length}/${topSignals.length} high-signal`,
    demotedForNote.length ? `${demotedForNote.length} note-demoted` : null,
    stats.recoveredSeenCount ? `${stats.recoveredSeenCount} recovered` : null,
    lowSignalCount > 0 ? `${lowSignalCount} filtered` : null,
    (stats.highSignalCounts?.jike_post || 0) > 0 ? 'jike-excluded-from-body' : null,
  ].filter(Boolean).join(' · ');
  lines.push(`<sub>${footerParts} · ${output.config.outputMode} mode</sub>`);
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const errors = [];
  let config = normalizeConfig({});

  if (existsSync(CONFIG_PATH)) {
    try {
      config = normalizeConfig(JSON.parse(await readFile(CONFIG_PATH, 'utf-8')));
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  const scriptDir = decodeURIComponent(new URL(import.meta.url).pathname).replace(/\/[^\/]+$/, '');
  const rootDir = join(scriptDir, '..');
  const localPromptsDir = join(rootDir, 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');
  const configDir = join(rootDir, 'config');

  const [feedX, feedPodcasts, feedBlogs, profiles, customSources] = await Promise.all([
    fetchJSON(FEED_X_URL),
    fetchJSON(FEED_PODCASTS_URL),
    fetchJSON(FEED_BLOGS_URL),
    loadLocalSourceProfiles(configDir),
    loadCustomSources()
  ]);

  if (!feedX) errors.push('Could not fetch tweet feed');
  if (!feedPodcasts) errors.push('Could not fetch podcast feed');
  if (!feedBlogs) errors.push('Could not fetch blog feed');

  const prompts = {};
  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const prompt = await loadTextPrompt(filename, localPromptsDir, userPromptsDir);
    if (prompt) prompts[key] = prompt;
    else errors.push(`Could not load prompt: ${filename}`);
  }

  const mergedSources = mergeSources(profiles, config.sourceProfiles, customSources);
  const filtered = filterFeedBySources(feedX, feedPodcasts, feedBlogs, mergedSources);

  // 抓取即刻 RSS 和自定义 RSS 博客（即刻 2026-10-26 起配置可为空，不进正文两区）
  const directRSS = await fetchDirectRSSSources(mergedSources);
  // jike 仍可进入 scored 池统计，但 DRAFT_MATERIAL_TYPES 已剔除且 signalNote 对 jike 返回 null
  filtered.x.push(...directRSS.jike);
  filtered.blogs.push(...directRSS.rss_blogs);
  filtered.x.push(...directRSS.bilibili);
  const rssFetchStats = directRSS.rssFetchStats || { blogs: {}, blogFetchedTotal: 0, blogZeroSources: [] };

  const rawScoredSignals = buildScoredSignals(filtered, config);
  const rawCounts = countSignalsByType(rawScoredSignals);
  const seenMap = NO_SEEN ? {} : await loadSeenSignals();
  const unseenSignals = NO_SEEN ? rawScoredSignals : filterSeenSignals(rawScoredSignals, seenMap);
  const postSeenCounts = countSignalsByType(unseenSignals);
  const seenFilteredCounts = Object.fromEntries(
    Array.from(new Set([...Object.keys(rawCounts), ...Object.keys(postSeenCounts)])).map(type => [
      type,
      Math.max((rawCounts[type] || 0) - (postSeenCounts[type] || 0), 0)
    ])
  );
  if (NO_SEEN) process.stderr.write('[seen-signals] Bypassed (--no-seen)\n');

  // Auto-resolve all needsReview flags — no LLM needed
  const { keep: reviewedSignals, demote: demotedSignals, appendix: appendixSignals = [] } = autoResolveReview(unseenSignals);
  const fallback = NO_SEEN || !ALLOW_SEEN_FALLBACK
    ? { signals: reviewedSignals, recovered: [] }
    : recoverFallbackSignals(rawScoredSignals, reviewedSignals, seenMap, config, 5);
  const scoredSignals = fallback.signals;
  const recoveredSeenSignals = fallback.recovered;
  const demotedCounts = countSignalsByType(demotedSignals);
  let highSignalCounts = countSignalsByType(
    scoredSignals.filter(s => s.scoring.total >= config.scoring.minimum)
  );
  if (demotedSignals.length > 0) {
    process.stderr.write(`[auto-review] Demoted ${demotedSignals.length} low-signal flagged item(s)\n`);
  }
  if (appendixSignals.length > 0) {
    process.stderr.write(`[auto-review] Appendix ${appendixSignals.length} high-source low-eng item(s)\n`);
  }
  if (recoveredSeenSignals.length > 0) {
    process.stderr.write(`[seen-signals] Recovered ${recoveredSeenSignals.length} high-score seen fallback signal(s)\n`);
  }



  const draftCandidates = buildDraftCandidates(scoredSignals, config);
  const modeViews = buildModeViews(scoredSignals, config);

  const output = {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    config,
    sources: {
      profiles: config.sourceProfiles,
      reservedProfiles: config.reservedSourceProfiles,
      weights: buildSourceWeightSummary(config),
      merged: mergedSources,
      counts: {
        x_accounts: mergedSources.x_accounts.length,
        blogs: mergedSources.blogs.length,
        podcasts: mergedSources.podcasts.length,
        jike_accounts: mergedSources.jike_accounts?.length || 0,
        zh_creators: customSources.zh_creators?.sources?.length || 0
      },
      custom: {
        zh_creators: customSources.zh_creators || { enabled: false, sources: [] }
      }
    },
    podcasts: filtered.podcasts,
    x: filtered.x,
    blogs: filtered.blogs,
    scoredSignals,
    draftCandidates,
    modeViews,
    renderedMarkdown: '',
    stats: {
      podcastEpisodes: filtered.podcasts.length || 0,
      xBuilders: filtered.x.length || 0,
      totalTweets: (filtered.x || []).reduce((sum, a) => sum + (a.tweets?.length || 0), 0),
      blogPosts: filtered.blogs.length || 0,
      highSignalCount: scoredSignals.filter(s => s.scoring.total >= config.scoring.minimum).length,
      autoResolvedCount: demotedSignals.length,
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt || null,
      rawCounts,
      postSeenCounts,
      seenFilteredCounts,
      demotedCounts,
      highSignalCounts,
      recoveredSeenCount: recoveredSeenSignals.length
    },
    prompts,
    recoveredSeenSignals: recoveredSeenSignals.map(s => ({
      title: s.title,
      handle: s.handle,
      url: s.url,
      type: s.type,
      scoring: { total: s.scoring.total, relevance: s.scoring.relevance }
    })),
    rssFetchStats,
    appendixSignals,
    demotedSignals: demotedSignals.map(s => ({
      title: s.title,
      handle: s.handle,
      url: s.url,
      type: s.type,
      reviewReason: s.reviewReason,
      scoring: { total: s.scoring.total, engagement: s.scoring.engagement, relevance: s.scoring.relevance, penalty: s.scoring.penalty }
    })),
    errors: errors.length > 0 ? errors : undefined
  };

  output.renderedMarkdown = renderMarkdown(output);

  // Persist seen signals (only high-signal ones that were actually surfaced)
  if (!NO_SEEN) {
    const surfacedUrls = scoredSignals
      .filter(s => s.scoring.total >= config.scoring.minimum)
      .map(s => s.url)
      .filter(Boolean);
    await saveSeenSignals(seenMap, surfacedUrls);
  }

  // 写 dashboard 可读的风声快照
  try {
    const { writeFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const scriptDir = dirname(decodeURIComponent(new URL(import.meta.url).pathname));
    const dashboardSignals = {
      generatedAt: output.generatedAt,
      stats: output.stats,
      signals: (output.scoredSignals || [])
        .filter(s => s.scoring && s.scoring.total >= 0.62)
        .map(s => ({
          id: s.url,
          source: s.type === 'x_tweet' ? 'x' : s.type === 'blog_post' ? 'blog' : 'podcast',
          sourceName: s.author || s.handle || s.name || '',
          handle: s.handle || null,
          title: s.title || '',
          url: s.url,
          summary: s.summary || '',
          score: Math.round((s.scoring.total || 0) * 100),
          publishedAt: s.publishedAt || output.generatedAt,
          topic: s.signalIntent || 'general',
          needsReview: s.needsReview || false,
          reviewNote: s.reviewNote || s.reviewReason || null,
        })),
    };
    writeFileSync(
      join(scriptDir, '..', 'dashboard-signals.json'),
      JSON.stringify(dashboardSignals, null, 2),
      'utf8'
    );
  } catch (e) {
    // 写失败不影响主流程
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
});