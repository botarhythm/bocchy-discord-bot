// このファイルはアーカイブ用です。現行コードでは使用されていません。
export function getNowJST() {
    // 日本時間の現在日時を返すよ🍃
    return new Date(new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
}
export function greetingJp(date) {
    // 時間帯ごとの日本語挨拶を返すよ🌸
    const h = date.getHours();
    if (h < 4)
        return 'こんばんは';
    if (h < 11)
        return 'おはようございます';
    if (h < 18)
        return 'こんにちは';
    return 'こんばんは';
}
export function getTodayDate() {
    // 日本時間の今日の日付文字列(YYYY/MM/DD)を返すよ🍀
    return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).split(' ')[0];
}
