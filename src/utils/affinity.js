import { OpenAI } from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function getAffinity(supabase, userId, guildId) {
  const { data } = await supabase
    .from('user_affinity')
    .select('affinity')
    .eq('user_id', userId)
    .eq('guild_id', guildId)
    .maybeSingle();
  return data?.affinity ?? 0;
}

export async function updateAffinity(supabase, userId, guildId, userMsg) {
  const { choices } = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Classify sentiment: positive, neutral or negative.' },
      { role: 'user', content: userMsg }
    ]
  });
  const label = choices[0].message.content.trim().toLowerCase();
  const delta = label === 'positive' ? 0.2 : label === 'negative' ? -0.2 : 0;
  await supabase.rpc('adjust_affinity', {
    p_user_id: userId,
    p_guild_id: guildId,
    p_delta: delta
  });
} 