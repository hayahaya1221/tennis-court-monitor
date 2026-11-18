/** Pure booking decisions. Only confirmed, first-come-eligible slots are input. */
export const MATCH_URLS = Object.freeze({
  bunkyo: 'https://www.shisetsu.city.bunkyo.lg.jp/user/Home',
  sumida: 'https://yoyaku03.city.sumida.lg.jp/user/Home',
});

export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(iso, months) {
  const [year, month, day] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const monthLast = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, monthLast));
  return target.toISOString().slice(0, 10);
}

export function dayOfWeek(iso) {
  return '日月火水木金土'[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}

export function japanNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { date: `${map.year}-${map.month}-${map.day}`, time: `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second} JST` };
}

/**
 * Input: [{date:'YYYY-MM-DD', court:'Ａ面', hour:18|19|20}].
 * 18:00–19:00 alone is never a qualifying result. Deduplicated 2h blocks first.
 */
export function sumidaNotifications(slots) {
  const dates = new Map();
  for (const { date, court, hour } of slots) {
    if (![18, 19, 20].includes(hour)) continue;
    if (!dates.has(date)) dates.set(date, new Map());
    const hours = dates.get(date);
    if (!hours.has(hour)) hours.set(hour, new Set());
    hours.get(hour).add(court);
  }
  const output = [];
  for (const [date, hours] of dates) {
    const c18 = [...(hours.get(18) ?? [])].sort();
    const c19 = [...(hours.get(19) ?? [])].sort();
    const c20 = [...(hours.get(20) ?? [])].sort();
    if (c18.length && c19.length) {
      for (const first of c18) for (const second of c19) {
        output.push({site:'sumida',date,from:18,to:20,courts:[first,second]});
      }
    }
    if (c19.length && c20.length) {
      for (const first of c19) for (const second of c20) {
        output.push({site:'sumida',date,from:19,to:21,courts:[first,second]});
      }
    }
    // A 1h option already contained in a 2h option is redundant.
    if (!c18.length && !c20.length) for (const court of c19)
      output.push({site:'sumida',date,from:19,to:20,courts:[court]});
    if (!c19.length) for (const court of c20)
      output.push({site:'sumida',date,from:20,to:21,courts:[court]});
  }
  return output.sort((a,b) => a.date.localeCompare(b.date) || (b.to-b.from)-(a.to-a.from) || a.from-b.from || a.courts.join().localeCompare(b.courts.join()));
}

export function bunkyoNotifications(slots) {
  return slots.map(({date,court}) => ({site:'bunkyo',date,from:18,to:21,courts:[court]}))
    .sort((a,b) => a.date.localeCompare(b.date) || a.courts[0].localeCompare(b.courts[0]));
}

export function slotKey(x) { return `${x.site}|${x.date}|${x.from}-${x.to}|${x.courts.join('+')}`; }

export function novelSlots(current, previousKeys) {
  const old = new Set(previousKeys);
  return current.filter(x => !old.has(slotKey(x)));
}

export function formatNotice(slot, timestamp) {
  const title = slot.site === 'bunkyo' ? '竹早テニスコート' : '錦糸公園テニスコート';
  const court = slot.courts.length === 1 ? slot.courts[0]
    : slot.courts[0] === slot.courts[1] ? `${slot.courts[0]}（2時間連続）`
    : `${slot.from}:00～${slot.from + 1}:00 ${slot.courts[0]}／${slot.from + 1}:00～${slot.to}:00 ${slot.courts[1]}`;
  return `【夜間空き】${title}\n${slot.date}（${dayOfWeek(slot.date)}）${slot.from}:00～${slot.to}:00\nコート：${court}\n確認：${timestamp}\n予約：https://${new URL(MATCH_URLS[slot.site]).host}/user/Home`;
}
