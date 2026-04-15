#!/usr/bin/env node

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const USER_DIR = join(homedir(), '.content-signal-radar');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const CUSTOM_SOURCES_PATH = join(USER_DIR, 'custom-sources.json');
const SEEN_SIGNALS_PATH = join(USER_DIR, 'seen-signals.json');
const SEEN_SIGNALS_TTL_DAYS = 7;

const FEED_X_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
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

function includesAny(text = '', keywords = []) {
  const lower = text.toLowerCase();
  return (keywords || []).some(keyword => lower.includes(String(keyword).toLowerCase()));
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
    outputSections: input.outputSections || ['brief', 'x_angles', 'product_signals', 'x_drafts', 'action_items'],
    outputMode: input.outputMode || 'balanced',
    sourceProfiles: input.sourceProfiles || ['default', 'maple'],
    disabledSections: input.disabledSections || ['xiaohongshu_topics'],
    reservedSourceProfiles: input.reservedSourceProfiles || ['zh_creators'],
    sourceWeights: input.sourceWeights || {
      _catwu: 1.2,
      zarazhangrui: 1.25,
      levelsio: 1.15,
      thedankoe: 1.0,
      tdinh_me: 1.0,
      lexfridman: 0.95,
      leeerob: 1.2,
      steipete: 1.1,
      naval: 1.0,
      gregisenberg: 1.0,
      rauchg: 1.15,
      karpathy: 1.1
    },
    sourceWeightReasons: input.sourceWeightReasons || {
      zarazhangrui: '高密度 agent / builder 信号,且和你的关注方向高度一致',
      _catwu: '产品与 builder 视角兼具,噪音相对低',
      leeerob: 'AI 产品、开发者工具、分发视角稳定',
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
      engagement: input.scoring?.engagement ?? 0.07,
      recency: input.scoring?.recency ?? 0.08,
      minimum: input.scoring?.minimum ?? 0.58,
      sourceWeightCap: input.scoring?.sourceWeightCap ?? 1.3
    },
    limits: {
      brief: input.limits?.brief ?? 5,
      x_angles: input.limits?.x_angles ?? 3,
      product_signals: input.limits?.product_signals ?? 3,
      x_drafts: input.limits?.x_drafts ?? 2,
      action_items: input.limits?.action_items ?? 3
    },
    onboardingComplete: input.onboardingComplete ?? false
  };
}

async function fetchJSON(url) {
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
    return { x_accounts: [], blogs: [], podcasts: [], jike_accounts: [], zh_creators: { enabled: false, sources: [] } };
  }
  try {
    const parsed = JSON.parse(await readFile(CUSTOM_SOURCES_PATH, 'utf-8'));
    return {
      x_accounts: parsed.x_accounts || [],
      blogs: parsed.blogs || [],
      podcasts: parsed.podcasts || [],
      jike_accounts: parsed.jike_accounts || [],
      zh_creators: parsed.zh_creators || { enabled: false, sources: [] }
    };
  } catch {
    return { x_accounts: [], blogs: [], podcasts: [], jike_accounts: [], zh_creators: { enabled: false, sources: [] } };
  }
}

