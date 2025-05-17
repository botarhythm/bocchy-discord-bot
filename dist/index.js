import { Client, GatewayIntentBits, Partials } from "discord.js";
import dotenv from "dotenv";
import { detectFlags } from "./flag-detector.js";
import { pickAction } from "./decision-engine.js";
import bocchyPipeline from './core/pipeline.js';
import { initSupabase } from './services/supabaseClient.js';
import http from 'http';
import { BOT_CHAT_CHANNEL, RESPONSE_WINDOW_START, RESPONSE_WINDOW_END, EMERGENCY_STOP } from './config/index.js';
dotenv.config();
process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
    if (reason && reason.stack) {
        console.error('[STACK TRACE]', reason.stack);
    }
    console.error('[DEBUG:ENV]', {
        NODE_ENV: process.env.NODE_ENV,
        BOT_ENABLED: process.env.BOT_ENABLED,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '***' : undefined,
        GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ? '***' : undefined,
        GOOGLE_CSE_ID: process.env.GOOGLE_CSE_ID ? '***' : undefined,
        RAILWAY_ENV: process.env.RAILWAY_ENV,
        argv: process.argv,
        cwd: process.cwd(),
        version: process.version
    });
});
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err);
    if (err && err.stack) {
        console.error('[STACK TRACE]', err.stack);
    }
    console.error('[DEBUG:ENV]', {
        NODE_ENV: process.env.NODE_ENV,
        BOT_ENABLED: process.env.BOT_ENABLED,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '***' : undefined,
        GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ? '***' : undefined,
        GOOGLE_CSE_ID: process.env.GOOGLE_CSE_ID ? '***' : undefined,
        RAILWAY_ENV: process.env.RAILWAY_ENV,
        argv: process.argv,
        cwd: process.cwd(),
        version: process.version
    });
});
if (process.env.BOT_ENABLED !== "true") {
    console.log("🚫 Bocchy bot is disabled by .env");
    process.exit(0);
}
if (EMERGENCY_STOP) {
    console.log("🚨 EMERGENCY_STOPが有効化されています。ボットを完全停止します。");
    process.exit(0);
}
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel]
});
client.once("ready", () => {
    console.log(`✅ Bocchy bot started as ${client.user?.tag}`);
});
let settings = {
    INTERVENTION_LEVEL: parseInt(process.env.INTERVENTION_LEVEL || '4'),
    INTERVENTION_QUERIES: process.env.INTERVENTION_QUERIES
        ? process.env.INTERVENTION_QUERIES.split(',').map(q => q.trim())
        : ["ニュース", "最新", "困った", "教えて"]
};
let supabase = initSupabase(settings);
function getNowJST() {
    return new Date(new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
}
let botConvoState = new Map();
let botSilenceUntil = null;
function getTodayDate() {
    return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).split(' ')[0];
}
client.on("messageCreate", async (message) => {
    const isBot = message.author.bot;
    const isHuman = !isBot;
    const botId = message.author.id;
    const channelId = message.channel?.id;
    if (!message.guild) {
        if (message.author.id === client.user?.id)
            return;
        const flags = detectFlags(message, client);
        const action = pickAction(flags);
        try {
            await bocchyPipeline({ message, flags, supabase, action });
        }
        catch (err) {
            console.error('[DM応答エラー]', err);
            await message.reply('エラーが発生しました。管理者にご連絡ください。');
        }
        return;
    }
    if (botSilenceUntil && message.mentions.has(client.user)) {
        if (Date.now() < botSilenceUntil) {
            botSilenceUntil = null;
            await message.reply('森から帰ってきたよ🌲✨');
            return;
        }
    }
    if (botSilenceUntil && Date.now() < botSilenceUntil)
        return;
    if (/静かに/.test(message.content)) {
        botSilenceUntil = Date.now() + 10 * 60 * 1000;
        await message.reply('10分間森へ遊びに行ってきます…🌲');
        return;
    }
    if (isHuman) {
        const flags = detectFlags(message, client);
        const action = pickAction(flags);
        try {
            await bocchyPipeline({ message, flags, supabase, action });
        }
        catch (err) {
            console.error('[人間応答エラー]', err);
            await message.reply('エラーが発生しました。管理者にご連絡ください。');
        }
        botConvoState.clear();
        return;
    }
    if (isBot && channelId === BOT_CHAT_CHANNEL && botId !== client.user?.id) {
        const hour = getNowJST().getHours();
        if (hour < RESPONSE_WINDOW_START || hour >= RESPONSE_WINDOW_END) {
            console.log(`[b2b制限] 時間外: hour=${hour}`);
            return;
        }
        let state = botConvoState.get(botId) || { turns: 0, dailyCount: 0, lastResetDate: getTodayDate() };
        if (state.lastResetDate !== getTodayDate()) {
            state.turns = 0;
            state.dailyCount = 0;
            state.lastResetDate = getTodayDate();
        }
        if (state.turns >= 2) {
            console.log(`[b2b制限] ターン上限: botId=${botId}, turns=${state.turns}`);
            return;
        }
        if (state.dailyCount >= 10) {
            console.log(`[b2b制限] 日次上限: botId=${botId}, dailyCount=${state.dailyCount}`);
            return;
        }
        const flags = detectFlags(message, client);
        const action = pickAction(flags);
        try {
            await bocchyPipeline({ message, flags, supabase, action });
        }
        catch (err) {
            console.error('[ボット同士応答エラー]', err);
        }
        state.turns++;
        state.dailyCount++;
        botConvoState.set(botId, state);
        console.log(`[b2b進行] botId=${botId}, turns=${state.turns}, dailyCount=${state.dailyCount}, hour=${hour}`);
        return;
    }
    return;
});
client.login(process.env.DISCORD_TOKEN);
setInterval(() => { }, 10000);
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
    }
    else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    }
}).listen(port, () => {
    console.log(`[HealthCheck] HTTPサーバー起動: ポート${port}`);
});
