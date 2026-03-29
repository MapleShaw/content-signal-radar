#!/usr/bin/env node

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const CUSTOM_SOURCES_PATH = join(USER_DIR, 'custom-sources.json');

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
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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
    focusTopics: input.focusTopics || ['agent', 'AI 产品', 'personal brand', 'creator tools', 'AI 出海'],
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
      zarazhangrui: '高密度 agent / builder 信号，且和你的关注方向高度一致',
      _catwu: '产品与 builder 视角兼具，噪音相对低',
      leeerob: 'AI 产品、开发者工具、分发视角稳定',
      levelsio: '独立开发 + 分发 + 出海视角强',
      rauchg: '产品范式变化和 platform 视角常有高信号',
      steipete: '开发者工具与 AI 工作流洞察稳定',
      karpathy: '技术方向权重大，但不一定每天都直接可写'
    },
    scoring: {
      relevance: input.scoring?.relevance ?? 0.35,
      writeability: input.scoring?.writeability ?? 0.18,
      actionability: input.scoring?.actionability ?? 0.2,
      novelty: input.scoring?.novelty ?? 0.12,
      engagement: input.scoring?.engagement ?? 0.07,
      recency: input.scoring?.recency ?? 0.08,
      minimum: input.scoring?.minimum ?? 0.62,
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
    return { x_accounts: [], blogs: [], podcasts: [], zh_creators: { enabled: false, sources: [] } };
  }
  try {
    const parsed = JSON.parse(await readFile(CUSTOM_SOURCES_PATH, 'utf-8'));
    return {
      x_accounts: parsed.x_accounts || [],
      blogs: parsed.blogs || [],
      podcasts: parsed.podcasts || [],
      zh_creators: parsed.zh_creators || { enabled: false, sources: [] }
    };
  } catch {
    return { x_accounts: [], blogs: [], podcasts: [], zh_creators: { enabled: false, sources: [] } };
  }
}

