
function extractUrls(text: string): string[] {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) || [];
}

// --- 追加: 「静かに」コマンド多重応答防止用 ---
const lastSilenceCommand = new Map<string, number>();

// --- イベント多重登録防止 ---
client.removeAllListeners('messageCreate');

// bocchy-character.yamlのテンプレートを読み込み
let bocchyConfig: any = {};
try {
  bocchyConfig = yaml.load(fs.readFileSync('bocchy-character.yaml', 'utf8'));
} catch (e) {
  console.warn('[bocchy-character.yaml読み込み失敗]', e);
  bocchyConfig = {};
}

function isSelfIntroductionRequest(text: string): boolean {
  return /自己紹介|どんなAI|あなたは誰|自己PR/.test(text);
}
function isTechnicalFeatureRequest(text: string): boolean {
  return /技術的特徴|技術仕様|技術的な説明|中身|仕組み|どうやって動いてる/.test(text);
}

function isTwilightTime(): boolean {
  const now = getNowJST();
  const hour = now.getHours();
  return hour >= 17 && hour < 22;
}

// --- トワイライトタイム外通知: 1時間に1回/チャンネル ---
const lastTwilightNotice = new Map<string, number>(); // channelId => timestamp(ms)

client.on("messageCreate", async (message) => {
  // --- Bot自身の発言には絶対に反応しない ---
  if (client.user && message.author.id === client.user.id) return;

  // --- トワイライトタイム外は応答しない（自己紹介・技術説明のみ許可） ---
  // 人間ユーザーにはトワイライトタイム判定を一切適用しない
  const isBot = message.author.bot;
  const channelId = message.channel?.id;
  const BOT_HARAPPA_ID = '1364622450918424576';
  if (isBot && client.user && message.author.id !== client.user.id) {
    // ボット同士の会話は「ボット原っぱ」では常時許可、それ以外はトワイライトタイムのみ許可
    if (channelId !== BOT_HARAPPA_ID && !isTwilightTime()) {
      // --- 1時間に1回だけ通知 ---
      const now = Date.now();
      const lastNotice = lastTwilightNotice.get(channelId) || 0;
      if (now - lastNotice > 60 * 60 * 1000) {
        await message.reply('今はトワイライトタイム（17時～22時）ではないのでボットには返答しません。');
        lastTwilightNotice.set(channelId, now);
      }
      return;
    }
    // --- 回数制限 ---
    let state = botConvoState.get(message.author.id) || { turns: 0, dailyCount: 0, lastResetDate: getTodayDate() };
    if (state.lastResetDate !== getTodayDate()) {
      state.turns = 0;
      state.dailyCount = 0;
      state.lastResetDate = getTodayDate();
    }
    if (state.turns >= 2) {
      console.log(`[b2b制限] ターン上限: botId=${message.author.id}, turns=${state.turns}`);
      return;
    }
    if (state.dailyCount >= 10) {
      console.log(`[b2b制限] 日次上限: botId=${message.author.id}, dailyCount=${state.dailyCount}`);
      return;
    }
    const flags = detectFlags(message, client);
    const action = pickAction(flags);
    if (!action) return;
    try {
      await runPipeline(action, { message, flags, supabase });
    } catch (err) {
      console.error('[ボット同士応答エラー]', err);
    }
    state.turns++;
    state.dailyCount++;
    botConvoState.set(message.author.id, state);
    console.log(`[b2b進行] botId=${message.author.id}, turns=${state.turns}, dailyCount=${state.dailyCount}, hour=${getNowJST().getHours()}`);
    return;
  }
// ... 既存のコード ...