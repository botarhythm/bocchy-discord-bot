// search/interventionフラグ検出
export function detectFlags(message, client) {
  const flags = { search: false, intervention: false };
  // 検索フラグ
  const searchRegexes = [
    /\?\?\s*(.+)/i,
    /検索(して|する|したい|お願いします| )?.+/i,
    /search( |for)? .+/i,
    /webで調べて.+/i,
    /ウェブで調べて.+/i,
    /ニュース/i,
    /最新/i
  ];
  if (searchRegexes.some(r => r.test(message.content))) {
    flags.search = true;
  }
  // 介入フラグ（DMは常にtrue、またはメンション or サーバーチャンネル）
  if (!message.guild || message.channel.type === 'DM' || message.mentions.has(client.user) || (message.guild && message.channel.type !== 'DM')) {
    flags.intervention = true;
  }
  return flags;
} 