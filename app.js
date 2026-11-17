/* 时间质押 · 零依赖，数据只存在本机 localStorage */
'use strict';

var LS_RECORDS = 'ts_records_v1';
var LS_ACTIVE = 'ts_active_v1';
var LS_ABANDONS = 'ts_abandons_v1';
var LS_THEME = 'ts_theme_v1';
var MAX_STAKE_MS = 12 * 3600 * 1000; // 单次质押超过 12 小时自动结算

var CATEGORIES = [
  { name: '学习', icon: '📚' },
  { name: '阅读', icon: '📖' },
  { name: '运动', icon: '🏃' },
  { name: '工作', icon: '💼' },
  { name: '自定义', icon: '✏️' }
];
var DURATIONS = [15, 25, 45, 60, 90, 120];
var TEMPLATES = [
  { cat: '阅读', goal: '晨读 30 分钟', dur: 30 },
  { cat: '学习', goal: '背单词', dur: 25 },
  { cat: '工作', goal: '深度工作，不碰手机', dur: 90 }
];
var GAIN_TAGS = ['学会了新方法', '背完单词', '读完一章', '写完作业', '跑完步', '思路理清了'];
var DONUT_COLORS = ['#c8402a', '#c98a1b', '#2e7d4f', '#3e6fa3', '#7a5ea8', '#b85c8a', '#5a8a6a', '#8a6d4b'];
var ACHIEVED_LABEL = { done: '达成', partial: '部分达成', missed: '未达成' };

/* ---------- 工具 ---------- */
function $(s) { return document.querySelector(s); }
function $all(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function pad(n) { return (n < 10 ? '0' : '') + n; }
function dateKey(ts) {
  var d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function fmtClock(ms) {
  var s = Math.max(0, Math.floor(ms / 1000));
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h > 0 ? pad(h) + ':' : '') + pad(m) + ':' + pad(ss);
}
function fmtMinutes(mins) {
  mins = Math.round(mins);
  if (mins < 1) return '不到 1 分钟';
  if (mins < 60) return mins + ' 分钟';
  var h = Math.floor(mins / 60), m = mins % 60;
  return h + ' 小时' + (m ? ' ' + m + ' 分钟' : '');
}
function fmtDateTime(ts) {
  var d = new Date(ts);
  return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function toast(msg) {
  var t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(function () { t.classList.remove('show'); }, 2600);
}
/* ---------- 通用确认弹窗（替代原生 confirm，避免在某些浏览器里弹不出） ---------- */
var confirmResolve = null;
function askConfirm(msg, okText) {
  return new Promise(function (resolve) {
    confirmResolve = resolve;
    $('#confirm-msg').textContent = msg;
    $('#confirm-ok-btn').textContent = okText || '确定';
    $('#confirm-sheet').classList.remove('hidden');
  });
}
$('#confirm-cancel-btn').addEventListener('click', function () {
  $('#confirm-sheet').classList.add('hidden');
  if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
});
$('#confirm-ok-btn').addEventListener('click', function () {
  $('#confirm-sheet').classList.add('hidden');
  if (confirmResolve) { confirmResolve(true); confirmResolve = null; }
});

function loadJSON(key, fallback) {
  try {
    var v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 存储满了就静默失败 */ }
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* ---------- 状态 ---------- */
var records = loadJSON(LS_RECORDS, []);
var active = loadJSON(LS_ACTIVE, null);
var abandons = loadJSON(LS_ABANDONS, {});
var selCat = '学习';
var selDur = 25; // 分钟；0 = 不限时；'custom' = 自定义
var ledgerCat = '全部';
var ledgerDate = '';
var currentView = 'stake';
var settleAchieved = 'done';
var settleFocus = null;
var detailId = null;
var detailAchieved = 'done';
var detailFocus = null;
var wakeLock = null;

/* ---------- 计时核心：时间戳差值 ---------- */
function elapsedMs(a) {
  var now = Date.now();
  var paused = a.totalPausedMs + (a.pauseStart ? now - a.pauseStart : 0);
  return Math.max(0, now - a.startTime - paused);
}
function pausedMs(a) {
  return a.totalPausedMs + (a.pauseStart ? Date.now() - a.pauseStart : 0);
}
function saveActive() { saveJSON(LS_ACTIVE, active); }
function saveRecords() { saveJSON(LS_RECORDS, records); }

function requestWakeLock() {
  try {
    if (navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
    }
  } catch (e) {}
}
function releaseWakeLock() {
  try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {}
}

/* ---------- 到时提醒：响铃 + 震动 + 系统通知 ---------- */
var audioCtx = null;
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) {}
}
function beep(times) {
  if (!audioCtx) return;
  try {
    for (var i = 0; i < times; i++) {
      (function (i) {
        var t0 = audioCtx.currentTime + i * 0.35;
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.001, t0);
        gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
        osc.start(t0);
        osc.stop(t0 + 0.3);
      })(i);
    }
  } catch (e) {}
}
function notifyEnd() {
  try { if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]); } catch (e) {}
  beep(3);
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      var n = new Notification('时间质押 · 时间到', {
        body: '「' + active.goal + '」质押时间到了，该结算收获了！',
        icon: 'icon.svg',
        tag: 'stake-end'
      });
      n.onclick = function () { try { window.focus(); } catch (e) {} };
    }
  } catch (e) {}
}
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && active && !active.pauseStart) requestWakeLock();
});

