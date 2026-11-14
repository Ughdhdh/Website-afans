/* Общий вход для всего сайта (фанклуб + AvakyanDrop).
   Подключение:  <script src="JS/auth.js"></script>
   На страницах фанклуба сам рисует плашку «Войти / ник · баланс» в правом верхнем углу.
   Атрибуты тега script:  data-theme="club|drop"   data-chip="none" (не рисовать плашку) */
(function () {
  'use strict';

  // ===== НАСТРОЙКА: ваш проект Supabase (тот же, что и на форуме) =====
  var SUPABASE_URL = 'https://jhqlomedjoereuaqpnso.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_sBsq4uxb2_qLOU4VQYDCNg_6tr7qcmz';   // публичный ключ, НЕ service_role!
  // ====================================================================

  var TOKEN_KEY = 'ava.token';
  var USER_KEY = 'ava.user';

  var script = document.currentScript;
  var base = script ? script.src.replace(/JS\/auth\.js.*$/, '') : '';
  var theme = (script && script.getAttribute('data-theme')) || 'club';
  var wantChip = !(script && script.getAttribute('data-chip') === 'none');

  // подключаем стили
  if (!document.querySelector('link[href$="CSS/auth.css"]')) {     // на страницах стили подключены в <head> заранее
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = base + 'CSS/auth.css';
    document.head.appendChild(css);
  }

  // ---------- хранилище ----------
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  var Ava = {
    base: base,
    token: lsGet(TOKEN_KEY),
    user: null,
    ready: null
  };
  try { Ava.user = JSON.parse(lsGet(USER_KEY) || 'null'); } catch (e) {}
  if (!Ava.token) Ava.user = null;

  var listeners = [];
  Ava.onChange = function (fn) { listeners.push(fn); if (Ava.user !== undefined) fn(Ava.user); };
  function emit() { listeners.forEach(function (fn) { try { fn(Ava.user); } catch (e) {} }); }

  // ---------- тексты ошибок ----------
  var ERRORS = {
    BAD_CREDENTIALS: 'Неверный логин или пароль.',
    PENDING: 'Аккаунт ещё не одобрен администратором. Попробуйте позже.',
    BLOCKED: 'Аккаунт заблокирован.',
    TOO_MANY: 'Слишком много попыток входа. Подождите 10 минут.',
    AUTH_REQUIRED: 'Войдите в аккаунт.',
    NOT_APPROVED: 'Аккаунт не одобрен администратором.',
    FORBIDDEN: 'Недостаточно прав.',
    COOLDOWN: 'Крутка ещё недоступна.',
    NO_FUNDS: 'Недостаточно баллов.',
    BAD_AMOUNT: 'Неверная сумма ставки (от 0.01 до 1000).',
    BAD_AUTO: 'Автовывод: множитель от 1.01 до 1000.',
    BAD_SLOT: 'Неверная ячейка ставки.',
    ALREADY_BET: 'Ставка уже сделана.',
    ROUND_STARTED: 'Раунд уже начался. Дождитесь следующего.',
    NOT_STARTED: 'Раунд ещё не начался.',
    NO_BET: 'Ставка не найдена.',
    TOO_FAST: 'Не так быстро, подождите несколько секунд.',
    BAD_MESSAGE: 'Сообщение должно быть от 1 до 500 символов.',
    NICK_RESERVED: 'Этот ник принадлежит зарегистрированному участнику. Выберите другой или войдите.',
    LOGIN_TAKEN: 'Такой логин уже занят. Придумайте другой.',
    NAME_TAKEN: 'Участник с таким ФИО уже есть.',
    BAD_LOGIN: 'Логин: от 3 до 80 символов.',
    BAD_NAME: 'Заполните фамилию, имя и отчество (вместе не длиннее 100 символов).',
    TOO_MANY_APPS: 'Сейчас слишком много заявок. Попробуйте через час.',
    BAD_NOTE: 'Заметка: не длиннее 500 символов.',
    BAD_PASSWORD: 'Пароль: от 4 до 72 символов.',
    BAD_STATUS: 'Неверный статус.',
    SELF: 'Нельзя менять статус самому себе.',
    ALREADY_FLYING: 'Самолёт уже в воздухе.',
    NO_ACCOUNT: 'Аккаунт не найден.',
    NO_PRIZES: 'Призы ещё не настроены.',
    NETWORK: 'Нет связи с сервером. Попробуйте позже.'
  };
  Ava.errText = function (e) {
    var m = (e && e.message) || '';
    return ERRORS[m] || ('Ошибка: ' + (m || 'неизвестная'));
  };

  // ---------- запросы к серверу ----------
  Ava.rpc = function (fn, args) {
    return fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {})
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) {
          var code = (j && j.message) || 'HTTP_' + r.status;
          var err = new Error(code);
          err.code = code;
          if (code === 'AUTH_REQUIRED' && Ava.token) dropSession();   // сессия закончилась или аккаунт заблокирован
          throw err;
        }
        return j;
      });
    }, function () { throw new Error('NETWORK'); });
  };

  // то же, но с подстановкой токена
  Ava.call = function (fn, args) {
    var a = Object.assign({}, args || {});
    a.p_token = Ava.token;
    return Ava.rpc(fn, a);
  };

  function dropSession() {
    Ava.token = null; Ava.user = null;
    lsDel(TOKEN_KEY); lsDel(USER_KEY);
    emit();
  }
  function setUser(u) {
    Ava.user = u;
    lsSet(USER_KEY, JSON.stringify(u));
    emit();
  }

  Ava.login = function (login, password) {
    return Ava.rpc('auth_login', { p_login: login, p_password: password }).then(function (res) {
      if (!res.ok) { var e = new Error(res.error); e.code = res.error; throw e; }
      Ava.token = res.token;
      lsSet(TOKEN_KEY, res.token);
      setUser(res.user);
      return res.user;
    });
  };

  Ava.logout = function () {
    var t = Ava.token;
    dropSession();
    if (t) Ava.rpc('auth_logout', { p_token: t }).catch(function () {});
  };

  Ava.refresh = function () {
    if (!Ava.token) return Promise.resolve(null);
    return Ava.rpc('auth_me', { p_token: Ava.token }).then(function (u) { setUser(u); return u; },
      function (e) { if (e.message !== 'NETWORK') dropSession(); return null; });
  };

  // баланс обновился (после крутки, ставки и т.п.)
  // Пока идёт анимация рулетки, новый баланс придерживается (hold), чтобы не раскрыть приз раньше времени
  var pendingBalance = null;
  Ava.hold = false;
  Ava.setBalance = function (b) {
    if (!Ava.user) return;
    b = Number(b);
    if (Ava.hold) { pendingBalance = b; return; }
    if (Number(Ava.user.balance) === b) return;     // ничего не изменилось — не перерисовываем
    Ava.user.balance = b;
    setUser(Ava.user);
  };
  Ava.release = function () {
    Ava.hold = false;
    if (pendingBalance !== null) { var p = pendingBalance; pendingBalance = null; Ava.setBalance(p); }
  };

  Ava.fmt = function (n) { return Number(n || 0).toFixed(2); };

  // ---------- окно входа ----------
  var modal = null;
  function buildModal() {
    var ov = document.createElement('div');
    ov.className = 'ava-overlay';
    ov.setAttribute('data-theme', theme);
    ov.hidden = true;

    var box = document.createElement('form');
    box.className = 'ava-modal';
    box.setAttribute('autocomplete', 'on');

    var h = document.createElement('h3');
    h.textContent = 'Вход в аккаунт';

    function field(labelText, type, name, ac) {
      var l = document.createElement('label');
      l.textContent = labelText;
      var i = document.createElement('input');
      i.type = type; i.name = name; i.required = true; i.autocomplete = ac; i.maxLength = 80;
      l.appendChild(i);
      return l;
    }
    var fl = field('Логин', 'text', 'login', 'username');
    var fp = field('Пароль', 'password', 'password', 'current-password');

    var err = document.createElement('p');
    err.className = 'ava-err';
    err.setAttribute('role', 'alert');

    var row = document.createElement('div');
    row.className = 'ava-row';
    var ok = document.createElement('button');
    ok.type = 'submit'; ok.className = 'ava-btn ava-btn-main'; ok.textContent = 'Войти';
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'ava-btn'; cancel.textContent = 'Отмена';
    row.appendChild(ok); row.appendChild(cancel);

    var hint = document.createElement('p');
    hint.className = 'ava-hint';
    hint.appendChild(document.createTextNode('Нет аккаунта? Аккаунты выдаёт администратор после '));
    var a = document.createElement('a');
    a.href = base + 'form.html'; a.textContent = 'заявки на вступление';
    hint.appendChild(a);
    hint.appendChild(document.createTextNode('.'));

    box.appendChild(h); box.appendChild(fl); box.appendChild(fp);
    box.appendChild(err); box.appendChild(row); box.appendChild(hint);
    ov.appendChild(box);
    document.body.appendChild(ov);

    function close() { ov.hidden = true; err.textContent = ''; box.password.value = ''; }
    cancel.addEventListener('click', close);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !ov.hidden) close(); });

    box.addEventListener('submit', function (e) {
      e.preventDefault();
      err.textContent = '';
      ok.disabled = true;
      Ava.login(box.login.value.trim(), box.password.value).then(function () {
        close();
      }, function (ex) {
        err.textContent = Ava.errText(ex);
      }).then(function () { ok.disabled = false; });
    });

    return { el: ov, form: box, close: close };
  }

  Ava.openLogin = function () {
    if (!modal) modal = buildModal();
    modal.el.setAttribute('data-theme', theme);
    modal.el.hidden = false;
    modal.form.login.focus();
  };


