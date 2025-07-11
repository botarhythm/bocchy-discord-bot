import { Message, Client, ChannelType } from 'discord.js';

type Flags = { search: boolean; intervention: boolean };

export function detectFlags(message: Message, client: Client): Flags {
  const flags: Flags = { search: false, intervention: false };
  // 検索フラグ
  const searchRegexes = [
    /\?\?\s*(.+)/i,
    /検索(して|する|したい|お願いします| )?.+/i,
    /search( |for)? .+/i,
    /webで調べて.+/i,
    /ウェブで調べて.+/i,
    /ニュース/i,
    /最新/i,
    /調べて/i,
    /教えて/i,
    /について(教えて|知りたい|調べて)/i,
    /.+(とは|って何|ってなに|何ですか|なにそれ|どんなもの)/i,
    /[？?]$/,
    /検索/i
  ];
  if (searchRegexes.some(r => r.test(message.content))) {
    flags.search = true;
  }
  // 介入フラグ（DMは常にtrue、またはメンション or サーバーチャンネル）
  const isDM = message.channel.type === ChannelType.DM;
  const isMention = client.user ? message.mentions.has(client.user) : false;
  if (!message.guild || isDM || isMention || (message.guild && !isDM)) {
    flags.intervention = true;
  }
  return flags;
} 