/* ---------- 统计计算 ---------- */
function settledRecords() { return records.filter(function (r) { return r.status !== 'abandoned'; }); }
function minutesOn(key) {
  return settledRecords().reduce(function (sum, r) {
    return sum + (dateKey(r.endTime) === key ? r.actualMinutes : 0);
  }, 0);
}
function calcStreak() {
  var days = {};
  settledRecords().forEach(function (r) { days[dateKey(r.endTime)] = true; });
  var d = new Date();
  if (!days[dateKey(d.getTime())]) d.setDate(d.getDate() - 1); // 今天还没质押，从昨天往前数
  var streak = 0;
  while (days[dateKey(d.getTime())]) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}
function calcRate() {
  var planned = settledRecords().filter(function (r) { return r.plannedMinutes > 0; });
  if (!planned.length) return null;
  var ok = planned.filter(function (r) { return r.actualMinutes >= r.plannedMinutes; }).length;
  return { rate: Math.round(ok / planned.length * 100), ok: ok, total: planned.length };
}

/* ---------- 视图切换 ---------- */
function updateBanner() {
  var b = $('#active-banner');
  if (!active || currentView === 'stake') { b.classList.add('hidden'); return; }
  b.textContent = '⏳ 质押中 ' + fmtClock(elapsedMs(active)) + ' · ' + active.category + ' · 点我回到计时';
  b.classList.remove('hidden');
}
$('#active-banner').addEventListener('click', function () { switchView('stake'); });

function switchView(name) {
  currentView = name;
  ['stake', 'ledger', 'stats'].forEach(function (v) {
    $('#view-' + v).classList.toggle('hidden', v !== name);
  });
  $all('nav button').forEach(function (b) {
    b.classList.toggle('on', b.getAttribute('data-view') === name);
  });
  if (name === 'ledger') renderLedger();
  if (name === 'stats') renderStats();
  updateBanner();
  window.scrollTo(0, 0);
}
$all('nav button').forEach(function (b) {
  b.addEventListener('click', function () { switchView(b.getAttribute('data-view')); });
});

