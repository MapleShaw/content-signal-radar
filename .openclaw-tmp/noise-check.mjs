import { readFileSync } from 'fs';
const src = readFileSync('scripts/prepare-digest.js','utf8');
const start = src.indexOf('function stripHtml');
const end = src.indexOf('function normalizeConfig');
let code = src.slice(start,end);
code += `\nconst samples = [\n  'lol',\n  'Anyone at @X API I can ask for help? My tokens do not work anymore',\n  'RT to win a coupon https://example.com',\n  'How I used Claude Code to automate a weekly content workflow in 5 steps',\n  '发布了: 读KK的《科技想要什么》，不断联想到一个问题：Agent 想要什么？'\n];\nfor (const s of samples) console.log(JSON.stringify({s, noise:socialNoiseProfile(s), dims:scoreTextDimensions(s)}));`;
eval(code);