function mergeSources(profiles, enabledProfiles, customSources) {
  const merged = { x_accounts: [], blogs: [], podcasts: [], jike_accounts: [] };
  for (const profileName of enabledProfiles) {
    const profile = profiles[profileName];
    if (!profile) continue;
    merged.x_accounts.push(...(profile.x_accounts || []));
    merged.blogs.push(...(profile.blogs || []));
    merged.podcasts.push(...(profile.podcasts || []));
    merged.jike_accounts.push(...(profile.jike_accounts || []));
  }
  merged.x_accounts.push(...(customSources.x_accounts || []));
  merged.blogs.push(...(customSources.blogs || []));
  merged.podcasts.push(...(customSources.podcasts || []));
  merged.jike_accounts.push(...(customSources.jike_accounts || []));

  return {
    x_accounts: uniqBy(merged.x_accounts, item => (item.handle || '').toLowerCase()),
    blogs: uniqBy(merged.blogs, item => item.indexUrl || item.name),
    podcasts: uniqBy(merged.podcasts, item => item.playlistId || item.channelHandle || item.url || item.name),
    jike_accounts: uniqBy(merged.jike_accounts, item => item.uuid || item.rsshub)
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
  const results = { jike: [], rss_blogs: [] };

  // 抓即刻账号
  const jikeAccounts = mergedSources.jike_accounts || [];
  if (jikeAccounts.length > 0) {
    console.error(`[fetchDirectRSS] Fetching ${jikeAccounts.length} jike accounts...`);
  }
  const jikeResults = await Promise.all(
    jikeAccounts.map(async (account) => {
      if (!account.rsshub) return [];
      const items = await fetchRSSFeed(account.rsshub);
      console.error(`[fetchDirectRSS] jike ${account.name}: ${items.length} items`);
      return items.slice(0, 5).map(item => ({
        type: 'jike_post',
        handle: account.uuid,
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
      console.error(`[fetchDirectRSS] rss blog ${blog.name}: ${items.length} items`);
      return items.slice(0, 3).map(item => ({
        type: 'blog_post',
        name: blog.name,
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
    return relevance * 0.35 + writeability * 1.3 * 0.18 + actionability * 0.2 + novelty * 1.2 * 0.12 + engagement * 0.07 + recency * 0.08;
  }
  if (signalIntent === 'product_signal') {
    return relevance * 1.15 * 0.35 + writeability * 0.18 + actionability * 1.3 * 0.2 + novelty * 0.12 + engagement * 0.07 + recency * 0.08;
  }
  if (signalIntent === 'both') {
    const xScore = relevance * 0.35 + writeability * 1.3 * 0.18 + actionability * 0.2 + novelty * 1.2 * 0.12 + engagement * 0.07 + recency * 0.08;
    const pScore = relevance * 1.15 * 0.35 + writeability * 0.18 + actionability * 1.3 * 0.2 + novelty * 0.12 + engagement * 0.07 + recency * 0.08;
    return Math.max(xScore, pScore);
  }
  // 'neither' — no section boost
  return relevance * 0.35 + writeability * 0.18 + actionability * 0.2 + novelty * 0.12 + engagement * 0.07 + recency * 0.08;
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
  if (wordCount < 15 && type !== 'jike_post') {
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
      signal.reviewNote = '高互动信号，关键词未命中但互动强 — 按互动判断保留';
      signal.needsReview = false;
      keep.push(signal);
      continue;
    }

    // Rule 4: HIGH_SOURCE_LOW_ENG — authoritative source, keep as potential early signal
    if (reasons.includes('HIGH_SOURCE_LOW_ENG')) {
      signal.reviewNote = '权重源新帖，互动偏低但值得关注';
      signal.needsReview = false;
      keep.push(signal);
      continue;
    }

    // Rule 5: PENALIZED_BUT_ENGAGED — engagement redeems it
    if (reasons.includes('PENALIZED_BUT_ENGAGED') && engagement >= 0.5) {
      signal.reviewNote = '内容形式偏低信号，但互动可以 — 保留';
      signal.needsReview = false;
      keep.push(signal);
      continue;
    }

    // Default: keep if total score is above a relaxed threshold (0.52)
    if (signal.scoring.total >= 0.52) {
      signal.reviewNote = '边界信号，分数尚可 — 保留';
      signal.needsReview = false;
      keep.push(signal);
    } else {
      demote.push(signal);
    }
  }

  return { keep, demote };
}

function buildScoredSignals(filtered, config) {
  const keywords = config.focusTopics || [];
  const weights = config.scoring || {};
  const signals = [];

  for (const account of filtered.x || []) {
    for (const tweet of account.tweets || []) {
      const text = tweet.text || '';
      const textLower = text.toLowerCase();
      const relevance = includesAny(text, keywords) ? 1 : 0.45;
      const writeability = includesAny(textLower, ['why', 'how', 'learn', 'mistake', 'distribution', 'brand', 'agent', 'product']) ? 0.8 : 0.55;
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
      const weightedScore = applyOutputModeBoosts(baseScore * sourceWeight * penalty, config.outputMode, { type: 'x_tweet' });
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

      signals.push({
        type: 'x_tweet',
        author: account.name,
        handle: account.handle,
        title: clip(text.replace(/\s+/g, ' ').trim(), 90),
        summary: clip(text.replace(/\s+/g, ' ').trim(), 220),
        url: tweet.url,
        publishedAt: tweet.createdAt,
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
    if (signal.type !== 'jike_post') continue;
    // jike title is a truncated preview (e.g. "发布了: ..."); strip prefix and fall back to title when summary is empty
    const jikeContent = signal.summary || signal.title.replace(/^(发布了|转发了):\s*/, '');
    const text = `${signal.title} ${jikeContent}`.trim();
    const relevance = includesAny(text, keywords) ? 1 : 0.45;
    const writeability = includesAny(text.toLowerCase(), ['why', 'how', 'learn', 'mistake', 'distribution', 'brand', 'agent', 'product']) ? 0.8 : 0.55;
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
    const relevance = includesAny(text, keywords) ? 1 : 0.55;
    const writeability = 0.65;
    const actionability = includesAny(text, ['agent', 'workflow', 'API', 'product']) ? 0.8 : 0.55;
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
      summary: clip(blog.description || blog.content || '', 220),
      url: blog.url,
      publishedAt: blog.publishedAt,
      signalIntent: 'product_signal',
      explainability: {
        sourceReason: '博客源当前未单独加权,按内容信号本身排序',
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
      summary: clip(podcast.transcript || '', 220),
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
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveSeenSignals(seenMap, newUrls) {
  const cutoff = Date.now() - SEEN_SIGNALS_TTL_DAYS * 24 * 3600 * 1000;
  // Prune old entries
  const pruned = Object.fromEntries(
    Object.entries(seenMap).filter(([, ts]) => ts > cutoff)
  );
  // Add new
  const now = Date.now();
  for (const url of newUrls) {
    if (url) pruned[url] = now;
  }
  await writeFile(SEEN_SIGNALS_PATH, JSON.stringify(pruned, null, 2), 'utf8');
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
  return scoredSignals
    .filter(signal => signal.scoring.total >= config.scoring.minimum)
    .slice(0, config.limits.x_drafts)
    .map((signal, index) => ({
      rank: index + 1,
      sourceType: signal.type,
      title: signal.title,
      summary: signal.summary,
      author: signal.handle || signal.author || '',
      angle: `这条信号值得写,不是因为它是新闻,而是因为它暴露了 ${config.focusTopics[0]} / ${config.focusTopics[1]} / workflow 判断的变化。`,
      suggestedOpening: `我越来越感觉,真正值得关注的不是又出了什么新功能,而是这类信号背后产品逻辑已经在变。`,
      sourceUrl: signal.url,
      score: signal.scoring.total
    }));
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
    })),
    x_draft: buildDraftCandidates(scoredSignals, {
      ...config,
      limits: { ...config.limits, x_drafts: Math.max(config.limits.x_drafts, 3) }
    })
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

function renderMarkdown(output) {
  return renderRadar(output);
}

// ============================================================================
// Radar Renderer v2 — editorial daily radar, not debug panel
// ============================================================================

function renderRadar(output) {
  // ── Data ──
  const allSignals = output.scoredSignals || [];
  const topSignals = allSignals.filter(s => s.scoring.total >= output.config.scoring.minimum);
  const totalTweets = output.stats?.totalTweets || 0;
  const xDrafts = (output.draftCandidates || []).slice(0, output.config.limits.x_drafts);
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

  // ── Unified signal list ──
  // Merge all top signals into one list (brief + x_angles + product_signals are now one)
  const signalItems = topSignals.slice(0, Math.max(output.config.limits.brief + 3, 8));

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
  const signalNote = (item) => {
    const text = (item.title || '') + ' ' + (item.summary || '');
    const topic = extractTopic(text);
    const writeHigh = item.scoring.writeability >= 0.8;

    const notes = {
      security: '供应链信任比代码质量更脆弱——这类信号出现时，先查自己的依赖再说别的。',
      context: '瓶颈正在从"模型能不能做"转向"人能不能给够上下文"，产品设计的重心在移动。',
      agent: '不再是"能做什么"的问题，而是"能不能持续超出预期"——评价框架在变。',
      enterprise_workflow: 'AI 工具从可选变成默认，企业采购逻辑正在翻转。',
      coding_agent: '工程师的稀缺能力从写代码变成审查判断，边界已经在移动了。',
      creator: '发布量不是护城河，信号密度和观点锐度才是——创作者竞争维度在变。',
      revenue: '定价和分发比功能复杂度更关键，从 0 到 MRR 的路径正在重塑。',
      indie: '独立开发者的核心优势是决策链条短，这类信号可以直接映射到自己的项目。',
      distribution: '触达正在成为稀缺资源，比产品本身更难复制。',
      model: '能力拉平的窗口在压缩，产品层差异化的时间窗口也跟着缩。',
      product: '这条暴露了一个产品判断的转折点，值得对照自己的项目想一遍。',
      workflow: '自动化边界每扩张一轮，就在重新定义谁的时间更值钱。',
      general: '值得看——不因为新，而因为它能帮你校准方向判断。',
    };

    let note = notes[topic] || notes.general;
    if (item.type === 'blog_post' || item.type === 'podcast_episode') {
      note = '长内容比推文更容易暴露底层逻辑。' + note;
    }
    if (writeHigh) note += ' → 可写性高，优先扩成帖子';
    return note;
  };

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
    const typeEmoji = { x_tweet: '🐦', blog_post: '📝', podcast_episode: '🎙️', jike_post: '🟡' };
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
    const mostWritable = signalItems.find(s => s.scoring.writeability >= 0.8);
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
  lines.push(`> ${dateStr} · ${topSignals.length} 条高信号 · ${totalTweets} 条原始推文${reviewSuffix}`);
  lines.push('');

  // 今日判断
  lines.push('## 今日判断');
  lines.push('');
  lines.push(buildLead());
  lines.push('');

  // 信号（unified list）
  lines.push('---');
  lines.push('');
  lines.push('## 信号');
  lines.push('');
  for (const [i, item] of signalItems.entries()) {
    const text = (item.title || '') + ' ' + (item.summary || '');
    const topic = extractTopic(text);
    const badge = engagementBadge(item);
    const source = sourceTag(item);
    const label = topicLabel[topic] || '📌 综合';

    lines.push(`### ${i + 1}. ${item.title}`);
    lines.push(`${source} · \`${label}\`${badge ? ' · ' + badge : ''}`);
    lines.push('');
    lines.push(item.reviewNote || signalNote(item));
    lines.push('');
    if (item.url) lines.push(`[→ 原文](${item.url})`);
    lines.push('');
  }

  // X 草稿
  if (xDrafts.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## ✏️ X 草稿');
    lines.push('');
    for (const [i, draft] of xDrafts.entries()) {
      lines.push(`### 草稿 ${i + 1}`);
      lines.push('');
      lines.push(makeDraftText(draft));
      lines.push('');
    }
  }

  // 下一步
  lines.push('---');
  lines.push('');
  lines.push('## 下一步');
  lines.push('');
  for (const action of buildActions()) {
    lines.push(`- ${action}`);
  }
  lines.push('');

  // Stats footer
  lines.push('---');
  lines.push('');
  const stats = output.stats || {};
  const footerParts = [
    `${stats.xBuilders || 0} builders`,
    `${totalTweets} tweets`,
    `${stats.blogPosts || 0} blogs`,
    `${stats.podcastEpisodes || 0} podcasts`,
    `${topSignals.length} high-signal`,
    lowSignalCount > 0 ? `${lowSignalCount} filtered` : null,
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

  // 抓取即刻 RSS 和自定义 RSS 博客
  const directRSS = await fetchDirectRSSSources(mergedSources);
  filtered.x.push(...directRSS.jike);
  filtered.blogs.push(...directRSS.rss_blogs);

  const rawScoredSignals = buildScoredSignals(filtered, config);
  const seenMap = await loadSeenSignals();
  const unseenSignals = filterSeenSignals(rawScoredSignals, seenMap);

  // Auto-resolve all needsReview flags — no LLM needed
  const { keep: scoredSignals, demote: demotedSignals } = autoResolveReview(unseenSignals);
  if (demotedSignals.length > 0) {
    process.stderr.write(`[auto-review] Demoted ${demotedSignals.length} low-signal flagged item(s)\n`);
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
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt || null
    },
    prompts,
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
  const surfacedUrls = scoredSignals
    .filter(s => s.scoring.total >= config.scoring.minimum)
    .map(s => s.url)
    .filter(Boolean);
  await saveSeenSignals(seenMap, surfacedUrls);

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
});