/* ---------- 立约表单 ---------- */
function renderCatChips() {
  $('#cat-chips').innerHTML = CATEGORIES.map(function (c) {
    return '<button class="chip' + (selCat === c.name ? ' on' : '') + '" data-cat="' + c.name + '">' + c.icon + ' ' + c.name + '</button>';
  }).join('');
  $('#custom-cat-wrap').classList.toggle('hidden', selCat !== '自定义');
}
function renderDurChips() {
  var html = DURATIONS.map(function (d) {
    return '<button class="chip' + (selDur === d ? ' on' : '') + '" data-dur="' + d + '">' + d + ' 分钟</button>';
  }).join('');
  html += '<button class="chip' + (selDur === 'custom' ? ' on' : '') + '" data-dur="custom">自定义</button>';
  html += '<button class="chip' + (selDur === 0 ? ' on' : '') + '" data-dur="0">不限时</button>';
  $('#dur-chips').innerHTML = html;
  $('#custom-dur-wrap').classList.toggle('hidden', selDur !== 'custom');
}
function renderTemplates() {
  $('#template-chips').innerHTML = TEMPLATES.map(function (t, i) {
    return '<button class="chip small" data-tpl="' + i + '">⚡ ' + esc(t.goal) + ' · ' + t.dur + ' 分钟</button>';
  }).join('');
}
$('#cat-chips').addEventListener('click', function (e) {
  var b = e.target.closest('[data-cat]');
  if (!b) return;
  selCat = b.getAttribute('data-cat');
  renderCatChips();
});
$('#dur-chips').addEventListener('click', function (e) {
  var b = e.target.closest('[data-dur]');
  if (!b) return;
  var v = b.getAttribute('data-dur');
  selDur = v === 'custom' ? 'custom' : parseInt(v, 10);
  renderDurChips();
});
$('#template-chips').addEventListener('click', function (e) {
  var b = e.target.closest('[data-tpl]');
  if (!b) return;
  var t = TEMPLATES[parseInt(b.getAttribute('data-tpl'), 10)];
  selCat = t.cat;
  selDur = DURATIONS.indexOf(t.dur) >= 0 ? t.dur : 'custom';
  if (selDur === 'custom') $('#custom-dur').value = t.dur;
  $('#goal-input').value = t.goal;
  renderCatChips();
  renderDurChips();
});

$('#start-btn').addEventListener('click', function () {
  var goal = $('#goal-input').value.trim();
  if (!goal) { toast('先立个约：写一句话目标'); $('#goal-input').focus(); return; }
  var cat = selCat;
  if (cat === '自定义') {
    cat = $('#custom-cat').value.trim() || '自定义';
  }
  var planned = 0;
  if (selDur === 'custom') {
    planned = parseInt($('#custom-dur').value, 10);
    if (!planned || planned < 1 || planned > 720) { toast('自定义时长填 1–720 分钟'); $('#custom-dur').focus(); return; }
  } else {
    planned = selDur;
  }
  active = {
    id: uid(), category: cat, goal: goal, plannedMinutes: planned,
    startTime: Date.now(), totalPausedMs: 0, pauseStart: null,
    interruptions: 0, notified: false
  };
  saveActive();
  // 开始质押时顺便申请通知权限（必须在用户手势里触发才有效）
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  } catch (e) {}
  ensureAudio();
  renderStake();
  requestWakeLock();
  toast('质押开始，专心干吧 💪');
});

/* ---------- 计时器渲染 ---------- */
function renderStake() {
  var hasActive = !!active;
  $('#stake-form').classList.toggle('hidden', hasActive);
  $('#stake-timer').classList.toggle('hidden', !hasActive);
  $('#active-dot').classList.toggle('hidden', !hasActive);
  updateBanner();
  if (hasActive) {
    $('#timer-goal').textContent = '🎯 ' + active.goal;
    tick();
  }
}
function tick() {
  if (!active) return;
  var el = elapsedMs(active);
  if (el >= MAX_STAKE_MS) { autoSettle(); return; }
  $('#timer-main').textContent = fmtClock(el);
  var paused = active.pauseStart != null;
  $('#timer-status').textContent = paused ? '已 暂 停' : '质押进行中';
  $('#pause-btn').textContent = paused ? '继续' : '暂停';
  var sub = $('#timer-sub');
  if (active.plannedMinutes > 0) {
    var remain = active.plannedMinutes * 60000 - el;
    if (remain >= 0) {
      sub.textContent = '剩余 ' + fmtClock(remain) + ' · 计划 ' + active.plannedMinutes + ' 分钟';
      sub.classList.remove('overtime');
    } else {
      sub.textContent = '已超时 ' + fmtClock(-remain) + ' · 该结算了';
      sub.classList.add('overtime');
    }
    $('#timer-progress').style.width = Math.min(100, el / (active.plannedMinutes * 60000) * 100) + '%';
    if (!active.notified && el >= active.plannedMinutes * 60000) {
      active.notified = true;
      saveActive();
      notifyEnd();
      if ($('#recovery-sheet').classList.contains('hidden')) openSettle();
    }
  } else {
    sub.textContent = '不限时 · 已质押 ' + fmtMinutes(el / 60000);
    sub.classList.remove('overtime');
    $('#timer-progress').style.width = '0%';
  }
  $('#meta-elapsed').textContent = fmtMinutes(el / 60000);
  $('#meta-interrupt').textContent = active.interruptions + ' 次';
  $('#meta-paused').textContent = fmtMinutes(pausedMs(active) / 60000);
  updateBanner();
}
setInterval(tick, 500);

