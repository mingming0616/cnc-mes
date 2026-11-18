// ============================================================
// repair.js — 報修流程（功能㉑，階段 2）
//   機台頁（machine.html）、報修單頁（repairs.html）共用：報修單卡片、各步驟的按鈕和視窗、寫入資料庫
//   流程：① 報修 → ② 接單 → ③ 維修完成 → ④ 驗收（OK 結案／不 OK 退回重修）
//     ‧30 分鐘內修好、沒換零件、沒被退回過 → 修的人可以勾「小問題，直接結案」
//     ‧待驗收超過 24 小時 → 畫面算成「已結案（未驗收）」（不寫資料庫，機台狀態不動）
//     ‧接單前報錯了 → 報修人或管理者可以取消，取消的單不列入統計
//   機台狀態（只有報修時勾「機台已停機」才會動）：
//     報修 → 故障／所選原因；維修完成 → 待機／待首件；驗收 OK → 生產中；
//     小問題直接結案 → 生產中；驗收不 OK → 故障（看板會照功能⑭跳提醒）；
//     取消 → 改回報修前的狀態
//     機台狀態已經被別人改成別的（例如停用），就不去動它
//   每一步：報修單＋（要改機台狀態時）目前狀態＋事件紀錄，一次寫入，不會只寫一半；
//     事件紀錄多一個 repairId，對應是哪一張報修單（之後算 MTTR 用）
//   注意：這個檔案不 import common.js，資料庫函式由頁面用 setupRepair() 傳進來（跟 history.js 一樣）
//         畫面（視窗 HTML、樣式）也寫在這個檔案裡，頁面不用各寫一份
// ============================================================

const $ = (id) => document.getElementById(id);
const SLOW_MS = 8000;                          // 網路慢：8 秒沒回應先關視窗，連線恢復後自動送出
export const SELF_CLOSE_MINUTES = 30;          // 小問題：接單後 30 分鐘內修好可以自己結案
export const AUTO_CLOSE_HOURS = 24;            // 待驗收超過 24 小時，畫面算成「已結案（未驗收）」
export const ACTIVE_STAGES = ['open', 'repairing', 'pendingAccept'];
const MAX_REWORKS = 10;                        // 一張單最多退回 10 次（安全規則也是這個數字）

let deps = null;
let act = null;     // 視窗正在做的動作 { kind, ticket, machine }

// ---------- 樣式（只在用到報修的頁面加上） ----------
const STYLE = `
.rp-card { background: var(--panel); border: 2px solid var(--ink); border-radius: 8px; padding: 12px 14px; margin: 0 0 12px; }
.rp-card.is-rework { border-color: #D93025; box-shadow: 0 0 0 3px rgba(217, 48, 37, .18); }
.rp-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-bottom: 6px; }
.rp-mid { font-family: var(--font-code); font-weight: 700; font-size: 24px; letter-spacing: .02em; color: var(--ink); text-decoration: none; }
.rp-stage { display: inline-block; padding: 2px 10px; border-radius: 4px; font-weight: 700; font-size: 15px; border: 2px solid var(--ink); }
.rp-stage.s-open { background: #D93025; border-color: #D93025; color: #fff; }
.rp-stage.s-repairing { background: #E8B400; border-color: #E8B400; color: #1D262D; }
.rp-stage.s-pendingAccept { background: #2F6FDE; border-color: #2F6FDE; color: #fff; }
.rp-stage.s-closed { background: #2E9E4F; border-color: #2E9E4F; color: #fff; }
.rp-stage.s-unaccepted { background: var(--panel); color: var(--ink-soft); border-style: dashed; }
.rp-stage.s-cancelled { background: var(--sunk); color: var(--ink-soft); border-color: var(--rule-strong); }
.rp-flag { font-size: 14px; font-weight: 700; color: #B3261E; }
.rp-flag.is-test { color: var(--ink-soft); border: 1px dashed var(--rule-strong); padding: 0 6px; border-radius: 4px; font-weight: 400; }
.rp-elapsed { margin-left: auto; font-size: 15px; color: var(--ink-soft); white-space: nowrap; }
.rp-line { margin: 2px 0; font-size: 16px; line-height: 1.5; overflow-wrap: anywhere; }
.rp-line .k { color: var(--ink-soft); margin-right: 4px; }
.rp-steps { margin: 6px 0 0; padding: 6px 0 0; border-top: 1px dashed var(--rule); font-size: 14px; color: var(--ink-soft); line-height: 1.6; }
.rp-acts { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin-top: 10px; }
.rp-acts .btn { min-height: 56px; font-size: 18px; }
.rp-big { min-height: 72px; font-size: 24px; width: 100%; }
.btn.rp-red { background: #D93025; border-color: #D93025; color: #fff; }
.btn.rp-red:active { background: #B3261E; }
.rp-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.rp-chip { min-height: 48px; padding: 6px 14px; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--panel); color: var(--ink); font: inherit; font-size: 17px; cursor: pointer; }
.rp-chip[aria-pressed="true"] { background: var(--ink); color: #fff; }
.rp-dlg textarea { width: 100%; min-height: 84px; padding: 10px 12px; border: 2px solid var(--rule-strong); border-radius: var(--radius); font: inherit; font-size: 17px; background: var(--panel); color: var(--ink); resize: vertical; box-sizing: border-box; }
.rp-dlg textarea:focus { border-color: var(--ink); outline: none; }
.rp-dlg .rp-title { margin: 0 0 4px; font-size: 22px; }
.rp-dlg .rp-foot { position: sticky; bottom: 0; background: var(--panel); padding-top: 8px; margin-top: 4px; }
.rp-dlg .rp-foot .btn { min-height: 52px; font-size: 18px; }
.rp-warn { background: #FFF4E5; border: 1px solid #F07C00; border-radius: 6px; padding: 8px 10px; font-size: 15px; margin: 0 0 12px; }
`;

