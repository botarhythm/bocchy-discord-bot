import { SUMMARY_AT, LONG_WINDOW } from '../config/index.js';
// ダミー: 実装時は正しい型・importに置換
const buildCharacterPrompt = () => '';
const llmRespond = async () => '';
export async function getUserHistory(supabase, userId, channelId) {
    const { data } = await supabase
        .from('conversation_histories')
        .select('messages')
        .eq('user_id', userId)
        .eq('channel_id', channelId)
        .maybeSingle();
    return data?.messages || [];
}
export async function saveUserHistory(_supabase, _userId, _channelId, _history) {
    // 未使用: saveHistoryを利用
}
export async function getGuildHistory(supabase, guildId) {
    const { data } = await supabase
        .from('conversation_histories')
        .select('messages')
        .eq('guild_id', guildId)
        .is('channel_id', null)
        .maybeSingle();
    return data?.messages || [];
}
export async function saveGuildHistory(_supabase, _guildId, _history) {
    // 未使用: saveHistoryを利用
}
export async function saveHistory(supabase, message, // Discord.js Message型に後で置換
userPrompt, botReply, affinity) {
    const channelId = message.guild ? message.channel.id : 'DM';
    const guildId = message.guild ? message.guild.id : null;
    // 1. チャンネル単位の保存
    const { data } = await supabase
        .from('conversation_histories')
        .select('id, messages')
        .eq('user_id', message.author.id)
        .eq('channel_id', channelId)
        .maybeSingle();
    let messages = data?.messages || [];
    messages.push({ user: userPrompt, bot: botReply, ts: new Date().toISOString() });
    if (messages.length >= SUMMARY_AT) {
        const summaryPrompt = messages.map((m) => `ユーザー: ${m.user}\nBot: ${m.bot}`).join('\n');
        const summary = await llmRespond(summaryPrompt, 'あなたはアーカイブ要約AIです。上の対話を150文字以内で日本語要約し、重要語に 🔑 を付けてください。', message, [], buildCharacterPrompt(message, affinity));
        await supabase.from('conversation_summaries').insert({
            user_id: message.author.id,
            channel_id: channelId,
            guild_id: guildId,
            summary,
            created_at: new Date().toISOString(),
        });
        messages = messages.slice(-LONG_WINDOW);
    }
    if (data?.id) {
        await supabase
            .from('conversation_histories')
            .update({ messages, updated_at: new Date().toISOString() })
            .eq('id', data.id);
    }
    else {
        await supabase
            .from('conversation_histories')
            .insert({
            user_id: message.author.id,
            channel_id: channelId,
            guild_id: guildId,
            messages,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        });
    }
    // 2. サーバー全体（guild_id単位）でも保存
    if (guildId) {
        try {
            const { data: gdata } = await supabase
                .from('conversation_histories')
                .select('id, messages')
                .eq('guild_id', guildId)
                .is('channel_id', null)
                .maybeSingle();
            let gmessages = gdata?.messages || [];
            gmessages.push({ user: userPrompt, bot: botReply, ts: new Date().toISOString() });
            if (gdata?.id) {
                const MAX_MSG = 3000;
                gmessages = gmessages.map((m) => ({ ...m, user: m.user.slice(0, MAX_MSG), bot: m.bot.slice(0, MAX_MSG) }));
                await supabase
                    .from('conversation_histories')
                    .update({ messages: gmessages, updated_at: new Date().toISOString() })
                    .eq('id', gdata.id);
            }
            else {
                const MAX_MSG = 3000;
                gmessages = gmessages.map((m) => ({ ...m, user: m.user.slice(0, MAX_MSG), bot: m.bot.slice(0, MAX_MSG) }));
                await supabase
                    .from('conversation_histories')
                    .insert({
                    guild_id: guildId,
                    user_id: message.author.id,
                    channel_id: null,
                    messages: gmessages,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                });
            }
            if (gmessages.length >= SUMMARY_AT) {
                const gsummaryPrompt = gmessages.map((m) => `ユーザー: ${m.user}\nBot: ${m.bot}`).join('\n');
                const gsummary = await llmRespond(gsummaryPrompt, 'あなたはアーカイブ要約AIです。上の対話を150文字以内で日本語要約し、重要語に 🔑 を付けてください。', message, [], buildCharacterPrompt(message, affinity));
                await supabase.from('conversation_summaries').insert({
                    guild_id: guildId,
                    channel_id: null,
                    summary: gsummary,
                    created_at: new Date().toISOString(),
                });
                gmessages = gmessages.slice(-LONG_WINDOW);
                await supabase
                    .from('conversation_histories')
                    .update({ messages: gmessages, updated_at: new Date().toISOString() })
                    .eq('guild_id', guildId)
                    .is('channel_id', null);
            }
        }
        catch (e) {
            // エラーはログのみ
            console.error('[saveHistory][guild save ERROR]', { guildId, error: e });
        }
    }
}