$('#pause-btn').addEventListener('click', function () {
  if (!active) return;
  if (active.pauseStart) {
    active.totalPausedMs += Date.now() - active.pauseStart;
    active.pauseStart = null;
    requestWakeLock();
  } else {
    active.pauseStart = Date.now();
    releaseWakeLock();
  }
  saveActive();
  tick();
});
$('#interrupt-btn').addEventListener('click', function () {
  if (!active) return;
  active.interruptions++;
  saveActive();
  tick();
  toast('已记录 1 次打断');
});
$('#abandon-btn').addEventListener('click', function () {
  if (!active) return;
  askConfirm('确定放弃这次质押吗？它不会记入账本，但会记一次放弃。', '放弃').then(function (ok) {
    if (ok) abandonActive();
  });
});
function abandonActive() {
  var key = dateKey(Date.now());
  abandons[key] = (abandons[key] || 0) + 1;
  saveJSON(LS_ABANDONS, abandons);
  active = null;
  saveActive();
  releaseWakeLock();
  renderStake();
  renderStreakPill();
  toast('已放弃，下次继续');
}
function autoSettle() {
  if (!active) return;
  var el = elapsedMs(active);
  records.unshift({
    id: active.id, category: active.category, goal: active.goal,
    plannedMinutes: active.plannedMinutes, startTime: active.startTime,
    endTime: Date.now(), actualMinutes: Math.round(el / 6000) / 10,
    pausedMinutes: Math.round(pausedMs(active) / 6000) / 10,
    interruptions: active.interruptions, gain: '超时自动结算，未填写收获',
    achieved: 'missed', focusScore: null, note: '单次超过 12 小时，系统自动结算',
    status: 'auto', createdAt: Date.now()
  });
  saveRecords();
  active = null;
  saveActive();
  releaseWakeLock();
  renderStake();
  renderStreakPill();
  toast('上次质押超过 12 小时，已自动结算');
}

