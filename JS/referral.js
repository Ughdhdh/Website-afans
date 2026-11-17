/* AvakyanDrop: рефералы. Свой код из 5 цифр, ввод кода пригласившего (один раз, навсегда) и список рефералов с прибылью.
   Реферер получает 7% от прибыли реферала (считает сервер: ref_info / ref_set). */
(function () {
  'use strict';
  if (!document.getElementById('refList') || !window.Ava) return;
  var $ = function (id) { return document.getElementById(id); };
  var UNIT = ' б.';
  var guestEl = $('refGuest'), bodyEl = $('refBody'), codeEl = $('refCode'), copyBtn = $('refCopy');
  var form = $('refForm'), input = $('refInput'), sendBtn = $('refSend'), hint = $('refHint');
  var listEl = $('refList'), totalEl = $('refTotal'), msgEl = $('refMsg');
  var timer = null, busy = false, code = '';

  function fmt(n) { return Number(n).toFixed(2); }
  function setMsg(t, kind) { msgEl.textContent = t || ''; msgEl.className = 'ref-msg' + (kind ? ' ' + kind : ''); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function render(d) {
    code = d.code || '';
    codeEl.textContent = code || '-----';
    totalEl.textContent = d.list.length ? ('Заработано: ' + fmt(d.total) + UNIT) : '';
    if (d.referrer) {                        // реферера менять нельзя
      form.hidden = true;
      hint.textContent = 'Вы реферал игрока ' + d.referrer + '. Изменить это нельзя.';
    } else {
      form.hidden = false;
      hint.textContent = 'Ввести код можно один раз, изменить его потом нельзя.';
    }
    if (!d.list.length) { listEl.innerHTML = '<p class="ref-empty">Пока никого. Отправьте друзьям свой код.</p>'; return; }
    listEl.innerHTML = '<div class="ref-row head"><span>Игрок</span><span>Ваша прибыль</span></div>' +
      d.list.map(function (r) {
        return '<div class="ref-row"><span class="ref-name">' + esc(r.login) + '</span><span class="ref-earn">+' + fmt(r.earned) + UNIT + '</span></div>';
      }).join('');
  }

  function load(quiet) {
    if (!Ava.user) return;
    Ava.call('ref_info').then(render, function (e) { if (!quiet) setMsg(Ava.errText(e), 'bad'); });
  }

  copyBtn.addEventListener('click', function () {
    if (!code) return;
    var done = function () { copyBtn.textContent = 'Скопировано'; setTimeout(function () { copyBtn.textContent = 'Копировать'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, done); else done();
  });

  input.addEventListener('input', function () { input.value = input.value.replace(/\D/g, '').slice(0, 5); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var v = input.value.trim();
    if (!/^\d{5}$/.test(v)) { setMsg(Ava.errText({ message: 'BAD_CODE' }), 'bad'); return; }
    busy = true; sendBtn.disabled = true; setMsg('');
    Ava.call('ref_set', { p_code: v }).then(function (d) {
      input.value = ''; render(d); setMsg('Готово: вы стали рефералом ' + d.referrer + '.', 'good');
    }, function (err) { setMsg(Ava.errText(err), 'bad'); }).then(function () { busy = false; sendBtn.disabled = false; });
  });

  var lastId;
  Ava.onChange(function (u) {
    var id = u ? u.id : null;
    guestEl.hidden = !!u; bodyEl.hidden = !u;
    if (id === lastId) return;
    lastId = id; clearInterval(timer); setMsg('');
    if (!u) { totalEl.textContent = ''; return; }
    load();
    timer = setInterval(function () { if (!document.hidden) load(true); }, 20000);   // прибыль рефералов обновляется
  });
})();
