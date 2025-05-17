// import { compose, PipelineContext, PipelineMiddleware } from './pipeline';
import { saveHistory, getUserHistory } from '../modules/history.js';
import { googleSearch, summarizeSearchResultsWithCharacter, extractUrls, fetchPageSummary } from '../modules/search.js';
import { llmRespond, openaiSummarize } from '../modules/ai.js';
import { OpenAI } from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
export function compose(middlewares) {
    return async function (ctx) {
        let index = -1;
        async function dispatch(i) {
            if (i <= index)
                throw new Error('next() called multiple times');
            index = i;
            const fn = middlewares[i];
            if (fn) {
                await fn(ctx, () => dispatch(i + 1));
            }
        }
        await dispatch(0);
    };
}
// パイプラインのエントリポイント
// export async function runPipeline(ctx: PipelineContext) {
//   // 実装は後で
// }
// パイプラインミドルウェア例
const llmOnlyMiddleware = async (ctx, next) => {
    if (ctx.action !== 'llm_only')
        return next();
    // 履歴取得例
    const history = await getUserHistory(ctx.supabase, ctx.message.author.id, ctx.message.channel.id);
    const reply = await llmRespond(ctx.message.content, '', ctx.message, history);
    await ctx.message.reply(reply);
    await saveHistory(ctx.supabase, ctx.message, ctx.message.content, reply, ctx.affinity ?? 0);
};
const searchOnlyMiddleware = async (ctx, next) => {
    if (ctx.action !== 'search_only')
        return next();
    console.log("[DEBUG] Pipeline: Google検索開始:", ctx.message.content);
    try {
        const results = await googleSearch(ctx.message.content);
        console.log("[DEBUG] Pipeline: Google検索結果:", results);
        const summary = results.map(r => `${r.title}\n${r.link}`).join('\n');
        await ctx.message.reply(summary);
        await saveHistory(ctx.supabase, ctx.message, ctx.message.content, summary, ctx.affinity ?? 0);
        console.log("[DEBUG] Pipeline: Google検索応答・履歴保存完了");
    }
    catch (e) {
        console.error("[ERROR] Pipeline: Google検索処理失敗:", e);
        await ctx.message.reply('検索中にエラーが発生しました。');
    }
};
const combinedMiddleware = async (ctx, next) => {
    if (ctx.action !== 'combined')
        return next();
    console.log("[DEBUG] Pipeline: combinedMiddleware開始:", ctx.message.content);
    try {
        // 1. メッセージ内のURLを抽出し、あれば必ずfetchPageSummary→AI要約
        const urls = extractUrls(ctx.message.content);
        if (urls.length > 0) {
            console.log('[DEBUG] combinedMiddleware: メッセージ内URL検出:', urls);
            const pageText = await fetchPageSummary(urls[0]);
            if (pageText && pageText.length > 50) {
                // 本文が長すぎる場合は冒頭3000字までを要約対象に
                const clippedText = pageText.length > 3000 ? pageText.slice(0, 3000) : pageText;
                const prompt = `あなたはDiscordボット「ボッチー」です。以下のWebページ本文（実際にクロールして取得した内容）を読み、やさしい日本語で1～2文に要約してください。創作せず、本文に基づいて要約してください。\n\n【Webページ本文】\n${clippedText}`;
                const summary = await openaiSummarize(prompt);
                await ctx.message.reply(summary);
                await saveHistory(ctx.supabase, ctx.message, ctx.message.content, summary, ctx.affinity ?? 0);
                console.log('[DEBUG] Pipeline: URL要約応答・履歴保存完了');
                return;
            }
            else {
                await ctx.message.reply('ごめんね、ページ本文の取得に失敗しちゃったみたい。');
                return;
            }
        }
        // 2. URLがなければAIで「検索が必要か」判定
        const searchIntentPrompt = `次のユーザー発言は、インターネット検索やWebページ参照が必要な内容ですか？必要ならtrue、不要ならfalseだけを返してください。\n発言: 「${ctx.message.content}」`;
        const intentRes = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o',
            messages: [
                { role: 'system', content: 'あなたは検索アシスタントです。' },
                { role: 'user', content: searchIntentPrompt }
            ],
            max_tokens: 10,
            temperature: 0,
        });
        const needsSearch = intentRes.choices?.[0]?.message?.content?.toLowerCase().includes('true');
        console.log('[DEBUG] combinedMiddleware: needsSearch(AI判定):', needsSearch);
        if (needsSearch) {
            const results = await googleSearch(ctx.message.content);
            console.log("[DEBUG] Pipeline: combinedモードAI判定Google検索結果:", results);
            const summary = await summarizeSearchResultsWithCharacter(results, ctx.message.content);
            await ctx.message.reply(summary);
            await saveHistory(ctx.supabase, ctx.message, ctx.message.content, summary, ctx.affinity ?? 0);
            console.log("[DEBUG] Pipeline: combinedモードAI判定Google検索応答・履歴保存完了");
            return;
        }
        // 3. それ以外は通常のAIチャット応答
        const reply = await llmRespond(ctx.message.content, '', ctx.message, []);
        await ctx.message.reply(reply);
        await saveHistory(ctx.supabase, ctx.message, ctx.message.content, reply, ctx.affinity ?? 0);
        console.log('[DEBUG] Pipeline: combinedモード通常AI応答・履歴保存完了');
    }
    catch (e) {
        console.error("[ERROR] Pipeline: combinedMiddleware処理失敗:", e);
        await ctx.message.reply('combinedモードでエラーが発生しました。');
    }
};
export const bocchyPipeline = compose([
    llmOnlyMiddleware,
    searchOnlyMiddleware,
    combinedMiddleware,
]);
// エントリポイント
// export async function runPipeline(ctx: PipelineContext) {
//   await bocchyPipeline(ctx);
// }
export default bocchyPipeline;
