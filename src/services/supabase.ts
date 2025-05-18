import pkg from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
const { createClient } = pkg;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  throw new Error('SUPABASE_URLまたはSUPABASE_KEYが設定されていません');
}

export const supabase: SupabaseClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Repositoryパターンの抽象例
export interface AffinityRepository {
  getAffinity(userId: string, guildId: string): Promise<number>;
  updateAffinity(userId: string, guildId: string, userMsg: string): Promise<void>;
}

export const affinityRepository: AffinityRepository = {
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