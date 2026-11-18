import test from 'node:test';
import assert from 'node:assert/strict';
import {sumidaNotifications,bunkyoNotifications,novelSlots,slotKey,addMonths,dayOfWeek,formatNotice} from '../src/slots.mjs';

test('別面をまたぐ18–20を2時間枠として認識する', () => {
  const out=sumidaNotifications([{date:'2026-11-25',court:'Ａ面',hour:18},{date:'2026-11-25',court:'Ｂ面',hour:19}]);
  assert.ok(out.some(x=>x.from===18&&x.to===20&&x.courts.join()==='Ａ面,Ｂ面'));
});
test('別面をまたぐ19–21を認識し2時間枠を先に表示する', () => {
  const out=sumidaNotifications([{date:'2026-11-25',court:'Ｃ面',hour:19},{date:'2026-11-25',court:'Ｄ面',hour:20}]);
  assert.deepEqual([out[0].from,out[0].to,out[0].courts],[19,21,['Ｃ面','Ｄ面']]);
});
test('18–19単独は通知しない', () => assert.deepEqual(sumidaNotifications([{date:'2026-12-01',court:'Ａ面',hour:18}]),[]));
test('19–20と20–21は単独でも通知する', () => {
  const out=sumidaNotifications([{date:'2026-12-01',court:'Ａ面',hour:19},{date:'2026-12-02',court:'Ｂ面',hour:20}]);
  assert.deepEqual(out.map(x=>[x.date,x.from,x.to]),[['2026-12-01',19,20],['2026-12-02',20,21]]);
});
test('2時間成立時に内包する1時間の通知を重複させない',()=>{
  const out=sumidaNotifications([{date:'2026-12-01',court:'Ａ面',hour:19},{date:'2026-12-01',court:'Ｂ面',hour:20}]);
  assert.equal(out.length,1);
  assert.deepEqual([out[0].from,out[0].to],[19,21]);
});
test('同一枠の通知を抑制、消滅後の再出現は再通知可', () => {
  const items=bunkyoNotifications([{date:'2026-11-30',court:'第１コート'}]);
  assert.equal(novelSlots(items,[slotKey(items[0])]).length,0);
  assert.equal(novelSlots(items,[]).length,1);
});
test('月またぎ、うるう年、曜日と文面', () => {
  assert.equal(addMonths('2026-11-17',2),'2027-01-17');
  assert.equal(addMonths('2028-01-31',1),'2028-02-29');
  assert.equal(dayOfWeek('2026-11-25'),'水');
  assert.match(formatNotice({site:'sumida',date:'2026-11-25',from:18,to:20,courts:['Ａ面','Ｂ面']},'2026-11-17 19:00 JST'),/Ａ面／19:00～20:00 Ｂ面/);
});
