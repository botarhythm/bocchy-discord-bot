export const LONG_WINDOW = 50; // 🧠 森の奥にそっとしまっておく長い記憶
export const SUMMARY_AT = 40; // ✨ たくさん話したら、まとめて森の記憶にするよ

export const BOT_CHAT_CHANNEL = process.env.BOT_CHAT_CHANNEL_ID || '1364622450918424576';
export const MAX_ACTIVE_TURNS = parseInt(process.env.MAX_ACTIVE_TURNS || '3', 10);
export const MAX_BOT_CONVO_TURNS = parseInt(process.env.MAX_BOT_CONVO_TURNS || '4', 10);
export const MAX_DAILY_RESPONSES = parseInt(process.env.MAX_DAILY_RESPONSES || '20', 10);
export const RESPONSE_WINDOW_START = parseInt(process.env.RESPONSE_WINDOW_START || '17', 10);
export const RESPONSE_WINDOW_END = parseInt(process.env.RESPONSE_WINDOW_END || '22', 10);
export const EMERGENCY_STOP = process.env.EMERGENCY_STOP === 'true'; 