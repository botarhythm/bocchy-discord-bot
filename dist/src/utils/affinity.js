import { OpenAI } from 'openai';
import { affinityRepository } from '../services/supabase';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
export async function getAffinity(userId, guildId) {
    return affinityRepository.getAffinity(userId, guildId);
}
export async function updateAffinity(userId, guildId, userMsg) {
    return affinityRepository.updateAffinity(userId, guildId, userMsg);
}