// ---------- виджет аккаунта ----------
// mount(контейнер, {links:[{href,text}]}) — рисует «Войти» либо ссылки и «Выйти»
Ava.mount = function (el, opts) {
  opts = opts || {};
  el.setAttribute('data-theme', opts.theme || theme);
  function render(u) {
    el.textContent = '';
    el.classList.add('ava-acc');
    if (!u) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'ava-btn ava-btn-main'; b.textContent = 'Войти';
      b.addEventListener('click', Ava.openLogin);
      el.appendChild(b);
      return;
    }

    // Имя и баланс показываем только на AvakyanDrop (opts.showInfo = true), на страницах фанклуба только кнопки
    var showInfo = opts.showInfo !== undefined ? opts.showInfo : window.location.pathname.endsWith('avadrop.html');
    if (showInfo) {
      var name = document.createElement('span');
      name.className = 'ava-name'; name.textContent = u.name;
      var bal = document.createElement('span');
      bal.className = 'ava-bal'; bal.textContent = Ava.fmt(u.balance) + '\u00a0б.';
      bal.title = 'Баланс в баллах (б.)';
      el.appendChild(name); el.appendChild(bal);
    }

    (opts.links || []).forEach(function (l) {
      var a = document.createElement('a');
      a.href = l.href; a.className = 'ava-btn'; a.textContent = l.text;
      el.appendChild(a);
    });

    if (u.is_admin) {
      var ad = document.createElement('a');
      ad.href = base + 'admin.html'; ad.className = 'ava-btn'; ad.textContent = 'Админка';
      el.appendChild(ad);
    }

    var out = document.createElement('button');
    out.type = 'button'; out.className = 'ava-btn'; out.textContent = 'Выйти';
    out.addEventListener('click', Ava.logout);
    el.appendChild(out);
  }
  Ava.onChange(render);
};



  // ---------- плашка на страницах фанклуба ----------
  function initChip() {
    if (!wantChip) return;
    var links = [{ href: base + 'avadrop.html', text: 'AvakyanDrop' }];
    var slot = document.querySelector('.ava-slot');          // готовое место в панели .hbar внутри header
    if (slot) { Ava.mount(slot, { links: links }); return; }

    var chip = document.createElement('div');                // главная: плашка поверх видео внутри header
    chip.className = 'ava-chip';
    chip.setAttribute('data-theme', theme);
    var header = document.querySelector('header');
    (header || document.body).appendChild(chip);
    Ava.mount(chip, { links: links });
  }


  function start() {
    initChip();
    Ava.ready = Ava.refresh();     // проверяем сохранённую сессию и обновляем баланс
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.Ava = Ava;
})();
