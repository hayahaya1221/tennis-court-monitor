import {addDays, addMonths, MATCH_URLS} from './slots.mjs';

const NEXT_BUTTON = '次へ進む';
const BACK_BUTTON = '前に戻る';
const CALENDAR_PATH = '/AvailabilityCheckApplySelectDays';
const TIME_PATH = '/AvailabilityCheckApplySelectTime';

async function clickButton(page, label) {
  // The booking UI keeps buttons for inactive tabs in the DOM. On the Bunkyo
  // home page, five buttons read "検索", but only one is visible. Some visible
  // navigation buttons also have aria-hidden="true", so don't use getByRole.
  await page.locator('button:visible').filter({hasText: label}).first().click();
}

async function onPath(page, path) {
  await page.waitForURL(url => url.pathname.endsWith(path), {timeout: 25000});
}

async function waitCalendar(page) {
  await onPath(page, CALENDAR_PATH);
  await page.locator('table').first().waitFor({state:'visible',timeout:25000});
}

async function selectFacility(page, name) {
  // The reservation systems render a loading mask while building the facility
  // list. Wait for it to disappear before interacting with the visible label.
  // Checking the underlying <input> directly is unreliable because the styled
  // <label> intercepts pointer events on these pages.
  await page.locator('body.Loading-indicator').waitFor({state:'hidden',timeout:45000});
  await page.locator('label.custom-control-label').filter({hasText:name}).first().click({timeout:45000});
}

async function ensureNoChallenge(page) {
  const challenge = page.locator('iframe[src*="challenges.cloudflare.com"]');
  if (await challenge.count() && await challenge.first().isVisible()) {
    throw new Error('Cloudflare認証画面が表示されたため操作を停止');
  }
  const text=await page.locator('body').innerText();
  if (/InvalidTurnstile|CAPTCHAの認証に失敗|認証に失敗しました/.test(text)) {
    throw new Error('サイトの認証に失敗したため操作を停止');
  }
}

/** Only coarse "some/vacant" day-level cells become candidates, never notifications. */
async function dayCandidates(page, site, until, from) {
  return page.evaluate(({site,until,from}) => {
    const matched = [];
    const inspected = new Set();
    for (const [tableIndex, table] of [...document.querySelectorAll('table')].entries()) {
      const rows=[...table.querySelectorAll('tr')];
      const first=rows.find(r=>r.querySelectorAll('td').length>5);
      if(!first) continue;
      const dayCount=first.querySelectorAll('td').length-2;
      const start=table.innerText.match(/(20\d{2})\/(\d{1,2})\/(\d{1,2})/);
      if(!start) continue;
      let year=Number(start[1]);
      const tokens=[...(table.querySelector('thead')?.innerText ?? '').matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)]
        .map(m=>({month:Number(m[1]),day:Number(m[2])})).slice(-dayCount);
      if(tokens.length !== dayCount) throw new Error('カレンダー日付列を解析できない');
      const dates=[];
      let prevMonth=Number(start[2]);
      for(const t of tokens){
        if(t.month < prevMonth) year++;
        dates.push(`${year}-${String(t.month).padStart(2,'0')}-${String(t.day).padStart(2,'0')}`);
        prevMonth=t.month;
      }
      for(const [rowIndex,row] of rows.entries()){
        const tds=[...row.querySelectorAll('td')];
        if(tds.length!==dayCount+2)continue;
        const name=tds[0].innerText.trim().split('\n')[0].trim();
        const match=site==='bunkyo' ? /^第[１-５1-5]コート(?:平日|土日祝)$/.test(name)
          : /^錦糸公園テニスコート[ＡＢＣＤ]面/.test(name);
        if(!match)continue;
        for(let dayIndex=0;dayIndex<dates.length;dayIndex++){
          const date=dates[dayIndex];
          if(date < from || date > until)continue;
          inspected.add(date);
          const label=tds[dayIndex+2].querySelector('label');
          if(!label) continue;
          const classes=label.classList;
          if(!(classes.contains('vacant')||classes.contains('some')))continue;
          if(classes.contains('disabled')||classes.contains('time-over')||classes.contains('lottery')||classes.contains('lot'))continue;
          const input=label.querySelector('input[type="checkbox"]');
          if(input?.disabled || label.hasAttribute('disabled'))continue;
          matched.push({date,tableIndex,rowIndex,cellIndex:dayIndex+2,court:name});
        }
      }
    }
    return {candidates:matched,inspected:[...inspected]};
  }, {site, until, from});
}

function normalizeBunkyoCourt(s) {
  const x=s.match(/第([１-５1-5])コート/);
  return x ? `第${x[1]}コート` : null;
}

function normalizeSumidaCourt(s) {
  const x=s.match(/錦糸公園テニスコート([ＡＢＣＤ])面/);
  return x ? `${x[1]}面` : null;
}

