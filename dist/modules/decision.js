import { INTERVENTION_LEVEL } from '../config/index.js';
// ダミー: 実装時は正しい型・importに置換
const openai = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{}' } }] }) } } };
const buildHistoryText = (_messages, _n) => '';
const logInterventionDecision = (..._args) => { };
export async function shouldInterveneWithContinuation(messages, lastIntervention) {
    const historyText = buildHistoryText(messages, 20);
    const prompt = `以下はDiscordチャンネルの直近の会話履歴です。\n` +
        (lastIntervention ? `直前のボットの介入メッセージ:\n${lastIntervention}\n` : '') +
        `この場の「盛り上がり度（1-10）」「沈黙状態か」「困っている人がいるか」「話題の転換があったか」を判定してください。\n` +
        `また、直前のボット介入があれば「その話題が継続しているか」も判定してください。\n` +
        `【重要】以下の条件を必ず守ってください：\n` +
        `- 基本的にボットは沈黙や静かな時には介入しません。\n` +
        `- 盛り上がり度が2以下かつ「困っている人が明示的にいる」場合のみ介入してください。\n` +
        `- それ以外は介入せず、会話を静かに見守ってください。\n` +
        `- 介入例は「本当に必要な場合のみ」出力してください。\n` +
        `JSON形式で以下のキーで返答してください: { intervene: boolean, continued: boolean, reason: string, example: string }\n履歴:\n${historyText}`;
    console.log('[DEBUG] shouldInterveneWithContinuation prompt:', prompt);
    let res;
    try {
        res = await openai.chat.completions.create({
            model: 'gpt-4.1-nano-2025-04-14',
            messages: [{ role: 'system', content: prompt }],
        });
        console.log('[DEBUG] shouldInterveneWithContinuation raw response:', res);
        const parsed = JSON.parse(res.choices[0].message.content);
        console.log('[DEBUG] shouldInterveneWithContinuation parsed:', parsed);
        return parsed;
    }
    catch (e) {
        console.error('[ERROR] shouldInterveneWithContinuation パース失敗:', e, res?.choices?.[0]?.message?.content);
        return { intervene: false, continued: false, reason: 'パース失敗', example: res?.choices?.[0]?.message?.content?.trim() || '' };
    }
}
export function shouldInterveneStrict(message, context = {}) {
    // 1. 明示的トリガー
    if (/ボッチー|Bocchy/i.test(message.content)) {
        logInterventionDecision('explicit_trigger', message.content);
        console.log('[DEBUG] shouldInterveneStrict: 明示的トリガー', message.content);
        return true;
    }
    // 2. AI判定
    if (context.aiInterventionResult && context.aiInterventionResult.intervene) {
        logInterventionDecision('ai_context', message.content);
        console.log('[DEBUG] shouldInterveneStrict: AI判定', context.aiInterventionResult);
        return true;
    }
    // 3. 確率判定
    const level = INTERVENTION_LEVEL ?? 2;
    const result = Math.random() < level / 10;
    logInterventionDecision('probability', message.content, { level, result });
    console.log('[DEBUG] shouldInterveneStrict: 確率判定', { level, result });
    return result;
}
