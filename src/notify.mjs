/** Group several slot reports into as few LINE messages as practical. */
export function splitNoticeBatches(notices, maxChars=4500){
  const batches=[];
  let current='';
  for(const notice of notices){
    if(notice.length>maxChars)throw new Error('通知文がLINEの文字数制限を超えました');
    if(current && current.length+2+notice.length>maxChars){
      batches.push(current);
      current='';
    }
    current+=`${current?'\n\n':''}${notice}`;
  }
  if(current)batches.push(current);
  return batches;
}

/** Send a one-to-one message to the user's own LINE account. */
export async function sendLinePush({token,userId,text,request=fetch}){
  if(!token || !userId)throw new Error('LINEの認証情報が設定されていません');
  if(!text || text.length>5000)throw new Error('LINE通知文が空、または文字数制限を超えました');
  const response=await request('https://api.line.me/v2/bot/message/push',{
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
    body:JSON.stringify({to:userId,messages:[{type:'text',text}]}),
    signal:AbortSignal.timeout(15000),
  });
  if(!response.ok)throw new Error(`LINE通知に失敗（HTTP ${response.status}）`);
  return true;
}
