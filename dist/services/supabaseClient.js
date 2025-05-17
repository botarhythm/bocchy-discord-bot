import { createClient } from '@supabase/supabase-js';
let supabase = null;
/**
 * Supabaseクライアントを初期化し、設定更新を購読するよ🍃
 * @param {object} settings - bot設定オブジェクト
 * @returns {import('@supabase/supabase-js').SupabaseClient | null}
 */
export function initSupabase(settings) {
    const SUPABASE_AUTO_MIGRATION = process.env.SUPABASE_AUTO_MIGRATION !== 'false';
    if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY && SUPABASE_AUTO_MIGRATION) {
        try {
            supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
            supabase
                .channel('custom-all-channel')
                .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'bot_settings' }, (payload) => {
                const { key, value } = payload.new;
                if (key === 'INTERVENTION_QUERIES') {
                    settings.INTERVENTION_QUERIES = value.split(',').map((q) => q.trim());
                }
                else if (key === 'INTERVENTION_LEVEL') {
                    settings.INTERVENTION_LEVEL = parseInt(value) || settings.INTERVENTION_LEVEL;
                }
                else {
                    settings[key] = value;
                }
                console.log(`Supabase設定が更新されました: ${key} = ${value}`);
            })
                .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    console.log('Supabase連携が有効です');
                }
            });
        }
        catch (e) {
            console.warn('Supabase連携に失敗しました。環境変数のみで動作します。', e);
        }
    }
    else {
        console.log('Supabase連携なし。環境変数のみで動作します。');
    }
    return supabase;
}
