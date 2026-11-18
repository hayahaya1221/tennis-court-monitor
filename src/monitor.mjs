import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {chromium} from 'playwright';
import {bunkyoNotifications,sumidaNotifications,novelSlots,slotKey,formatNotice,japanNow} from './slots.mjs';
import {scanSite} from './sites.mjs';
import {splitNoticeBatches,sendLinePush} from './notify.mjs';

const statePath=resolve(process.env.STATE_PATH || './state/seen.json');
const checked=japanNow();
const currentState=await readFile(statePath,'utf8').then(JSON.parse).catch(e=>{
  if(e.code==='ENOENT')return {version:1,sites:{}};
  throw e;
});
currentState.sites ||= {};

const lineToken=process.env.LINE_CHANNEL_ACCESS_TOKEN;
const lineUserId=process.env.LINE_USER_ID;
if(Boolean(lineToken)!==Boolean(lineUserId))throw new Error('LINE_CHANNEL_ACCESS_TOKEN と LINE_USER_ID は両方指定してください');
const lineConfigured=Boolean(lineToken&&lineUserId);
const transport=lineConfigured?'line':'stdout-only';

async function notify(message){
  if(!lineConfigured){console.log(message);return false;}
  return sendLinePush({token:lineToken,userId:lineUserId,text:message});
}

let browser;
const resultSummary=[];
try{
  browser=process.env.PLAYWRIGHT_CDP_URL
    ? await chromium.connectOverCDP(process.env.PLAYWRIGHT_CDP_URL)
    : await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
  for(const site of ['bunkyo','sumida']){
    const state=currentState.sites[site]??{seen:[],lastErrorDay:null};
    try{
      const found=await scanSite(browser,site,checked.date,{delayMs:Number(process.env.BETWEEN_DAY_REQUESTS_MS || 800)});
      const matches=site==='bunkyo'?bunkyoNotifications(found.raw):sumidaNotifications(found.raw);
      const newMatches=novelSlots(matches,state.seen??[]);
      // A silent/console-only run does not consume the notification's "unseen" state.
      let delivered=true;
      if(newMatches.length){
        const notices=newMatches.map(slot=>formatNotice(slot,checked.time));
        // LINE text messages are limited to 5,000 characters.
        for(const report of splitNoticeBatches(notices)){
          const sent=await notify(report);
          delivered=delivered&&sent;
        }
      }
      if(delivered){
        state.seen=matches.map(slotKey);
      }
      state.lastSuccess=checked.time;
      state.lastErrorDay=null;
      state.daysInspected=found.daysInspected;
      resultSummary.push({site,status:'ok',daysInspected:found.daysInspected,matching:matches.length,new:newMatches.length,delivered});
    }catch(error){
      // Never replace old slots with an empty list after a failed/partial scan.
      const reason=error instanceof Error?error.message:String(error);
      if(state.lastErrorDay!==checked.date){
        try{
          await notify(`【監視取得エラー】${site==='bunkyo'?'竹早':'錦糸公園'}テニスコート\n${checked.time}\n空きなしとは判定していません。原因：${reason.slice(0,320)}`);
          state.lastErrorDay=checked.date;
        }catch(e){console.error('Error notification failed:',e.message);}
      }
      resultSummary.push({site,status:'error',reason});
    }
    currentState.sites[site]=state;
  }
}finally{
  if(browser)await browser.close();
  await mkdir(dirname(statePath),{recursive:true});
  await writeFile(statePath,JSON.stringify(currentState,null,2)+'\n','utf8');
  console.log(JSON.stringify({checked:checked.time,transport,resultSummary},null,2));
}
