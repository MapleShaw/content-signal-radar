#!/usr/bin/env node
// ============================================================================
// Content Signal Radar — Reddit Feed Generator (精简版)
// ============================================================================
// Runs on GitHub Actions (daily at 6am UTC) to fetch Reddit content.
// Only Reddit — X, YouTube, Podcasts, Blogs 已弃用（数据源不稳定）
//
// Reddit JSON API: https://www.reddit.com/r/<sub>/hot.json
// No auth/token required. Public API.
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

// Reddit subreddits to monitor (from default-sources.json)
const SUBREDDITS = [
  { name: 'smallbusiness', rsshub: 'https://rsshub.app/reddit/r/smallbusiness/hot' },
  { name: 'Entrepreneur', rsshub: 'https://rsshub.app/reddit/r/Entrepreneur/hot' },
  { name: 'SaaS', rsshub: 'https://rsshub.app/reddit/r/SaaS/hot' },
];

async function loadState() {
  if (!existsSync(STATE_PATH)) return { seenPosts: {} };
  try {
    const s = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    return { seenPosts: s.seenPosts || {} };
  } catch {
    return { seenPosts: {} };
  }
}

async function saveState(state) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenPosts || {})) {
    if (ts < cutoff) delete state.seenPosts[id];
  }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function fetchRedditSub(name, limit = 10) {
  const url = `https://www.reddit.com/r/${name}/hot.json?limit=${limit}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      }
    });
    if (!res.ok) {
      console.error(`[reddit] r/${name}: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    return (data.data?.children || []).map(c => c.data).filter(p => p);
  } catch (err) {
    console.error(`[reddit] r/${name}: ${err.message}`);
    return [];
  }
}

async function main() {
  const state = await loadState();
  const now = Date.now();
  const posts = [];

  for (const sub of SUBREDDITS) {
    const raw = await fetchRedditSub(sub.name, 10);
    const newPosts = raw.filter(p => !state.seenPosts[p.id]);
    console.error(`[reddit] r/${sub.name}: ${raw.length} raw, ${newPosts.length} new`);
    for (const p of newPosts) {
      state.seenPosts[p.id] = now;
      posts.push({
        id: p.id,
        subreddit: sub.name,
        title: (p.title || '').slice(0, 300),
        text: (p.selftext || '').slice(0, 800),
        url: `https://www.reddit.com${p.permalink}`,
        author: p.author,
        score: p.score || 0,
        numComments: p.num_comments || 0,
        createdAt: new Date(p.created_utc * 1000).toISOString(),
        isSelf: p.is_self ?? true,
      });
    }
  }

  // Deduplicate by permalink
  const seen = new Set();
  const unique = posts.filter(p => {
    if (seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });

  const output = {
    generatedAt: new Date().toISOString(),
    reddit: unique,
  };

  await writeFile(
    join(SCRIPT_DIR, '..', 'feed-reddit.json'),
    JSON.stringify(output, null, 2),
    'utf8'
  );
  await saveState(state);

  console.error(`[reddit] Total: ${unique.length} posts written to feed-reddit.json`);
  console.log(JSON.stringify({ status: 'ok', count: unique.length, generatedAt: output.generatedAt }));
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
});
