import { env, MAX_ARTICLES } from '../config/index.js';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { openaiSummarize } from './ai.js';
export async function googleSearch(query) {
    console.log("[DEBUG] googleSearch called with:", query);
    const apiKey = env.GOOGLE_API_KEY;
    const cseId = env.GOOGLE_CSE_ID;
    if (!apiKey || !cseId) {
        console.warn('Google APIキーまたはCSE IDが未設定です', { apiKey, cseId });
        return [];
    }
    if (!query) {
        console.warn('検索クエリが空です');
        return [];
    }
    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}` +
        `&q=${encodeURIComponent(query)}&hl=ja&gl=jp&lr=lang_ja&sort=date`;
    console.log('[DEBUG] googleSearch APIリクエストURL:', url);
    let res, data;
    try {
        res = await fetch(url);
        data = await res.json();
        console.log('[DEBUG] googleSearch APIレスポンス:', JSON.stringify(data, null, 2));
    }
    catch (e) {
        console.error('[ERROR] googleSearch APIリクエスト失敗:', e);
        return [];
    }
    if (!data.items || data.items.length === 0) {
        console.warn('[DEBUG] googleSearch: 検索結果が空です', { data });
        return [];
    }
    const EXCLUDE_DOMAINS = [
        'login', 'auth', 'accounts.google.com', 'ad.', 'ads.', 'doubleclick.net', 'googlesyndication.com'
    ];
    const PRIORITY_DOMAINS = [
        'go.jp', 'ac.jp', 'ed.jp', 'nhk.or.jp', 'asahi.com', 'yomiuri.co.jp', 'mainichi.jp',
        'nikkei.com', 'reuters.com', 'bloomberg.co.jp', 'news.yahoo.co.jp', 'city.', 'pref.', 'gkz.or.jp', 'or.jp', 'co.jp', 'jp', 'com', 'org', 'net'
    ];
    const filtered = data.items
        .filter((i) => {
        const valid = /^https?:\/\//.test(i.link) && !EXCLUDE_DOMAINS.some(domain => i.link.includes(domain));
        if (!valid)
            console.log('[DEBUG] googleSearch: 除外ドメイン:', i.link);
        return valid;
    })
        .sort((a, b) => {
        const aPriority = PRIORITY_DOMAINS.some(domain => a.link.includes(domain)) ? 2 :
            /twitter|x\.com|facebook|instagram|threads|note|blog|tiktok|line|pinterest|linkedin|youtube|discord/.test(a.link) ? 1 : 0;
        const bPriority = PRIORITY_DOMAINS.some(domain => b.link.includes(domain)) ? 2 :
            /twitter|x\.com|facebook|instagram|threads|note|blog|tiktok|line|pinterest|linkedin|youtube|discord/.test(b.link) ? 1 : 0;
        return bPriority - aPriority;
    })
        .slice(0, MAX_ARTICLES)
        .map((i) => ({ title: i.title, link: i.link, snippet: i.snippet }));
    console.log("[DEBUG] googleSearch filtered result:", filtered);
    return filtered;
}
export async function fetchPageSummary(url) {
    console.log("[DEBUG] fetchPageSummary called with:", url);
    try {
        const res = await fetch(url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0; +https://github.com/botarhythm/bocchy-discord-bot)'
            }
        });
        if (!res.ok) {
            console.error('[ERROR] fetchPageSummary: HTTPエラー', res.status, url);
            return '';
        }
        const html = await res.text();
        const $ = cheerio.load(html);
        const title = $('title').text();
        const metaDesc = $('meta[name=description]').attr('content') || '';
        const mainText = $('main').text() + $('article').text() + $('section').text();
        const ps = $('p').map((_i, el) => $(el).text()).get().join('\n');
        let text = [title, metaDesc, mainText, ps].filter(Boolean).join('\n');
        if (text.replace(/\s/g, '').length < 50) {
            console.warn('[WARN] fetchPageSummary: 本文が短すぎるため失敗扱い', url);
            return '';
        }
        console.log('[DEBUG] fetchPageSummary 抽出テキスト:', text.slice(0, 300) + (text.length > 300 ? ' ...' : ''));
        return text.trim();
    }
    catch (e) {
        console.error("[ERROR] fetchPageSummary failed:", e, url);
        return '';
    }
}
export function extractUrls(text) {
    const urlRegex = /https?:\/\/[\w\-._~:/?#[\]@!$&'()*+,;=%]+/g;
    return text.match(urlRegex) || [];
}
export async function summarizeSearchResultsWithCharacter(results, query) {
    if (!results.length)
        return 'ごめんね、参考になりそうな情報が見つからなかったよ。';
    const context = results.map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\n${r.link}`).join('\n\n');
    const prompt = `
あなたはDiscordボット「ボッチー」です。以下の検索結果を参考に、質問「${query}」に対してボッチーらしい優しい口調で要点を1～2文で要約し、最後に「参考URL」としてリスト形式で出典URLを必ず添えてください。

【検索結果】
${context}
`;
    return await openaiSummarize(prompt);
}
