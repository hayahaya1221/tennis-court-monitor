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
  // This JavaScript-heavy site sometimes keeps subresources loading long after
  // the target URL is reached. Wait for the navigation response, then let the
  // destination's own UI selectors establish that the screen is ready.
  try {
    await page.waitForURL(url => url.pathname.endsWith(path), {
      timeout: 45000,
      waitUntil: 'commit'
    });
  } catch (error) {
    const currentPath=new URL(page.url()).pathname;
    const reason=error instanceof Error?error.message:String(error);
    throw new Error(`画面遷移先 ${path} を確認できません（現在 ${currentPath}）: ${reason}`);
  }
}

async function waitCalendar(page) {
  await onPath(page, CALENDAR_PATH);
  await page.locator('table').first().waitFor({state:'visible',timeout:45000});
}

async function captureSafePageState(page) {
  // Report only page structure in the public Actions log. Never save page HTML,
  // URLs with query strings, form values, cookies, or user credentials.
  try {
    return await page.evaluate(() => ({
      path: location.pathname,
      title: document.title.slice(0,100),
      readyState: document.readyState,
      tableCount: document.querySelectorAll('table').length,
      visibleTableCount: [...document.querySelectorAll('table')]
        .filter(t => !!(t.offsetWidth || t.offsetHeight || t.getClientRects().length)).length,
      loadingIndicator: !!document.querySelector('body.Loading-indicator'),
      mainHeading: document.querySelector('h2')?.textContent?.trim().slice(0,80) ?? null
    }));
  } catch(error) {
    return {
      diagnosticsUnavailable: error instanceof Error ? error.name : 'unknown',
      path: new URL(page.url()).pathname
    };
  }
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

async function timeAvailability(page, site, date, expectedCourts) {
  await onPath(page,TIME_PATH);
  // Navigation at 'commit' may finish before the time grid has populated.
  // An attached .events-group alone is insufficient: an empty/incomplete grid
  // previously caused false "F category missing" errors while readyState=loading.
  await page.locator('.events-group').first().waitFor({state:'visible',timeout:45000});
  const expectedNames=[...new Set(expectedCourts.map(s=>s.normalize('NFKC').replace(/[\s()（）]/g,'')))];
  try {
    await page.waitForFunction(({site,expectedNames})=>{
      if(document.readyState==='loading')return false;
      const normalize=s=>s.normalize('NFKC').replace(/[\s()（）]/g,'');
      const rows=new Map([...document.querySelectorAll('.events-group')].map(row=>{
        const name=row.querySelector('.room-name')?.textContent.trim()
          ?? row.textContent.split('\n')[0].trim();
        return [normalize(name),row];
      }));
      return expectedNames.length>0 && expectedNames.every(name=>{
        const row=rows.get(name);
        if(!row)return false;
        const cells=[...row.querySelectorAll('.btn-group-toggle')];
        if(site==='sumida')return cells.length===13;
        return cells.some(cell=>[...(cell.querySelector('label')?.querySelectorAll('span')??[])]
          .some(span=>!span.classList.contains('sr-only') && span.textContent.trim().normalize('NFKC')==='F'));
      });
    },{site,expectedNames},{timeout:45000,polling:250});
  } catch(error) {
    // Include only public court names and time-grid structure, not HTML/forms.
    const details=await page.evaluate(()=>[...document.querySelectorAll('.events-group')].slice(0,8).map(row=>({
      court:row.querySelector('.room-name')?.textContent.trim().slice(0,40)??null,
      timeCells:row.querySelectorAll('.btn-group-toggle').length
    }))).catch(()=>[]);
    throw new Error(`時間帯別画面の表示待機がタイムアウト: ${date} expected=${JSON.stringify(expectedNames)} grid=${JSON.stringify(details)}`);
  }
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
  const selectedNames=new Set(expectedNames);
  for(const r of rows){
    // Time views may contain rows other than the checked calendar selection.
    // Only interpret the courts explicitly selected for this date.
    if(!selectedNames.has(r.name.normalize('NFKC').replace(/[\s()（）]/g,'')))continue;
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

function calendarLabel(page,c){
  return page.locator('table').nth(c.tableIndex).locator('tr').nth(c.rowIndex)
    .locator('td').nth(c.cellIndex).locator('label');
}

async function calendarSelectionState(page){
  // The site's Bootstrap label.active and input.checked may disagree after
  // returning from the time screen, so always inspect both independently.
  return page.evaluate(()=>{
    const labels=[...document.querySelectorAll('table label')]
      .filter(label=>label.querySelector('input[type="checkbox"]'));
    return {
      active:labels.filter(label=>label.classList.contains('active')).length,
      checked:labels.filter(label=>label.querySelector('input[type="checkbox"]').checked).length
    };
  });
}

async function selectAndInspectDate(page,site,candidates,date,delayMs,{start,from,until}){
  const requested=candidates.filter(c=>c.date===date);
  if(!requested.length)throw new Error(`確認対象の日付が候補にありません: ${date}`);
  await waitCalendar(page);
  await page.locator('body.Loading-indicator').waitFor({state:'hidden',timeout:45000});
  let selection=await calendarSelectionState(page);
  if(selection.active || selection.checked){
    // Clicking an active label can invert only one of the two selection states.
    // Re-render the calendar instead of trying to repair stale UI state by clicks.
    await displayRange(page,site,start);
    // A display click initiates AJAX. Its old table can remain on screen briefly
    // even when the requested date range is unchanged.
    await page.waitForFunction(()=>{
      const labels=[...document.querySelectorAll('table label')]
        .filter(label=>label.querySelector('input[type="checkbox"]'));
      return labels.length>0 && labels.every(label=>
        !label.classList.contains('active') && !label.querySelector('input[type="checkbox"]').checked);
    },null,{timeout:15000,polling:200}).catch(()=>{});
    selection=await calendarSelectionState(page);
  }
  if(selection.active || selection.checked){
    throw new Error(`前回の日付選択を解除できません: active=${selection.active}, checked=${selection.checked}`);
  }

  // Re-evaluate the current calendar after each return from the time screen.
  // Old table/row/column indices may refer to a different cell after AJAX.
  const requestedNames=new Set(requested.map(c=>c.court));
  let current=(await dayCandidates(page,site,until,from)).candidates
    .filter(c=>c.date===date && requestedNames.has(c.court));
  if(current.length!==requestedNames.size){
    await displayRange(page,site,start);
    current=(await dayCandidates(page,site,until,from)).candidates
      .filter(c=>c.date===date && requestedNames.has(c.court));
  }
  if(current.length!==requestedNames.size){
    throw new Error(`日付選択画面の候補が変化しました: ${date} expected=${requestedNames.size} found=${current.length}`);
  }

  for(const c of current){
    const label=calendarLabel(page,c);
    await label.click();
    await page.waitForFunction(({tableIndex,rowIndex,cellIndex})=>{
      const row=document.querySelectorAll('table')[tableIndex]?.querySelectorAll('tr')[rowIndex];
      const cell=row?.querySelectorAll('td')[cellIndex];
      const label=cell?.querySelector('label.active');
      return !!label?.querySelector('input[type="checkbox"]:checked');
    },c,{timeout:7000,polling:100});
  }
  // A click can return before the site's selection state has changed. Do not
  // proceed to a page that silently stays on the calendar with zero selection.
  selection=await calendarSelectionState(page);
  if(selection.active!==current.length || selection.checked!==current.length){
    throw new Error(`日付の選択数が一致しません: ${date} expected=${current.length} active=${selection.active} checked=${selection.checked}`);
  }

  await clickButton(page,NEXT_BUTTON);
  const results=await timeAvailability(page,site,date,current.map(c=>c.court));
  await clickButton(page,BACK_BUTTON);
  await waitCalendar(page);
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
  await page.locator('body.Loading-indicator').waitFor({state:'hidden',timeout:45000});
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
    await onPath(page,'/AvailabilityCheckApplySelectFacility');
    await selectFacility(page,'竹早テニスコート（土日祝）');
    await selectFacility(page,'竹早テニスコート（平日）');
  }else{
    await clickButton(page,'屋外スポーツ施設');
    // "公園運動場" is a checkbox on the facility-selection screen, not a button.
    await onPath(page,'/AvailabilityCheckApplySelectFacility');
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
  let stage='enterCalendar';
  try{
    await enterCalendar(page,site);
    const starts=site==='bunkyo'?[from,addDays(from,30),addDays(from,60)]:[from];
    for(const start of starts){
      if(start>until)continue;
      stage=`displayRange(${start})`;
      await displayRange(page,site,start);
      const result=await dayCandidates(page,site,until,from);
      for(const day of result.inspected)inspected.add(day);
      for(const date of [...new Set(result.candidates.map(x=>x.date))].sort()){
        stage=`inspectDate(${date})`;
        raw.push(...await selectAndInspectDate(page,site,result.candidates,date,delayMs,{start,from,until}));
      }
    }
    // A site may only expose part of its booking window. We report actual checked dates.
    // At least one date must have been checked to classify the run as successful.
    if(!inspected.size)throw new Error('対象施設の空きカレンダーを読み取れない');
    return {site,from,until,daysInspected:inspected.size,raw};
  }catch(error){
    const diagnostics=await captureSafePageState(page);
    const message=error instanceof Error?error.message:String(error);
    throw new Error(`Stage: ${stage}\n${message}\nPage diagnostics: ${JSON.stringify(diagnostics)}`);
  }finally{await page.close();}
}
