// このファイルはアーカイブ用です。現行コードでは使用されていません。
/**
 * DM からでも「ユーザーが所属する最初の guildId 」を取得するユーティリティ
 * 必要 Intents: Guilds, GuildMembers
 */
export async function resolveGuildId(client, userId) {
    for (const guild of client.guilds.cache.values()) {
        try {
            // メンバー取得 (cache → REST フォールバック) ※force=false で負荷軽減
            const member = await guild.members.fetch({ user: userId, force: false });
            if (member)
                return guild.id; // 見つかったら即 return
        }
        catch (_) { /* 404 (= not a member) は無視 */ }
    }
    return null; // どのサーバーにも所属していない
}
