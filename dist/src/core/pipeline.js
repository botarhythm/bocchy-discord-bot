import { compose } from './pipeline.ts';
import { saveHistory, getUserHistory } from '../modules/history.js';
import { shouldInterveneWithContinuation, shouldInterveneStrict } from '../modules/decision.js';
import { googleSearch } from '../modules/search.js';
import { llmRespond } from '../modules/ai.js';
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
    const results = await googleSearch(ctx.message.content);
    const summary = results.map(r => `${r.title}\n${r.link}`).join('\n');
    await ctx.message.reply(summary);
    await saveHistory(ctx.supabase, ctx.message, ctx.message.content, summary, ctx.affinity ?? 0);
};
const combinedMiddleware = async (ctx, next) => {
    if (ctx.action !== 'combined')
        return next();
    // 介入判定例
    const history = await getUserHistory(ctx.supabase, ctx.message.author.id, ctx.message.channel.id);
    const aiResult = await shouldInterveneWithContinuation(history);
    const intervene = shouldInterveneStrict(ctx.message, { aiInterventionResult: aiResult });
    if (!intervene)
        return;
    const reply = aiResult.example || 'こんにちは、ボッチーです。何かお困りですか？';
    await ctx.message.reply(reply);
    await saveHistory(ctx.supabase, ctx.message, ctx.message.content, reply, ctx.affinity ?? 0);
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
