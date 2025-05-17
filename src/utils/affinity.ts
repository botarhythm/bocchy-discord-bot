import { OpenAI } from 'openai';
import { affinityRepository } from '../services/supabase';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function getAffinity(userId: string, guildId: string): Promise<number> {
  return affinityRepository.getAffinity(userId, guildId);
}

export async function updateAffinity(userId: string, guildId: string, userMsg: string): Promise<void> {
  return affinityRepository.updateAffinity(userId, guildId, userMsg);
} 