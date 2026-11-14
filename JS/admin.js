/* Админка: одобрение заявок, блокировка, пароль, баланс, заметки.
   Все действия проверяются на сервере (нужен аккаунт с is_admin). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var gate = $('gate'), gateMsg = $('gateMsg'), body = $('adminBody');
  var rows = $('rows'), listMsg = $('listMsg');
  var filter = 'pending';
  var accounts = [];

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function msg(node, text, ok) { node.textContent = text || ''; node.className = 'msg' + (ok ? ' ok' : ''); }

  var STATUS_RU = { pending: 'ожидает', approved: 'одобрен', blocked: 'заблокирован' };

  function render() {
    rows.textContent = '';
    var list = accounts.filter(function (a) { return filter === 'all' || a.status === 'pending'; });
    if (!list.length) {
      var tr = el('tr'); var td = el('td', 'empty', filter === 'all' ? 'Аккаунтов нет.' : 'Нет аккаунтов, ожидающих одобрения.');
      td.colSpan = 7; tr.appendChild(td); rows.appendChild(tr); return;
    }
    list.forEach(function (a) {
      var tr = el('tr');
      var n = el('td', '', a.name);
      if (a.is_admin) n.appendChild(el('span', 'badge admin', 'админ'));
      tr.appendChild(n);
      tr.appendChild(el('td', '', a.login));
      var st = el('td'); st.appendChild(el('span', 'badge ' + a.status, STATUS_RU[a.status] || a.status)); tr.appendChild(st);
      tr.appendChild(el('td', '', Ava.fmt(a.balance) + '\u00a0б.'));
      tr.appendChild(el('td', '', String(a.items)));
      tr.appendChild(el('td', 'note', a.note || ''));
      var act = el('td', 'act');
      if (a.status !== 'approved') act.appendChild(button('Одобрить', 'ok', function () { setStatus(a, 'approved'); }));
      if (a.status !== 'blocked' && !(Ava.user && a.id === Ava.user.id)) act.appendChild(button('Заблокировать', 'bad', function () { setStatus(a, 'blocked'); }));
      act.appendChild(button('Пароль', '', function () { resetPass(a); }));
      act.appendChild(button('Баланс', '', function () { adjust(a); }));
      act.appendChild(button('Заметка', '', function () { editNote(a); }));
      tr.appendChild(act);
      rows.appendChild(tr);
    });
  }
  function button(text, cls, fn) {
    var b = el('button', 'adm-btn' + (cls ? ' ' + cls : ''), text); b.type = 'button'; b.addEventListener('click', fn); return b;
  }

  function load() {
    msg(listMsg, 'Загрузка…', true);
    return Ava.call('admin_list_accounts').then(function (list) {
      accounts = list; msg(listMsg, ''); render();
    }, function (e) { msg(listMsg, Ava.errText(e)); });
  }

  function setStatus(a, status) {
    if (status === 'blocked' && !confirm('Заблокировать ' + a.name + '? Он будет выкинут из аккаунта.')) return;
    Ava.call('admin_set_status', { p_id: a.id, p_status: status }).then(load, function (e) { msg(listMsg, Ava.errText(e)); });
  }
  function resetPass(a) {
    var p = prompt('Новый пароль для ' + a.name + ' (от 4 символов):');
    if (p === null) return;
    Ava.call('admin_reset_password', { p_id: a.id, p_password: p }).then(function () { msg(listMsg, 'Пароль изменён, сессии пользователя сброшены.', true); },
      function (e) { msg(listMsg, Ava.errText(e)); });
  }
  function editNote(a) {
    var v = prompt('Заметка для ' + a.name + ' (до 500 символов, пусто = удалить):', a.note || '');
    if (v === null) return;
    Ava.call('admin_set_note', { p_id: a.id, p_note: v }).then(function () { msg(listMsg, 'Заметка сохранена.', true); return load(); },
      function (e) { msg(listMsg, Ava.errText(e)); });
  }
  function adjust(a) {
    var v = prompt('Изменить баланс ' + a.name + ' на сколько? (например 0.5 или -0.2)\nСейчас: ' + Ava.fmt(a.balance));
    if (v === null) return;
    var d = parseFloat(String(v).replace(',', '.'));
    if (!isFinite(d) || d === 0) { msg(listMsg, 'Введите число.'); return; }
    Ava.call('admin_adjust_balance', { p_id: a.id, p_delta: d, p_reason: 'admin panel' }).then(load, function (e) { msg(listMsg, Ava.errText(e)); });
  }

  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    filter = b.getAttribute('data-f');
    [].forEach.call($('tabs').children, function (x) { x.classList.toggle('on', x === b); });
    render();
  });

  // ---------- доступ ----------
  Ava.mount($('accMount'));
  var shown = null;
  function check(u) {
    if (shown === (u ? u.id : 0)) return;
    shown = u ? u.id : 0;
    body.hidden = true; gate.hidden = false;
    if (!u) { gateMsg.textContent = 'Войдите в аккаунт администратора.'; return; }
    if (!u.is_admin) { gateMsg.textContent = 'У этого аккаунта нет прав администратора.'; return; }
    gate.hidden = true; body.hidden = false;
    load();
  }
  Ava.onChange(check);
})();