/* ---------- 结算 ---------- */
function openSettle() {
  if (!active) return;
  var el = elapsedMs(active);
  var actualMin = Math.round(el / 6000) / 10;
  $('#settle-goal').textContent = '🎯 ' + active.goal + ' · ' + active.category;
  $('#settle-actual').textContent = fmtMinutes(actualMin);
  $('#settle-planned').textContent = active.plannedMinutes > 0 ? active.plannedMinutes + ' 分钟' : '不限时';
  var f = $('#settle-fulfill');
  if (active.plannedMinutes > 0) {
    if (actualMin >= active.plannedMinutes) { f.textContent = '✓ 履约'; f.className = 'n fulfill-yes'; }
    else { f.textContent = '未履约'; f.className = 'n fulfill-no'; }
  } else { f.textContent = '不限时'; f.className = 'n'; }
  $('#gain-input').value = '';
  $('#note-input').value = '';
  settleAchieved = 'done';
  settleFocus = null;
  renderAchievedSeg($('#achieved-seg'), settleAchieved);
  renderStars($('#focus-stars'), settleFocus);
  $('#settle-confirm-btn').disabled = true;
  $('#settle-sheet').classList.remove('hidden');
}
function renderAchievedSeg(seg, val) {
  $all('#' + seg.id + ' button').forEach(function (b) {
    b.classList.toggle('on', b.getAttribute('data-v') === val);
  });
}
function renderStars(box, val) {
  $all('#' + box.id + ' button').forEach(function (b) {
    b.classList.toggle('on', val != null && parseInt(b.getAttribute('data-v'), 10) <= val);
  });
}
$('#achieved-seg').addEventListener('click', function (e) {
  var b = e.target.closest('[data-v]');
  if (!b) return;
  settleAchieved = b.getAttribute('data-v');
  renderAchievedSeg($('#achieved-seg'), settleAchieved);
});
$('#focus-stars').addEventListener('click', function (e) {
  var b = e.target.closest('[data-v]');
  if (!b) return;
  settleFocus = parseInt(b.getAttribute('data-v'), 10);
  renderStars($('#focus-stars'), settleFocus);
});
$('#gain-input').addEventListener('input', function () {
  $('#settle-confirm-btn').disabled = !$('#gain-input').value.trim();
});
$('#gain-tags').innerHTML = GAIN_TAGS.map(function (t) {
  return '<button class="chip small">' + esc(t) + '</button>';
}).join('');
$('#gain-tags').addEventListener('click', function (e) {
  var b = e.target.closest('.chip');
  if (!b) return;
  $('#gain-input').value = b.textContent;
  $('#settle-confirm-btn').disabled = false;
  $('#gain-input').focus();
});
$('#settle-early-btn').addEventListener('click', openSettle);
$('#settle-cancel-btn').addEventListener('click', function () {
  $('#settle-sheet').classList.add('hidden');
});
$('#settle-confirm-btn').addEventListener('click', function () {
  if (!active) return;
  if (!$('#gain-input').value.trim()) return;
  var el = elapsedMs(active);
  if (el < 60000) {
    askConfirm('这次不到 1 分钟，确认结算吗？', '确认结算').then(function (ok) { if (ok) doSettle(); });
    return;
  }
  doSettle();
});
function doSettle() {
  if (!active) return;
  var gain = $('#gain-input').value.trim();
  if (!gain) return;
  var el = elapsedMs(active);
  records.unshift({
    id: active.id, category: active.category, goal: active.goal,
    plannedMinutes: active.plannedMinutes, startTime: active.startTime,
    endTime: Date.now(), actualMinutes: Math.round(el / 6000) / 10,
    pausedMinutes: Math.round(pausedMs(active) / 6000) / 10,
    interruptions: active.interruptions, gain: gain,
    achieved: settleAchieved, focusScore: settleFocus,
    note: $('#note-input').value.trim(), status: 'settled', createdAt: Date.now()
  });
  saveRecords();
  active = null;
  saveActive();
  releaseWakeLock();
  $('#settle-sheet').classList.add('hidden');
  renderStake();
  renderStreakPill();
  toast('已记入账本 📒');
  switchView('ledger');
}

