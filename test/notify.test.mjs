import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitNoticeBatches,sendLinePush} from '../src/notify.mjs';

test('multiple notices are combined when they fit',()=>{
  assert.deepEqual(splitNoticeBatches(['slot1','slot2']),['slot1\n\nslot2']);
});

test('long lists are split without dropping notices',()=>{
  assert.deepEqual(splitNoticeBatches(['a'.repeat(6),'b'.repeat(6),'c'],12),['a'.repeat(6),'b'.repeat(6)+'\n\nc']);
});

test('LINE push uses a direct recipient and never includes the token in JSON',async()=>{
  let url,options;
  const request=async(u,o)=>{url=u;options=o;return {ok:true,status:200};};
  assert.equal(await sendLinePush({token:'secret-token',userId:'U123',text:'空き枠を検出',request}),true);
  assert.equal(url,'https://api.line.me/v2/bot/message/push');
  assert.equal(options.headers.Authorization,'Bearer secret-token');
  assert.deepEqual(JSON.parse(options.body),{to:'U123',messages:[{type:'text',text:'空き枠を検出'}]});
  assert.ok(!options.body.includes('secret-token'));
});

test('failed delivery rejects and does not expose credentials',async()=>{
  const request=async()=>({ok:false,status:429});
  await assert.rejects(sendLinePush({token:'secret-token',userId:'U123',text:'slot',request}),/HTTP 429/);
});