const DIALOG_HTML = `
<dialog id="dlg-repair" class="rp-dlg">
  <form id="repair-form" class="dialog-body" novalidate>
    <h2 id="rp-title" class="rp-title"></h2>
    <p id="rp-sub" class="muted"></p>
    <div id="rp-body"></div>
    <div class="rp-foot">
      <p id="rp-error" class="form-error" role="alert"></p>
      <div class="row-actions">
        <button id="rp-cancel" class="btn" type="button">取消</button>
        <button id="rp-ok" class="btn primary" type="submit">確定</button>
      </div>
    </div>
  </form>
</dialog>`;

// ============================================================
// 給頁面呼叫的函式
// ============================================================

// 頁面讀完資料後呼叫一次
//   d 需要：db, collection, doc, writeBatch, serverTimestamp, getDocFromServer,
//          escapeHtml, errorMessage, toast, setBusy, formatTime, formatDuration, prodDateAndShift,
//          myEmpNo, getMe(), getShiftSetting(), getRepairSetting()（settings/repair，沒有是 null），
//          deptFor(單位代號) → 單位設定（狀態、原因）、floorName(樓層代號)、
//          listAssignees()（選填：改派時可以選的人，回傳 Promise<[{ empNo, name }]>）
export function setupRepair(d) {
  deps = d;
  if (!$('rp-style')) {
    const style = document.createElement('style');
    style.id = 'rp-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  if (!$('dlg-repair')) document.body.insertAdjacentHTML('beforeend', DIALOG_HTML);
  $('rp-cancel').addEventListener('click', () => $('dlg-repair').close());
  $('dlg-repair').addEventListener('close', () => { act = null; });
  $('repair-form').addEventListener('submit', submit);
  // 視窗裡的選項按鈕（原因、是否停機…）：同一組只能選一個
  $('rp-body').addEventListener('click', (event) => {
    const chip = event.target.closest('.rp-chip');
    if (!chip) return;
    chip.parentElement.querySelectorAll('.rp-chip').forEach((b) => b.setAttribute('aria-pressed', String(b === chip)));
    $('rp-error').textContent = '';
    if (chip.dataset.group === 'parts') $('rp-parts-box').hidden = chip.dataset.value !== 'yes';
  });
}

// 報修功能開放了沒：還沒開放（settings/repair.enabled 不是 true）只有管理者能用（測試）
export function repairOpen(me, cfg) {
  return cfg?.enabled === true || me?.role === 'admin';
}

// 這個人能不能動這個單位的報修單（跟切換狀態一樣：管理者全部單位、維護員負責單位）
export function canOperate(me, deptId) {
  if (!me || me.active === false) return false;
  return me.role === 'admin' || (me.role === 'maintainer' && (me.deptIds || []).includes(deptId));
}

// 報修單現在是哪個階段（畫面用）
//   pendingAccept 超過 24 小時 → unaccepted「已結案（未驗收）」
export function stageOf(t, now = Date.now()) {
  if (t.stage === 'pendingAccept' && ms(t.doneAt) && now - ms(t.doneAt) > AUTO_CLOSE_HOURS * 3600000) {
    return 'unaccepted';
  }
  return t.stage;
}
export const STAGE_LABELS = {
  open: '待接單', repairing: '維修中', pendingAccept: '待驗收',
  closed: '已結案', unaccepted: '已結案（未驗收）', cancelled: '已取消'
};
// 還算「未結案」（機台頁要顯示這張、不能再開新的）
export const isActiveTicket = (t, now = Date.now()) => ['open', 'repairing', 'pendingAccept'].includes(stageOf(t, now));

// 這個人現在可以按哪些按鈕
export function actionsFor(t, me, cfg, now = Date.now()) {
  const stage = stageOf(t, now);
  const my = me?.empNo;
  const admin = me?.role === 'admin';
  const owner = !!cfg?.ownerEmpNo && my === cfg.ownerEmpNo;
  const proxy = !!cfg?.proxyEmpNo && my === cfg.proxyEmpNo;
  if (!canOperate(me, t.deptId)) return [];
  const list = [];
  if (stage === 'open') {
    if (admin || owner || proxy || my === t.assignedEmpNo) list.push({ kind: 'start', label: '接單', primary: true });
    if (admin || owner) list.push({ kind: 'reassign', label: '改派' });
    if (admin || my === t.reportedByEmpNo) list.push({ kind: 'cancel', label: '取消報修' });
  } else if (stage === 'repairing') {
    if (admin || my === t.assignedEmpNo) list.push({ kind: 'finish', label: '維修完成', primary: true });
    if (admin || owner) list.push({ kind: 'reassign', label: '改派' });
  } else if (stage === 'pendingAccept') {
    // 修的人不能驗收自己修的（管理者除外）
    if (admin || my !== t.doneByEmpNo) {
      list.push({ kind: 'accept', label: '驗收 OK', primary: true });
      list.push({ kind: 'reject', label: '驗收不 OK' });
    }
  }
  return list;
}

// 報修單卡片
//   showMachine：顯示設備編號（報修單頁要，機台頁不用）；actions：要不要放按鈕
export function ticketHtml(t, { me, cfg, showMachine = true, actions = true, now = Date.now() } = {}) {
  const esc = deps.escapeHtml;
  const stage = stageOf(t, now);
  const dept = deps.deptFor(t.deptId);
  const fault = reasonText(dept, t.faultCode);
  const cause = reasonText(dept, t.causeCode);
  const reworks = Array.isArray(t.reworks) ? t.reworks : [];
  const rework = reworks.length > 0 && stage === 'repairing';
  const elapsed = elapsedText(t, stage, now);

  const lines = [
    `<p class="rp-line"><span class="k">故障</span>${esc(fault)}${t.stopped ? '' : '（機台沒停）'}${t.symptom ? `：${esc(t.symptom)}` : ''}</p>`,
    `<p class="rp-line"><span class="k">報修</span>${esc(t.reportedByName)}${t.reportedFor ? `（代 ${esc(t.reportedFor)} 報）` : ''}　${esc(deps.formatTime(t.reportedAt))}</p>`,
    `<p class="rp-line"><span class="k">指派</span>${esc(t.assignedName || '—')}</p>`
  ];
  if (rework) {
    const last = reworks[reworks.length - 1];
    lines.push(`<p class="rp-line rp-flag">退回重修第 ${reworks.length} 次：${esc(last.rejectNote || '')}（${esc(last.rejectedByName || '')}）</p>`);
  }
  if (t.doneAt) {
    lines.push(`<p class="rp-line"><span class="k">處置</span>${cause && cause !== fault ? `［${esc(cause)}］` : ''}${esc(t.action || '')}`
      + `${t.partsReplaced ? `；換零件：${esc(t.parts || '')}` : ''}</p>`);
  }
  if (t.closeNote) lines.push(`<p class="rp-line"><span class="k">${t.closeType === 'cancelled' ? '取消原因' : '驗收備註'}</span>${esc(t.closeNote)}</p>`);

  const steps = [];
  if (t.startedAt) steps.push(`接單 ${esc(t.startedByName)} ${esc(deps.formatTime(t.startedAt))}`);
  reworks.forEach((r, i) => steps.push(`第 ${i + 1} 次修完 ${esc(r.doneByName)} → 退回 ${esc(r.rejectedByName)} ${esc(deps.formatTime(r.rejectedAt))}`));
  if (t.doneAt) steps.push(`修完 ${esc(t.doneByName)} ${esc(deps.formatTime(t.doneAt))}`);
  if (t.closedAt) {
    const how = { accepted: '驗收', selfClosed: '小問題自行結案', cancelled: '取消' }[t.closeType] || '結案';
    steps.push(`${how} ${esc(t.closedByName)} ${esc(deps.formatTime(t.closedAt))}`);
  } else if (stage === 'unaccepted') {
    steps.push(`超過 ${AUTO_CLOSE_HOURS} 小時沒人驗收，自動結案`);
  }

  const acts = actions ? actionsFor(t, me, cfg, now) : [];
  return `<article class="rp-card${rework ? ' is-rework' : ''}" data-id="${esc(t.id)}">`
    + '<div class="rp-head">'
    + (showMachine ? `<a class="rp-mid" href="machine.html?machineId=${encodeURIComponent(t.machineId)}">${esc(t.machineId)}</a>` : '')
    + `<span class="rp-stage s-${stage}">${STAGE_LABELS[stage] || stage}</span>`
    + (rework ? '<span class="rp-flag">退回重修</span>' : '')
    + (showMachine ? `<span class="muted">${esc(deps.floorName(t.floorId))}</span>` : '')
    + (elapsed ? `<span class="rp-elapsed">${elapsed}</span>` : '')
    + '</div>'
    + lines.join('')
    + (steps.length ? `<p class="rp-steps">${steps.join('<br>')}</p>` : '')
    + (acts.length
      ? `<div class="rp-acts">${acts.map((a) => `<button type="button" class="btn${a.primary ? ' primary' : ''}" data-act="${a.kind}" data-id="${esc(t.id)}">${a.label}</button>`).join('')}</div>`
      : '')
    + '</article>';
}

// 打開某個動作的視窗
//   kind：report 報修（要傳 machine）／start 接單／finish 維修完成／accept 驗收 OK／reject 驗收不 OK／
//         cancel 取消報修／reassign 改派（後面這些要傳 ticket）
export async function openRepairAction(kind, { ticket = null, machine = null } = {}) {
  if (!deps) return;
  act = { kind, ticket, machine };
  const esc = deps.escapeHtml;
  const deptId = ticket?.deptId || machine?.deptId;
  const dept = deps.deptFor(deptId);
  const mid = ticket?.machineId || machine?.machineId;
  const faults = activeFaults(dept);
  let title = '';
  let body = '';
  let ok = '確定';

  if (kind === 'report') {
    const cfg = deps.getRepairSetting();
    const assignee = assigneeOf(cfg);
    title = `報修 ${mid}`;
    ok = '送出報修';
    body = (cfg?.enabled !== true ? '<p class="rp-warn">報修還沒開放給現場（測試中）。並存期間機台狀態以 v3.3 為準，這裡改的不會同步到 v3.3。</p>' : '')
      + (!assignee ? '<p class="rp-warn">還沒設定維修負責人，請管理者先到「報修單」頁的「維修設定」設定。</p>' : '')
      + `<fieldset class="field"><legend>故障原因（必選）</legend><div class="rp-chips" id="rp-fault">${chips('fault', faults, '')}</div></fieldset>`
      + '<label class="field"><span>故障現象（可不填）</span><textarea id="rp-symptom" maxlength="200" placeholder="例：換刀到一半停住，出現 ALARM 2010"></textarea></label>'
      + `<fieldset class="field"><legend>機台現在</legend><div class="rp-chips">${chips('stopped', [{ code: 'yes', label: '已停機' }, { code: 'no', label: '還能生產' }], 'yes')}</div></fieldset>`
      + '<label class="field"><span>幫誰報的（作業員口頭告訴你的話填他的名字，可不填）</span><input id="rp-for" type="text" maxlength="20"></label>'
      + `<p class="muted">會派給：<b>${esc(assignee?.name || '（未設定）')}</b>${cfg?.ownerAway ? '（負責人休假中，派給代理人）' : ''}。勾「已停機」時，機台會改成「故障」。</p>`;
  } else if (kind === 'start') {
    title = `接單 ${mid}`;
    ok = '接單，開始修';
    const me = deps.getMe();
    body = `<p>故障：<b>${esc(reasonText(dept, ticket.faultCode))}</b>${ticket.symptom ? `，${esc(ticket.symptom)}` : ''}</p>`
      + (ticket.assignedEmpNo !== me.empNo ? `<p class="rp-warn">這張原本派給 ${esc(ticket.assignedName)}，接單後會改成你。</p>` : '')
      + '<p class="muted">按下去開始計算維修時間。</p>';
  } else if (kind === 'finish') {
    const startedMs = ms(ticket.startedAt);
    const reworked = (ticket.reworks || []).length > 0;
    const quickOk = !reworked && startedMs && Date.now() - startedMs <= SELF_CLOSE_MINUTES * 60000;
    title = `維修完成 ${mid}`;
    ok = '維修完成';
    body = `<fieldset class="field"><legend>實際故障原因</legend><div class="rp-chips" id="rp-cause">${chips('cause', faults, ticket.causeCode || ticket.faultCode)}</div></fieldset>`
      + '<label class="field"><span>處置內容（必填）</span><textarea id="rp-action" maxlength="200" placeholder="例：換刀臂定位感測器，重新校正"></textarea></label>'
      + `<fieldset class="field"><legend>有沒有換零件</legend><div class="rp-chips">${chips('parts', [{ code: 'no', label: '沒有' }, { code: 'yes', label: '有' }], 'no')}</div></fieldset>`
      + '<label class="field" id="rp-parts-box" hidden><span>換了什麼（必填）</span><input id="rp-parts" type="text" maxlength="100" placeholder="例：近接開關 ×1"></label>'
      + (quickOk
        ? `<label class="check"><input id="rp-self" type="checkbox"> 小問題，直接結案（${SELF_CLOSE_MINUTES} 分鐘內修好、沒換零件，不用等驗收）</label>`
        : `<p class="muted">${reworked ? '這張被退回過，' : `接單超過 ${SELF_CLOSE_MINUTES} 分鐘，`}要等報修人或組長驗收。</p>`)
      + (ticket.stopped ? '<p class="muted">送出後機台改成「待機／待首件」，驗收 OK 才改成「生產中」（小問題直接結案就直接改「生產中」）。</p>' : '');
  } else if (kind === 'accept') {
    title = `驗收 ${mid}`;
    ok = '驗收 OK，結案';
    body = `<p>處置：${esc(ticket.action || '')}${ticket.partsReplaced ? `；換零件：${esc(ticket.parts || '')}` : ''}（${esc(ticket.doneByName)}）</p>`
      + '<label class="field"><span>驗收備註（可不填）</span><input id="rp-note" type="text" maxlength="100" placeholder="例：試切 OK，首件尺寸 OK"></label>'
      + (ticket.stopped ? '<p class="muted">結案後機台改成「生產中」。</p>' : '');
  } else if (kind === 'reject') {
    title = `驗收不 OK ${mid}`;
    ok = '退回重修';
    body = '<label class="field"><span>哪裡不 OK（必填）</span><textarea id="rp-note" maxlength="100" placeholder="例：試切後又出現同樣警報"></textarea></label>'
      + `<p class="muted">退回給 ${esc(ticket.assignedName)} 繼續修（同一張單）。${ticket.stopped ? '機台改回「故障」，看板會跳出提醒。' : ''}</p>`;
  } else if (kind === 'cancel') {
    title = `取消報修 ${mid}`;
    ok = '取消這張報修';
    body = '<label class="field"><span>為什麼取消（必填）</span><input id="rp-note" type="text" maxlength="100" placeholder="例：報錯機台、現場自己排除了"></label>'
      + (!ticket.stopped ? ''
        : !ticket.beforeStatus
          ? '<p class="rp-warn">這台報修前是「未設定」（從來沒切過狀態），系統沒辦法改回去。取消後機台會留在「故障」，請到「切換狀態」改成正確的狀態。</p>'
          : `<p class="muted">機台會改回報修前的狀態（${esc(statusText(dept, ticket.beforeStatus, ticket.beforeReasonCode))}）。</p>`)
      + '<p class="muted">取消的單不列入統計。</p>';
  } else if (kind === 'reassign') {
    title = `改派 ${mid}`;
    ok = '改派';
    body = '<p class="muted">讀取人員中…</p>';
  }

  $('rp-title').textContent = title;
  $('rp-sub').textContent = ticket ? `報修 ${deps.formatTime(ticket.reportedAt)}，${deps.floorName(ticket.floorId)}` : deps.floorName(machine?.floorId);
  $('rp-body').innerHTML = body;
  $('rp-ok').textContent = ok;
  $('rp-ok').className = `btn ${kind === 'report' || kind === 'reject' ? 'rp-red' : 'primary'}`;
  $('rp-ok').disabled = false;
  $('rp-error').textContent = '';
  $('dlg-repair').showModal();

  if (kind === 'reassign') {
    try {
      const people = await assigneeChoices();
      if (act?.kind !== 'reassign') return;
      $('rp-body').innerHTML = `<p>目前派給：<b>${esc(ticket.assignedName)}</b></p>`
        + `<fieldset class="field"><legend>改派給</legend><div class="rp-chips" id="rp-who">${chips('who', people.filter((p) => p.code !== ticket.assignedEmpNo), '')}</div></fieldset>`;
    } catch (err) {
      $('rp-error').textContent = deps.errorMessage(err);
    }
  }
}

// ============================================================
// 寫入
// ============================================================
async function submit(event) {
  event.preventDefault();
  if (!act) return;
  const { kind, ticket, machine } = act;
  const me = deps.getMe();
  const fail = (message) => { $('rp-error').textContent = message; return null; };
  const picked = (group) => $('rp-body').querySelector(`.rp-chip[data-group="${group}"][aria-pressed="true"]`)?.dataset.value || '';
  const val = (id) => ($(id)?.value || '').trim();
  const shiftSetting = deps.getShiftSetting();
  if (!navigator.onLine) return fail('現在沒有網路，報修要有網路才能送出');

  const { db, collection, doc, serverTimestamp } = deps;
  const stamp = { updatedAt: serverTimestamp(), updatedByEmpNo: deps.myEmpNo() };
  let plan;   // { ref, set 或 update, status: { to, reason } 或 null, done: 成功訊息 }

  if (kind === 'report') {
    const cfg = deps.getRepairSetting();
    const assignee = assigneeOf(cfg);
    if (!assignee) return fail('還沒設定維修負責人，請管理者先設定');
    const faultCode = picked('fault');
    if (!faultCode) return fail('請選故障原因');
    if (!shiftSetting) return fail('找不到班別設定');
    const { prodDate, shiftId } = deps.prodDateAndShift(new Date(), shiftSetting);
    if (!shiftId) return fail('現在的時間不在任何班別裡，請檢查班別設定');
    const stopped = picked('stopped') !== 'no';
    const now = await currentStatus(machine.machineId);
    const ref = doc(collection(db, 'repairs'));
    plan = {
      ref,
      set: {
        machineId: machine.machineId, deptId: machine.deptId, floorId: machine.floorId,
        stage: 'open',
        faultCode, symptom: val('rp-symptom'), stopped, reportedFor: val('rp-for'),
        beforeStatus: now ? now.status : null,
        beforeReasonCode: now ? (now.reasonCode || '') : null,
        reportedAt: serverTimestamp(), reportedByEmpNo: deps.myEmpNo(), reportedByName: me.name,
        prodDate, shiftId,
        assignedEmpNo: assignee.empNo, assignedName: assignee.name,
        startedAt: null, startedByEmpNo: null, startedByName: null,
        doneAt: null, doneByEmpNo: null, doneByName: null,
        causeCode: null, action: null, partsReplaced: null, parts: null,
        closedAt: null, closedByEmpNo: null, closedByName: null, closeType: null, closeNote: null,
        reworks: [],
        ...stamp
      },
      status: stopped ? { to: 'fault', reason: faultCode } : null,
      statusNow: now,
      done: `${machine.machineId} 已報修，派給 ${assignee.name}`
    };
  } else if (kind === 'start') {
    plan = {
      update: {
        stage: 'repairing',
        startedAt: serverTimestamp(), startedByEmpNo: deps.myEmpNo(), startedByName: me.name,
        assignedEmpNo: deps.myEmpNo(), assignedName: me.name,
        ...stamp
      },
      done: `${ticket.machineId} 已接單`
    };
  } else if (kind === 'finish') {
    const causeCode = picked('cause');
    const action = val('rp-action');
    const partsReplaced = picked('parts') === 'yes';
    const parts = partsReplaced ? val('rp-parts') : '';
    if (!causeCode) return fail('請選實際故障原因');
    if (action.length < 2) return fail('請填處置內容（至少 2 個字）');
    if (partsReplaced && !parts) return fail('請填換了什麼零件');
    const self = !!$('rp-self')?.checked && !partsReplaced;
    const update = {
      stage: self ? 'closed' : 'pendingAccept',
      doneAt: serverTimestamp(), doneByEmpNo: deps.myEmpNo(), doneByName: me.name,
      causeCode, action, partsReplaced, parts,
      ...stamp
    };
    if (self) Object.assign(update, { closedAt: serverTimestamp(), closedByEmpNo: deps.myEmpNo(), closedByName: me.name, closeType: 'selfClosed' });
    plan = {
      update,
      // 機台還是「故障」才改（被別人改成別的就不動）
      status: ticket.stopped ? { to: self ? 'running' : 'waiting', reason: self ? '' : 'firstArticle', onlyIf: (s) => s?.status === 'fault' } : null,
      done: self ? `${ticket.machineId} 已結案` : `${ticket.machineId} 維修完成，等驗收`
    };
  } else if (kind === 'accept') {
    plan = {
      update: {
        stage: 'closed',
        closedAt: serverTimestamp(), closedByEmpNo: deps.myEmpNo(), closedByName: me.name,
        closeType: 'accepted', closeNote: val('rp-note'),
        ...stamp
      },
      // 機台還在「待機／待首件」才改成生產中
      status: ticket.stopped ? { to: 'running', reason: '', onlyIf: (s) => s?.status === 'waiting' && s?.reasonCode === 'firstArticle' } : null,
      done: `${ticket.machineId} 驗收 OK，已結案`
    };
  } else if (kind === 'reject') {
    const note = val('rp-note');
    if (note.length < 2) return fail('請寫哪裡不 OK（至少 2 個字）');
    const reworks = Array.isArray(ticket.reworks) ? ticket.reworks : [];
    if (reworks.length >= MAX_REWORKS) return fail(`這張已經退回 ${MAX_REWORKS} 次，請取消後重新報修，或找管理者`);
    plan = {
      update: {
        stage: 'repairing',
        // 這次修完的內容搬到「退回紀錄」，留著追溯
        reworks: [...reworks, {
          doneAt: ticket.doneAt, doneByEmpNo: ticket.doneByEmpNo, doneByName: ticket.doneByName,
          causeCode: ticket.causeCode, action: ticket.action, partsReplaced: ticket.partsReplaced, parts: ticket.parts,
          rejectedAt: null,   // 先占位，寫入前換成時間（陣列裡不能用伺服器時間）
          rejectedByEmpNo: deps.myEmpNo(), rejectedByName: me.name, rejectNote: note
        }],
        doneAt: null, doneByEmpNo: null, doneByName: null,
        causeCode: null, action: null, partsReplaced: null, parts: null,
        ...stamp
      },
      status: ticket.stopped ? { to: 'fault', reason: ticket.causeCode || ticket.faultCode, onlyIf: (s) => s?.status !== 'fault' && s?.status !== 'offline' && s?.status !== 'lent' } : null,
      done: `${ticket.machineId} 已退回重修`
    };
    plan.reworkTime = true;
  } else if (kind === 'cancel') {
    const note = val('rp-note');
    if (note.length < 2) return fail('請寫取消原因（至少 2 個字）');
    // 改回報修前的狀態：報修前本來就是故障也一樣（原因可能不同，改回原本的原因）；報修前是「未設定」就改不回去
    const back = ticket.stopped && !!ticket.beforeStatus;
    plan = {
      update: {
        stage: 'cancelled',
        closedAt: serverTimestamp(), closedByEmpNo: deps.myEmpNo(), closedByName: me.name,
        closeType: 'cancelled', closeNote: note,
        ...stamp
      },
      status: back ? { to: ticket.beforeStatus, reason: ticket.beforeReasonCode || '', onlyIf: (s) => s?.status === 'fault' } : null,
      done: `${ticket.machineId} 的報修已取消`
    };
  } else if (kind === 'reassign') {
    const who = picked('who');
    if (!who) return fail('請選要改派給誰');
    const name = $('rp-body').querySelector(`.rp-chip[data-group="who"][data-value="${CSS.escape(who)}"]`)?.dataset.name || '';
    plan = {
      update: { assignedEmpNo: who, assignedName: name, ...stamp },
      done: `${ticket.machineId} 已改派給 ${name}`
    };
  }
  if (!plan) return null;
  fail('');
  deps.setBusy($('rp-ok'), true, '送出中…');
  try {
    await writePlan(plan, ticket, machine);
  } catch (err) {
    fail(err?.code === 'permission-denied'
      ? '存不進去：這張單或機台狀態可能剛被別人改過，或你沒有權限。請關掉視窗、重新整理再試一次。'
      : deps.errorMessage(err));
  } finally {
    deps.setBusy($('rp-ok'), false);
  }
  return null;
}

// 把一個步驟寫進資料庫：報修單＋（需要時）目前狀態＋事件紀錄，一次寫入
async function writePlan(plan, ticket, machine) {
  const { db, collection, doc, writeBatch, serverTimestamp } = deps;
  const me = deps.getMe();
  const mid = ticket?.machineId || machine.machineId;
  const deptId = ticket?.deptId || machine.deptId;
  const ref = plan.ref || doc(db, 'repairs', ticket.id);
  const batch = writeBatch(db);

  // 退回紀錄的時間：陣列裡不能放「伺服器時間」，改用這台裝置的時間（安全規則容許前後 5 分鐘）
  if (plan.reworkTime) {
    const list = plan.update.reworks;
    list[list.length - 1].rejectedAt = deps.Timestamp.now();
  }

  // 機台狀態：先跟資料庫要最新的，條件不符（被別人改過）就不動
  if (plan.status) {
    const now = plan.statusNow !== undefined ? plan.statusNow : await currentStatus(mid);
    const want = plan.status;
    const allowed = want.onlyIf ? want.onlyIf(now) : true;
    const same = now && now.status === want.to && (now.reasonCode || '') === (want.reason || '');
    if (allowed && !same) {
      const shiftSetting = deps.getShiftSetting();
      const { prodDate, shiftId } = deps.prodDateAndShift(new Date(), shiftSetting);
      if (!shiftId) throw new Error('現在的時間不在任何班別裡，請檢查班別設定');
      const eventRef = doc(collection(db, 'machineEvents'));
      batch.set(eventRef, {
        eventType: 'statusChange',
        machineId: mid, deptId,
        fromStatus: now ? now.status : null,
        fromStatusSince: now ? now.statusSince : null,
        toStatus: want.to,
        reasonCode: want.reason || '',
        note: now?.note || '', partNo: now?.partNo || '', opNo: now?.opNo || '',
        prodDate, shiftId,
        repairId: ref.id,                     // 對應哪一張報修單
        createdAt: serverTimestamp(), createdByEmpNo: deps.myEmpNo(), createdByName: me.name
      });
      batch.set(doc(db, 'machineStatus', mid), {
        machineId: mid, deptId,
        status: want.to, reasonCode: want.reason || '',
        note: now?.note || '', partNo: now?.partNo || '', opNo: now?.opNo || '',
        statusSince: serverTimestamp(),
        lastEventId: eventRef.id,
        updatedAt: serverTimestamp(), updatedByEmpNo: deps.myEmpNo(), updatedByName: me.name
      });
    }
  }
  if (plan.set) batch.set(ref, plan.set);
  else batch.update(ref, plan.update);

  const commit = batch.commit();
  const slow = new Promise((resolve) => { setTimeout(() => resolve('slow'), SLOW_MS); });
  const result = await Promise.race([commit.then(() => 'ok'), slow]);
  $('dlg-repair').close();
  if (result === 'ok') {
    deps.toast(plan.done);
  } else {
    deps.toast('網路不穩：已先記在這台裝置，連線恢復後會自動送出（這個頁面先不要關）', 'error');
    commit.then(() => deps.toast(plan.done))
      .catch((err) => deps.toast(`沒有存進去：${deps.errorMessage(err)}`, 'error'));
  }
}

// ============================================================
// 小工具
// ============================================================
function ms(t) { return t && typeof t.toMillis === 'function' ? t.toMillis() : 0; }

async function currentStatus(machineId) {
  const snap = await deps.getDocFromServer(deps.doc(deps.db, 'machineStatus', machineId));
  return snap.exists() ? snap.data() : null;
}

// 新報修單要派給誰：負責人；負責人休假中而且有代理人 → 代理人
export function assigneeOf(cfg) {
  if (!cfg?.ownerEmpNo) return null;
  if (cfg.ownerAway === true && cfg.proxyEmpNo) return { empNo: cfg.proxyEmpNo, name: cfg.proxyName || cfg.proxyEmpNo };
  return { empNo: cfg.ownerEmpNo, name: cfg.ownerName || cfg.ownerEmpNo };
}

// 改派可以選的人：負責人、代理人，加上頁面給的名單（管理者才讀得到全部人員）
async function assigneeChoices() {
  const cfg = deps.getRepairSetting();
  const map = new Map();
  if (cfg?.ownerEmpNo) map.set(cfg.ownerEmpNo, `${cfg.ownerName || cfg.ownerEmpNo}（負責人）`);
  if (cfg?.proxyEmpNo) map.set(cfg.proxyEmpNo, `${cfg.proxyName || cfg.proxyEmpNo}（代理人）`);
  const extra = deps.listAssignees ? await deps.listAssignees() : [];
  extra.forEach((p) => { if (!map.has(p.empNo)) map.set(p.empNo, p.name); });
  return [...map].map(([code, label]) => ({ code, label, name: label.replace(/（.*）$/, '') }));
}

function activeFaults(dept) {
  return (dept?.reasons?.fault || []).filter((r) => r.active !== false);
}

function reasonText(dept, code) {
  if (!code) return '';
  return dept?.reasons?.fault?.find((r) => r.code === code)?.label || code;
}

function statusText(dept, status, reason) {
  if (!status) return '';
  const label = dept?.statuses?.find((s) => s.code === status)?.label || status;
  const r = reason ? (dept?.reasons?.[status]?.find((x) => x.code === reason)?.label || reason) : '';
  return r ? `${label}／${r}` : label;
}

function chips(group, list, selected) {
  const esc = deps.escapeHtml;
  return list.map((r) => `<button type="button" class="rp-chip" data-group="${group}" data-value="${esc(r.code)}"`
    + `${r.name ? ` data-name="${esc(r.name)}"` : ''} aria-pressed="${r.code === selected}">${esc(r.label)}</button>`).join('');
}

// 卡片右上角：等了多久、修了多久、剩多久自動結案
function elapsedText(t, stage, now) {
  const f = deps.formatDuration;
  if (stage === 'open') return `等待 ${f(now - ms(t.reportedAt))}`;
  if (stage === 'repairing') return `維修中 ${f(now - ms(t.startedAt))}`;
  if (stage === 'pendingAccept') return `待驗收 ${f(now - ms(t.doneAt))}`;
  if (stage === 'closed' && t.doneAt) return `停機到修好 ${f(ms(t.doneAt) - ms(t.reportedAt))}`;
  return '';
}