function mergeSources(profiles, enabledProfiles, customSources) {
  const merged = { x_accounts: [], blogs: [], podcasts: [] };
  for (const profileName of enabledProfiles) {
    const profile = profiles[profileName];
    if (!profile) continue;
    merged.x_accounts.push(...(profile.x_accounts || []));
    merged.blogs.push(...(profile.blogs || []));
    merged.podcasts.push(...(profile.podcasts || []));
  }
  merged.x_accounts.push(...(customSources.x_accounts || []));
  merged.blogs.push(...(customSources.blogs || []));
  merged.podcasts.push(...(customSources.podcasts || []));

  return {
    x_accounts: uniqBy(merged.x_accounts, item => (item.handle || '').toLowerCase()),
    blogs: uniqBy(merged.blogs, item => item.indexUrl || item.name),
    podcasts: uniqBy(merged.podcasts, item => item.playlistId || item.channelHandle || item.url || item.name)
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
      const weightedScore = applyOutputModeBoosts(baseScore * sourceWeight, config.outputMode, { type: 'x_tweet' });

      signals.push({
        type: 'x_tweet',
        author: account.name,
        handle: account.handle,
        title: clip(text.replace(/\s+/g, ' ').trim(), 90),
        summary: clip(text.replace(/\s+/g, ' ').trim(), 220),
        url: tweet.url,
        publishedAt: tweet.createdAt,
        metrics: {
          likes: tweet.likes || 0,
          retweets: tweet.retweets || 0,
          replies: tweet.replies || 0
        },
        explainability: {
          sourceReason: getSourceReason(account.handle, config),
          modeEffect: config.outputMode === 'x_draft' ? '当前模式偏向可写性更高的内容' : config.outputMode === 'signal_only' ? '当前模式偏向高信号判断' : '当前模式为平衡输出'
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
          total: Number(weightedScore.toFixed(3))
        }
      });
    }
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

    signals.push({
      type: 'blog_post',
      author: blog.name,
      title: blog.title,
      summary: clip(blog.description || blog.content || '', 220),
      url: blog.url,
      publishedAt: blog.publishedAt,
      explainability: {
        sourceReason: '博客源当前未单独加权，按内容信号本身排序',
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
        total: Number(weightedScore.toFixed(3))
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

    signals.push({
      type: 'podcast_episode',
      author: podcast.name,
      title: podcast.title,
      summary: clip(podcast.transcript || '', 220),
      url: podcast.url,
      publishedAt: podcast.publishedAt,
      explainability: {
        sourceReason: '播客源当前未单独加权，按内容信号本身排序',
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
        total: Number(weightedScore.toFixed(3))
      }
    });
  }

  return signals.sort((a, b) => b.scoring.total - a.scoring.total);
}

function buildDraftCandidates(scoredSignals, config) {
  return scoredSignals
    .filter(signal => signal.scoring.total >= config.scoring.minimum)
    .slice(0, config.limits.x_drafts)
    .map((signal, index) => ({
      rank: index + 1,
      sourceType: signal.type,
      title: signal.title,
      angle: `这条信号值得写，不是因为它是新闻，而是因为它暴露了 ${config.focusTopics[0]} / ${config.focusTopics[1]} / workflow 判断的变化。`,
      suggestedOpening: `我越来越感觉，真正值得关注的不是又出了什么新功能，而是这类信号背后产品逻辑已经在变。`,
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
      whyItMatters: `它不是普通更新，因为它直接指向 ${config.focusTopics.slice(0, 2).join(' / ')} 的判断变化。`,
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
  const topSignals = output.scoredSignals.filter(s => s.scoring.total >= output.config.scoring.minimum);
  const briefItems = topSignals.slice(0, output.config.limits.brief);
  const xAngles = topSignals.slice(0, output.config.limits.x_angles);
  const productSignals = topSignals.slice(0, output.config.limits.product_signals);
  const xDrafts = output.draftCandidates.slice(0, output.config.limits.x_drafts);

  const lines = [];
  lines.push(`# ${output.config.name}`);
  lines.push('');
  lines.push(`生成时间：${output.generatedAt}`);
  lines.push(`模式：${output.config.outputMode}`);
  lines.push(`高信号数量：${output.stats.highSignalCount}`);
  lines.push('');

  if (output.config.outputSections.includes('brief')) {
    lines.push('## 今日简报');
    lines.push('');
    for (const [i, item] of briefItems.entries()) {
      lines.push(`### ${i + 1}. ${item.title}`);
      lines.push(`- 来源：${item.author || item.handle || item.type}`);
      lines.push(`- 分数：${item.scoring.total}（base ${item.scoring.base} × source ${item.scoring.sourceWeight}）`);
      lines.push(`- 为什么值得关心：${item.explainability?.sourceReason || '高信号内容'}；${item.explainability?.modeEffect || ''}`);
      lines.push(`- 链接：${item.url}`);
      lines.push('');
    }
  }

  if (output.config.outputSections.includes('x_angles')) {
    lines.push('## X 可写角度');
    lines.push('');
    for (const [i, item] of xAngles.entries()) {
      lines.push(`### 角度 ${i + 1}`);
      lines.push(`- 标题：${item.title}`);
      lines.push(`- 为什么能写：这条内容同时满足相关度和可写性，适合延展成观点。`);
      lines.push(`- 开头句：我越来越感觉，${clip(item.title, 50)} 这类信号，真正重要的不是表面信息，而是它暴露了产品逻辑在变。`);
      lines.push(`- 链接：${item.url}`);
      lines.push('');
    }
  }

  if (output.config.outputSections.includes('product_signals')) {
    lines.push('## 产品 / 项目信号');
    lines.push('');
    for (const [i, item] of productSignals.entries()) {
      lines.push(`### 信号 ${i + 1}`);
      lines.push(`- ${item.title}`);
      lines.push(`- 判断：这条更像产品范式或工作流变化，不只是功能更新。`);
      lines.push(`- 链接：${item.url}`);
      lines.push('');
    }
  }

  if (output.config.outputSections.includes('x_drafts')) {
    lines.push('## X 草稿');
    lines.push('');
    for (const draft of xDrafts) {
      lines.push(`### 草稿 ${draft.rank}`);
      lines.push(`- 首句：${draft.suggestedOpening}`);
      lines.push(`- 角度：${draft.angle}`);
      lines.push(`- 链接：${draft.sourceUrl}`);
      lines.push('');
    }
  }

  if (output.config.outputSections.includes('action_items')) {
    lines.push('## 下一步动作');
    lines.push('');
    lines.push('- 选 1 条高分 signal，扩成 X 长帖');
    lines.push('- 看看 sourceWeights 还要不要继续调');
    lines.push('- 中文 source 暂时留空，等第一批高质量源确定再接');
    lines.push('');
  }

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

  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
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
  const scoredSignals = buildScoredSignals(filtered, config);
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
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt || null
    },
    prompts,
    errors: errors.length > 0 ? errors : undefined
  };

  output.renderedMarkdown = renderMarkdown(output);
  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
});