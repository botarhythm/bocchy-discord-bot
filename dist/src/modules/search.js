import { env, MAX_ARTICLES } from '../../config/index.js';
// ダミー: 実装時は正しいimportに置換
const fetch = async (..._args) => ({ text: async () => '', json: async () => ({ items: [] }) });
const cheerio = {
    load: (_html) => {
        return (_selector) => ({
            slice: () => ({
                map: () => ({
                    get: () => []
                })
            })
        });
    }
};
export async function googleSearch(query) {
    const apiKey = env.GOOGLE_API_KEY;
    const cseId = env.GOOGLE_CSE_ID;
    if (!apiKey || !cseId) {
        console.warn('Google APIキーまたはCSE IDが未設定です');
        return [];
    }
    if (!query) {
        console.warn('検索クエリが空です');
        return [];
    }
    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}` +
        `&q=${encodeURIComponent(query)}&hl=ja&gl=jp&lr=lang_ja&sort=date`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.items || data.items.length === 0) {
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
        .filter((i) => /^https?:\/\//.test(i.link))
        .filter((i) => !EXCLUDE_DOMAINS.some(domain => i.link.includes(domain)))
        .sort((a, b) => {
        const aPriority = PRIORITY_DOMAINS.some(domain => a.link.includes(domain)) ? 2 :
            /twitter|x\.com|facebook|instagram|threads|note|blog|tiktok|line|pinterest|linkedin|youtube|discord/.test(a.link) ? 1 : 0;
        const bPriority = PRIORITY_DOMAINS.some(domain => b.link.includes(domain)) ? 2 :
            /twitter|x\.com|facebook|instagram|threads|note|blog|tiktok|line|pinterest|linkedin|youtube|discord/.test(b.link) ? 1 : 0;
        return bPriority - aPriority;
    })
        .slice(0, MAX_ARTICLES)
        .map((i) => ({ title: i.title, link: i.link, snippet: i.snippet }));
    return filtered;
}
export async function fetchPageSummary(url) {
    try {
        const res = await fetch(url, { timeout: 10000 });
        const html = await res.text();
        const $ = cheerio.load(html);
        let text = $('p').slice(0, 5).map((_i, el) => $(el).text()).get().join('\n');
        return text.trim();
    }
    catch {
        return '';
    }
}