/* ---------- 账本 ---------- */
function ledgerCategories() {
  var set = {};
  records.forEach(function (r) { set[r.category] = true; });
  return ['全部'].concat(Object.keys(set));
}
function renderLedger() {
  var chips = ledgerCategories().map(function (c) {
    return '<button class="chip small' + (ledgerCat === c ? ' on' : '') + '" data-lcat="' + esc(c) + '">' + esc(c) + '</button>';
  }).join('');
  $('#ledger-cat-chips').innerHTML = chips;
  var list = records.filter(function (r) {
    if (ledgerCat !== '全部' && r.category !== ledgerCat) return false;
    if (ledgerDate && dateKey(r.endTime) !== ledgerDate) return false;
    return true;
  });
  var box = $('#ledger-list');
  if (!list.length) {
    box.innerHTML = '<div class="empty"><div class="big">📒</div>还没有质押记录<br>去「质押」页开始第一次质押吧</div>';
    return;
  }
  box.innerHTML = list.map(function (r) {
    var stars = r.focusScore ? '★'.repeat(r.focusScore) + '☆'.repeat(5 - r.focusScore) : '未评分';
    return '<div class="record" data-id="' + r.id + '">' +
      '<div class="r1"><span class="goal">' + esc(r.goal) + '</span>' +
      '<span class="mins">' + fmtMinutes(r.actualMinutes) + '</span></div>' +
      '<div class="gain">💎 ' + esc(r.gain) + '</div>' +
      '<div class="meta"><span class="cat-tag">' + esc(r.category) + '</span>' +
      '<span>' + fmtDateTime(r.endTime) + '</span>' +
      (r.plannedMinutes > 0 ? '<span>' + (r.actualMinutes >= r.plannedMinutes ? '✓ 履约' : '未履约') + '</span>' : '<span>不限时</span>') +
      '<span>' + ACHIEVED_LABEL[r.achieved] + '</span>' +
      '<span>' + stars + '</span>' +
      (r.interruptions ? '<span>被打断 ' + r.interruptions + ' 次</span>' : '') +
      (r.status === 'auto' ? '<span>自动结算</span>' : '') +
      '</div></div>';
  }).join('');
}
$('#ledger-cat-chips').addEventListener('click', function (e) {
  var b = e.target.closest('[data-lcat]');
  if (!b) return;
  ledgerCat = b.getAttribute('data-lcat');
  renderLedger();
});
$('#ledger-date').addEventListener('change', function () {
  ledgerDate = this.value;
  renderLedger();
});
$('#ledger-list').addEventListener('click', function (e) {
  var row = e.target.closest('.record');
  if (!row) return;
  openDetail(row.getAttribute('data-id'));
});

/* ---------- 记录详情 ---------- */
function openDetail(id) {
  var r = null;
  records.forEach(function (x) { if (x.id === id) r = x; });
  if (!r) return;
  detailId = id;
  detailAchieved = r.achieved;
  detailFocus = r.focusScore;
  $('#detail-title').textContent = r.goal;
  $('#detail-meta').textContent = r.category + ' · ' + fmtDateTime(r.startTime) + ' → ' + fmtDateTime(r.endTime) +
    ' · 实际 ' + fmtMinutes(r.actualMinutes) + ' / 计划 ' + (r.plannedMinutes > 0 ? r.plannedMinutes + ' 分钟' : '不限时') +
    (r.pausedMinutes > 0 ? ' · 暂停 ' + fmtMinutes(r.pausedMinutes) : '') +
    (r.interruptions ? ' · 被打断 ' + r.interruptions + ' 次' : '');
  $('#detail-gain').value = r.gain;
  $('#detail-note').value = r.note || '';
  renderAchievedSeg($('#detail-achieved-seg'), detailAchieved);
  renderStars($('#detail-stars'), detailFocus);
  $('#detail-sheet').classList.remove('hidden');
}
$('#detail-achieved-seg').addEventListener('click', function (e) {
  var b = e.target.closest('[data-v]');
  if (!b) return;
  detailAchieved = b.getAttribute('data-v');
  renderAchievedSeg($('#detail-achieved-seg'), detailAchieved);
});
$('#detail-stars').addEventListener('click', function (e) {
  var b = e.target.closest('[data-v]');
  if (!b) return;
  detailFocus = parseInt(b.getAttribute('data-v'), 10);
  renderStars($('#detail-stars'), detailFocus);
});
$('#detail-save-btn').addEventListener('click', function () {
  var gain = $('#detail-gain').value.trim();
  if (!gain) { toast('收获不能为空'); return; }
  records.forEach(function (r) {
    if (r.id === detailId) {
      r.gain = gain;
      r.achieved = detailAchieved;
      r.focusScore = detailFocus;
      r.note = $('#detail-note').value.trim();
    }
  });
  saveRecords();
  $('#detail-sheet').classList.add('hidden');
  renderLedger();
  renderStats();
  toast('已保存');
});
$('#detail-delete-btn').addEventListener('click', function () {
  askConfirm('确定删除这条记录吗？', '删除').then(function (ok) {
    if (!ok) return;
    records = records.filter(function (r) { return r.id !== detailId; });
    saveRecords();
    $('#detail-sheet').classList.add('hidden');
    renderLedger();
    renderStats();
    renderStreakPill();
    toast('已删除');
  });
});
$('#detail-close-btn').addEventListener('click', function () {
  $('#detail-sheet').classList.add('hidden');
});