async function timeAvailability(page, site, date) {
  await onPath(page,TIME_PATH);
  await page.locator('.events-group').first().waitFor({state:'attached',timeout:25000});
  await ensureNoChallenge(page);
  const rows=await page.evaluate((site)=>{
    return [...document.querySelectorAll('.events-group')].map(row=>{
      const name=row.querySelector('.room-name')?.innerText.trim() ?? row.innerText.split('\n')[0].trim();
      const cells=[...row.querySelectorAll('.btn-group-toggle')].map((cell,index)=>{
        const label=cell.querySelector('label');
        const letter=site==='bunkyo'? [...(label?.querySelectorAll('span')??[])].find(x=>!x.classList.contains('sr-only'))?.textContent.trim() : undefined;
        const srText=label?.querySelector('.sr-only')?.textContent.trim()??'';
        return {index,letter,srText,bookable:cell.classList.contains('vacant') && !cell.classList.contains('disabled')
          && !!label && !label.classList.contains('disabled') && !label.hasAttribute('disabled')
          && !!label.querySelector('input[type="checkbox"]:not(:disabled)')};
      });
      return {name,cells};
    });
  },site);
  const output=[];
  for(const r of rows){
    if(site==='bunkyo'){
      if(!/^(第[１-５1-5]コート)(?:平日|土日祝)/.test(r.name)) continue;
      const f=r.cells.find(x=>x.letter==='Ｆ'||x.letter==='F');
      if(!f) throw new Error(`F区分の列が見つからない: ${date} ${r.name}`);
      if(f.bookable)output.push({date,court:normalizeBunkyoCourt(r.name)});
    } else {
      const court=normalizeSumidaCourt(r.name);
      if(!court)continue;
      if(r.cells.length!==13) throw new Error(`1時間枠の列数が想定外: ${date} ${r.name} (${r.cells.length})`);
      for(const hour of [18,19,20]){
        if(r.cells[hour-8].bookable)output.push({date,court,hour});
      }
    }
  }
  return output;
}

async function selectAndInspectDate(page,site,candidates,date,delayMs){
  const selected=candidates.filter(c=>c.date===date);
  for(const c of selected){
    const label=page.locator('table').nth(c.tableIndex).locator('tr').nth(c.rowIndex)
      .locator('td').nth(c.cellIndex).locator('label');
    await label.click();
  }
  await clickButton(page,NEXT_BUTTON);
  const results=await timeAvailability(page,site,date);
  await clickButton(page,BACK_BUTTON);
  await waitCalendar(page);
  // The booking UI retains selections after returning to the calendar.
  // Clear them before the next date, otherwise courts/dates get mixed.
  for(const c of selected){
    const label=page.locator('table').nth(c.tableIndex).locator('tr').nth(c.rowIndex)
      .locator('td').nth(c.cellIndex).locator('label');
    const active=await label.getAttribute('class');
    if((active??'').split(/\s+/).includes('active'))await label.click();
  }
  if(delayMs) await page.waitForTimeout(delayMs);
  return results;
}

async function displayRange(page,site,startDate){
  await waitCalendar(page);
  const view=site==='bunkyo'?'1ヶ月':'3ヶ月';
  await page.getByText(view,{exact:true}).first().click();
  const date=page.locator('#SearchCondition_StartDate');
  if(await date.count())await date.fill(startDate);
  await clickButton(page,'表示');
  // The AJAX render is not synchronous with the display-button click.
  await page.waitForFunction((startDate)=>{
    const tables=[...document.querySelectorAll('table')];
    if(!tables.length)return false;
    const m=startDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const expected=`${m[1]}/${Number(m[2])}/${Number(m[3])}`;
    return tables.some(t=>t.innerText.startsWith(expected));
  },startDate,{timeout:30000});
  await ensureNoChallenge(page);
}

async function enterCalendar(page,site){
  // Sumida can respond slowly from hosted runners. Wait for the HTTP response
  // first, then for the JavaScript UI to render, rather than demanding the
  // full DOMContentLoaded event within one short navigation timeout.
  await page.goto(MATCH_URLS[site],{waitUntil:'commit',timeout:75000});
  await page.locator('#divSearch').waitFor({state:'visible',timeout:45000});
  await ensureNoChallenge(page);
  if(site==='bunkyo'){
    await page.getByRole('tab',{name:'施設名から探す'}).click();
    await page.locator('#divSearch').getByRole('textbox').first().fill('竹早');
    await clickButton(page,'検索');
    await page.waitForURL(url=>url.pathname.endsWith('/AvailabilityCheckApplySelectFacility'));
    await selectFacility(page,'竹早テニスコート（土日祝）');
    await selectFacility(page,'竹早テニスコート（平日）');
  }else{
    await clickButton(page,'屋外スポーツ施設');
    // "公園運動場" is a checkbox on the facility-selection screen, not a button.
    await page.waitForURL(url=>url.pathname.endsWith('/AvailabilityCheckApplySelectFacility'),{timeout:45000});
    await selectFacility(page,'公園運動場');
  }
  await clickButton(page,NEXT_BUTTON);
  await waitCalendar(page);
}

/** If any date fails, throw: incomplete scans must never be treated as "no availability". */
export async function scanSite(browser,site,from,{delayMs=800}={}){
  const until=addMonths(from,2);
  const page=await browser.newPage({locale:'ja-JP',timeZoneId:'Asia/Tokyo'});
  const raw=[];
  const inspected=new Set();
  try{
    await enterCalendar(page,site);
    const starts=site==='bunkyo'?[from,addDays(from,30),addDays(from,60)]:[from];
    for(const start of starts){
      if(start>until)continue;
      await displayRange(page,site,start);
      const result=await dayCandidates(page,site,until,from);
      for(const day of result.inspected)inspected.add(day);
      for(const date of [...new Set(result.candidates.map(x=>x.date))].sort()){
        raw.push(...await selectAndInspectDate(page,site,result.candidates,date,delayMs));
      }
    }
    // A site may only expose part of its booking window. We report actual checked dates.
    // At least one date must have been checked to classify the run as successful.
    if(!inspected.size)throw new Error('対象施設の空きカレンダーを読み取れない');
    return {site,from,until,daysInspected:inspected.size,raw};
  }finally{await page.close();}
}
