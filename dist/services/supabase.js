import { createClient } from '@supabase/supabase-js';
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    throw new Error('SUPABASE_URLまたはSUPABASE_KEYが設定されていません');
}
export const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
export const affinityRepository = {
    async getAffinity(userId, guildId) {
        const { data } = await supabase
            .from('affinity')
            .select('score')
            .eq('user_id', userId)
            .eq('guild_id', guildId)
            .single();
        return data?.score ?? 0;
    },
    async updateAffinity(userId, guildId, userMsg) {
        await supabase.rpc('adjust_affinity', { user_id: userId, guild_id: guildId, user_msg: userMsg });
    }
};