/* ---------- 导出 / 清空 ---------- */
function download(filename, content, type) {
  var blob = new Blob([content], { type: type });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
$('#export-json-btn').addEventListener('click', function () {
  download('时间质押-记录.json', JSON.stringify(records, null, 2), 'application/json');
  toast('已导出 JSON');
});
$('#export-csv-btn').addEventListener('click', function () {
  var head = '日期,分类,目标,计划分钟,实际分钟,暂停分钟,被打断次数,收获,达成情况,专注度,备注\n';
  var rows = records.map(function (r) {
    var cells = [fmtDateTime(r.endTime), r.category, r.goal, r.plannedMinutes, r.actualMinutes,
      r.pausedMinutes, r.interruptions, r.gain, ACHIEVED_LABEL[r.achieved], r.focusScore || '', r.note || ''];
    return cells.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\n');
  download('时间质押-记录.csv', '﻿' + head + rows, 'text/csv;charset=utf-8');
  toast('已导出 CSV');
});
$('#clear-all-btn').addEventListener('click', function () {
  askConfirm('确定清空全部记录吗？此操作无法恢复，建议先导出备份。', '继续').then(function (ok) {
    if (!ok) return;
    askConfirm('真的全部删除？', '全部删除').then(function (ok2) {
      if (!ok2) return;
      records = [];
      abandons = {};
      active = null;
      saveRecords();
      saveJSON(LS_ABANDONS, abandons);
      saveActive();
      renderStake();
      renderLedger();
      renderStats();
      renderStreakPill();
      toast('已清空');
    });
  });
});

/* ---------- 统计 ---------- */
function renderStreakPill() {
  $('#streak-num').textContent = calcStreak();
}
function renderStats() {
  var todayKey = dateKey(Date.now());
  var todayMin = minutesOn(todayKey);
  $('#stat-today').textContent = Math.round(todayMin);
  var todayCount = settledRecords().filter(function (r) { return dateKey(r.endTime) === todayKey; }).length;
  var ab = abandons[todayKey] || 0;
  $('#stat-today-sub').textContent = '今日已结算 ' + todayCount + ' 次' + (ab ? ' · 放弃 ' + ab + ' 次' : '');

  $('#stat-streak').textContent = calcStreak() + ' 天';
  var rate = calcRate();
  $('#stat-rate').textContent = rate ? rate.rate + '%' : '—';
  $('#stat-gains').textContent = settledRecords().length;

  // 最近 7 天柱状图
  var weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var days = [];
  for (var i = 6; i >= 0; i--) {
    var d = new Date();
    d.setDate(d.getDate() - i);
    days.push({ key: dateKey(d.getTime()), label: i === 0 ? '今天' : weekDays[d.getDay()], mins: minutesOn(dateKey(d.getTime())) });
  }
  var max = Math.max(1, Math.max.apply(null, days.map(function (d) { return d.mins; })));
  $('#week-bars').innerHTML = days.map(function (d) {
    var h = Math.max(4, Math.round(d.mins / max * 78));
    return '<div class="bar' + (d.label === '今天' ? ' today' : '') + '">' +
      '<em>' + (d.mins > 0 ? Math.round(d.mins) : '') + '</em>' +
      '<i style="height:' + h + 'px"></i><span>' + d.label + '</span></div>';
  }).join('');

  // 分类占比
  var byCat = {};
  settledRecords().forEach(function (r) {
    byCat[r.category] = (byCat[r.category] || 0) + r.actualMinutes;
  });
  var cats = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; });
  var total = cats.reduce(function (s, c) { return s + byCat[c]; }, 0);
  if (!cats.length) {
    $('#donut').style.background = 'var(--line)';
    $('#donut-legend').innerHTML = '<p style="color:var(--ink2);font-size:14px">暂无数据，先去质押一次吧</p>';
    $('#stat-total').textContent = '';
  } else {
    var acc = 0;
    var segs = cats.map(function (c, i) {
      var from = acc / total * 360;
      acc += byCat[c];
      var to = acc / total * 360;
      return DONUT_COLORS[i % DONUT_COLORS.length] + ' ' + from + 'deg ' + to + 'deg';
    }).join(', ');
    $('#donut').style.background = 'conic-gradient(' + segs + ')';
    $('#donut-legend').innerHTML = cats.map(function (c, i) {
      return '<div><i style="background:' + DONUT_COLORS[i % DONUT_COLORS.length] + '"></i>' + esc(c) +
        '<span>' + fmtMinutes(byCat[c]) + ' · ' + Math.round(byCat[c] / total * 100) + '%</span></div>';
    }).join('');
    $('#stat-total').textContent = '累计质押 ' + fmtMinutes(total) + '，共 ' + settledRecords().length + ' 次结算。' +
      (rate ? '履约 ' + rate.ok + '/' + rate.total + ' 次（不限时不计入）。' : '');
  }

  // 收获墙
  var wall = settledRecords().slice(0, 30);
  $('#harvest-wall').innerHTML = wall.length ? wall.map(function (r) {
    return '<div class="wall-item"><p>💎 ' + esc(r.gain) + '</p>' +
      '<small>' + esc(r.category) + ' · ' + fmtDateTime(r.endTime) + ' · ' + fmtMinutes(r.actualMinutes) + '</small></div>';
  }).join('') : '<p style="color:var(--ink2);font-size:14px">收获墙还空着，第一次结算后这里会长出你的收获。</p>';
}

/* ---------- 主题 ---------- */
function effectiveTheme() {
  var saved = loadJSON(LS_THEME, 'auto');
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme() {
  var saved = loadJSON(LS_THEME, 'auto');
  document.documentElement.setAttribute('data-theme', saved);
  $('#theme-btn').textContent = effectiveTheme() === 'dark' ? '☀️' : '🌙';
}
$('#theme-btn').addEventListener('click', function () {
  var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  saveJSON(LS_THEME, next);
  applyTheme();
});

/* ---------- 异常恢复 ---------- */
function checkRecovery() {
  if (!active) return;
  if (sessionStorage.getItem('ts_session')) return; // 同一会话内刷新，静默恢复
  sessionStorage.setItem('ts_session', '1');
  var el = elapsedMs(active);
  $('#recovery-desc').textContent = '「' + active.goal + '」（' + active.category + '），已质押 ' +
    fmtMinutes(el / 60000) + '，要继续还是现在结算？';
  $('#recovery-sheet').classList.remove('hidden');
}
$('#recovery-continue-btn').addEventListener('click', function () {
  $('#recovery-sheet').classList.add('hidden');
  if (active && !active.pauseStart) requestWakeLock();
});
$('#recovery-settle-btn').addEventListener('click', function () {
  $('#recovery-sheet').classList.add('hidden');
  openSettle();
});
$('#recovery-abandon-btn').addEventListener('click', function () {
  askConfirm('确定放弃这次质押吗？', '放弃').then(function (ok) {
    if (!ok) return;
    $('#recovery-sheet').classList.add('hidden');
    abandonActive();
  });
});

/* ---------- 初始化 ---------- */
renderCatChips();
renderDurChips();
renderTemplates();
applyTheme();
renderStreakPill();
if (active && elapsedMs(active) >= MAX_STAKE_MS) {
  autoSettle();
} else {
  renderStake();
  checkRecovery();
}
renderLedger();
renderStats();
