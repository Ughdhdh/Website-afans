/* AvakyanDrop: «Ударь енота» (удар крота) на виртуальные баллы.
   Игру ведёт сервер (whack_start / whack_turn / whack_cashout): он выбирает раскладку каждого хода и считает баллы.
   Гости могут сыграть демо (всё считается в браузере, баллы не начисляются). */
(function () {
  'use strict';
  if (!document.getElementById('whGrid') || !window.Ava) return;

  // ===================== НАСТРОЙКИ =====================
  var IMG = {
    raccoon: 'img/raccoon.png',        // ваш енот: PNG с прозрачным фоном (можно просто заменить файл)
    avakyan: 'img/avakyan-face.png'    // Авакян
  };
  var APPEAR_MS = 450;                 // сколько длится появление енотов до начала раунда (бить нельзя); больше, чем анимация в CSS
  var APPEAR_SPREAD_MS = 120;          // разброс начала появления между клетками
  var PAUSE_MS = 500;                  // пауза между раундами: еноты прячутся (бить нельзя)
  var MIN_CASH_TURNS = 5;              // после какого хода можно выводить (должно совпадать с SQL)
  // =====================================================

  var $ = function (id) { return document.getElementById(id); };
  var gridEl = $('whGrid'), timerEl = $('whTimer'), turnEl = $('whTurn'), totalEl = $('whTotal');
  var startBtn = $('whStart'), cashBtn = $('whCash'), msgEl = $('whMsg');
  var overEl = $('whOver'), overTitle = $('whOverTitle'), overText = $('whOverText');
  var UNIT = ' б.';

  function setMsg(text, kind) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.className = 'wh-msg' + (kind ? ' ' + kind : '');
  }

  var cells = [];                      // DOM-клетки
  var game = null;                     // {turn,total,canCash,cells,ms}
  var demo = false;
  var running = false, busy = false, cashPending = false;
  var hits = [], endTimer = null, nextTimer = null;
  var cur = { cells: [], ms: 0 };
  var nextAt = 0, cdTimer = null;      // местное время (мс), когда закончится кулдаун между играми

  function cooling() { return !demo && !!Ava.user && !game && nextAt > Date.now(); }
  function leftText() {
    var sec = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000)), m = Math.floor(sec / 60), r = sec % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  function tickCooldown() {
    var left = nextAt - Date.now();
    if (nextAt && left <= 0) {
      nextAt = 0; clearInterval(cdTimer);
      if (!game && !demo) { setMsg(''); if (overTitle.textContent === 'Еноты отдыхают') showOver('Ударь енота', 'Нажмите «Играть». Еноты +0.01, Авакян −1.'); }
      paintButtons(); return;
    }
    paintButtons();
  }
  // кулдаун из ответа сервера (next_at считается по часам сервера)
  function setCooldown(s) {
    clearInterval(cdTimer);
    nextAt = s && s.next_at ? Date.now() + (s.next_at - s.server_now) : 0;
    if (nextAt) { tickCooldown(); cdTimer = setInterval(tickCooldown, 1000); } else paintButtons();
  }

  function fmt(n) { return Number(n).toFixed(2); }
  function sgn(n) { return (n > 0 ? '+' : (n < 0 ? '−' : '')) + fmt(Math.abs(n)); }

  // ----- разметка поля -----
  for (var i = 0; i < 9; i++) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'wh-cell'; b.setAttribute('aria-label', 'Клетка ' + (i + 1));
    b.innerHTML = '<span class="wh-pop"><img alt="" draggable="false"></span><span class="wh-fx"></span>';
    (function (idx) {
      b.addEventListener('pointerdown', function (e) { e.preventDefault(); hit(idx); });
      b.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hit(idx); } });
    })(i);
    gridEl.appendChild(b); cells.push(b);
  }

  // ----- правила демо (те же, что на сервере) -----
  function demoMs(turn) { return Math.max(400, Math.round(800 * Math.pow(0.90, turn))); }
  function demoCells(turn) {
    var c = [0, 0, 0, 0, 0, 0, 0, 0, 0], a = 0, pos = [0, 1, 2, 3, 4, 5, 6, 7, 8], k;
    if (Math.random() < 0.5) a = Math.min(8, 1 + Math.floor(turn / 3));
    var r = Math.min(2 + Math.floor(Math.random() * 3), 9 - a);
    for (k = 8; k > 0; k--) { var j = Math.floor(Math.random() * (k + 1)), t = pos[k]; pos[k] = pos[j]; pos[j] = t; }
    for (k = 0; k < a; k++) c[pos[k]] = 2;
    for (k = a; k < a + r; k++) c[pos[k]] = 1;
    return c;
  }

  // ----- отрисовка -----
  function showOver(title, text) {
    overTitle.textContent = title; overText.textContent = text || '';
    overEl.classList.add('on');
  }
  function hideOver() { overEl.classList.remove('on'); }

  function paintStats() {
    turnEl.textContent = game ? (game.turn + 1) : 1;
    var t = game ? game.total : 0;
    totalEl.textContent = fmt(t) + UNIT + (demo ? ' (демо)' : '');
    totalEl.className = t < 0 ? 'neg' : (t > 0 ? 'pos' : '');
  }
  function paintButtons() {
    var inGame = !!game;
    startBtn.hidden = inGame && !paused;
    startBtn.disabled = busy || cooling();
    startBtn.textContent = paused ? 'Продолжить' : (cooling() ? leftText() : (Ava.user ? 'Играть' : 'Демо-игра'));
    var can = inGame && !demo && game.canCash;
    cashBtn.hidden = !inGame || demo;
    cashBtn.disabled = busy || !can || cashPending;
    if (inGame && !demo) {
      if (cashPending) cashBtn.textContent = 'Вывод после хода…';
      else if (can) cashBtn.textContent = 'Вывести ' + sgn(game.total) + UNIT;
      else cashBtn.textContent = 'Вывод после ' + MIN_CASH_TURNS + '-го хода (' + Math.min(game.turn, MIN_CASH_TURNS) + '/' + MIN_CASH_TURNS + ')';
    }
  }
  var paused = false;

  function clearBoard() {
    cells.forEach(function (c) { c.className = 'wh-cell'; var f = c.querySelector('.wh-fx'); f.textContent = ''; f.className = 'wh-fx'; });
    timerEl.style.transition = 'none'; timerEl.style.width = '0%';
  }

  // ход: 1) еноты вылезают (бить нельзя), 2) идёт раунд (бить можно), 3) раунд кончился, еноты прячутся (бить нельзя)
  function startRound(c, ms, remaining) {
    clearTimeout(endTimer); clearTimeout(nextTimer);
    cur = { cells: c, ms: ms }; hits = []; running = false; paused = false;
    clearBoard(); hideOver(); paintStats(); paintButtons();
    c.forEach(function (kind, i) {
      if (!kind) return;
      var cell = cells[i];
      cell.querySelector('img').src = kind === 2 ? IMG.avakyan : IMG.raccoon;
      cell.classList.add(kind === 2 ? 'ava' : 'rac');
      // небольшая случайная задержка выхода, чтобы появлялись не строго одновременно
      setTimeout(function () { if (cur.cells === c) cell.classList.add('up'); }, Math.random() * APPEAR_SPREAD_MS);
    });
    // полная полоса времени стоит, пока еноты вылезают
    timerEl.style.transition = 'none';
    timerEl.style.width = (remaining / ms * 100) + '%';
    endTimer = setTimeout(function () {
      if (cur.cells !== c) return;
      running = true;                                   // раунд начался: теперь по енотам можно кликать
      void timerEl.offsetWidth;
      timerEl.style.transition = 'width ' + remaining + 'ms linear';
      timerEl.style.width = '0%';
      endTimer = setTimeout(endRound, remaining);
    }, APPEAR_MS);
  }

  // запуск анимации «+0.01»: сбрасываем класс и перезапускаем CSS-анимацию (иначе в повторно задетой клетке она не играет)
  function popFx(fx, kind) {
    fx.className = 'wh-fx';
    void fx.offsetWidth;
    fx.className = 'wh-fx ' + kind;
  }

  function hit(i) {
    if (!running || hits.indexOf(i) >= 0 || !cur.cells[i]) return;
    hits.push(i);
    var cell = cells[i], fx = cell.querySelector('.wh-fx');
    if (cur.cells[i] === 1) {
      cell.classList.add('hit'); fx.textContent = '+0.01'; popFx(fx, 'good');
      game.total = Math.round((game.total + 0.01) * 100) / 100;
    } else {
      cell.classList.add('bad'); fx.textContent = '−1'; popFx(fx, 'evil');
      game.total = Math.round((game.total - 1) * 100) / 100;
    }
    paintStats();
  }

  // ----- конец хода -----
  function endRound() {
    if (!running) return;
    running = false;
    cells.forEach(function (c) { c.classList.remove('up'); });
    if (demo && game.turn + 1 >= 12) { gameOver('Демо окончено', 'Набрано ' + sgn(game.total) + UNIT); return; }
    if (demo) { afterTurn({ turn: game.turn + 1, total: game.total, canCash: false, cells: demoCells(game.turn + 1), ms: demoMs(game.turn + 1) }, null); return; }
    busy = true; paintButtons();
    var h = hits.slice();
    Ava.call('whack_turn', { p_hits: h }).then(function (s) {
      busy = false;
      var g = s.game;
      if (s.balance !== null && s.balance !== undefined) Ava.setBalance(s.balance);
      if (!g) {
        if (s.cashed !== undefined) {
          var c = Number(s.cashed);
          gameOver('Игра окончена: ' + sgn(c) + UNIT, 'Баланс: ' + fmt(s.balance) + UNIT);
        } else gameOver('Игра закончилась', 'Вы слишком долго не отвечали.');
        setCooldown(s);
        return;
      }
      afterTurn({ turn: g.turn, total: Number(g.total), canCash: !!g.can_cash, cells: g.cells, ms: g.ms }, s.last);
    }, function (e) {
      busy = false;
      setMsg(Ava.errText(e), 'bad');
      if (e.message === 'NO_GAME') { gameOver('Игра закончилась', Ava.errText(e)); return; }
      paused = true; paintButtons(); showOver('Связь прервалась', 'Нажмите «Продолжить».');
    });
  }

  function afterTurn(g, last) {
    var prev = game ? game.turn : 0;
    game = g;                       // сервер знает точный итог
    if (last) {
      var t = 'Ход ' + g.turn + ': ' + sgn(last.delta) + UNIT;
      if (last.avakyans) t += ' (задели Авакяна!)';
      setMsg(t, last.delta < 0 ? 'bad' : (last.delta > 0 ? 'good' : ''));
    }
    paintStats(); paintButtons();
    if (cashPending && game.canCash) { cashPending = false; doCash(); return; }
    nextTimer = setTimeout(function () { startRound(g.cells, g.ms, g.ms); }, PAUSE_MS);
  }

  function gameOver(title, text) {
    running = false; game = null; paused = false; cashPending = false; clearTimeout(endTimer); clearTimeout(nextTimer);
    clearBoard(); showOver(title, text); paintStats(); paintButtons();
  }

  // ----- кнопки -----
  function begin() {
    if (busy || cooling()) return;
    setMsg('');
    if (!Ava.user) {                // демо для гостей
      demo = true; game = { turn: 0, total: 0, canCash: false };
      startRound(demoCells(0), demoMs(0), demoMs(0));
      return;
    }
    demo = false; busy = true; paintButtons();
    Ava.call('whack_start').then(function (s) {
      busy = false;
      if (s.balance !== null && s.balance !== undefined) Ava.setBalance(s.balance);
      var g = s.game; if (!g) { paintButtons(); return; }
      resume(s);
    }, function (e) {
      busy = false; setMsg(Ava.errText(e), 'bad'); paintButtons();
      if (e.message === 'WH_COOLDOWN') Ava.call('whack_state').then(setCooldown, function () {});   // узнаём, сколько ждать
    });
  }

  // запустить (или продолжить) ход по ответу сервера
  function resume(s) {
    var g = s.game, now = s.server_now, elapsed = Math.max(0, now - g.round_at), left = g.ms - elapsed;
    game = { turn: g.turn, total: Number(g.total), canCash: !!g.can_cash, cells: g.cells, ms: g.ms };
    paused = false;
    if (left < 250) {               // ход почти или совсем истёк: отправим его как есть и пойдём дальше
      cur = { cells: g.cells, ms: g.ms }; hits = []; running = true; endRound(); return;
    }
    startRound(g.cells, g.ms, left);
  }

  function doCash() {
    if (busy) return;
    busy = true; paintButtons();
    Ava.call('whack_cashout').then(function (s) {
      busy = false;
      if (s.balance !== null && s.balance !== undefined) Ava.setBalance(s.balance);
      var c = Number(s.cashed);
      gameOver(c >= 0 ? 'Выведено ' + sgn(c) + UNIT : 'Списано ' + sgn(c) + UNIT, 'Баланс: ' + fmt(s.balance) + UNIT);
      setMsg('');
      setCooldown(s);
    }, function (e) {
      busy = false; setMsg(Ava.errText(e), 'bad');
      if (e.message === 'NO_GAME') gameOver('Игра закончилась', Ava.errText(e)); else { paintButtons(); nextTimer = setTimeout(function () { startRound(game.cells, game.ms, game.ms); }, PAUSE_MS); }
    });
  }

  startBtn.addEventListener('click', function () {
    if (paused && !demo) { busy = true; paintButtons(); Ava.call('whack_state').then(function (s) { busy = false; if (s.game) resume(s); else gameOver('Игра закончилась', ''); }, function (e) { busy = false; setMsg(Ava.errText(e), 'bad'); paintButtons(); }); return; }
    begin();
  });
  cashBtn.addEventListener('click', function () {
    if (!game || demo || !game.canCash || busy) return;
    if (running) { cashPending = true; paintButtons(); return; }   // дождёмся конца хода, чтобы клики засчитались
    doCash();
  });

  // ----- вход/выход -----
  var lastUser;
  Ava.onChange(function (u) {
    var id = u ? u.id : null;
    if (id === lastUser) { paintButtons(); return; }
    lastUser = id;
    clearTimeout(endTimer); clearTimeout(nextTimer);
    running = false; busy = false; cashPending = false; demo = false; game = null; paused = false;
    clearInterval(cdTimer); nextAt = 0;
    clearBoard(); paintStats();
    if (!u) { showOver('Ударь енота', 'Войдите в аккаунт, чтобы играть на баллы. Демо-игра доступна всем.'); paintButtons(); return; }
    Ava.rpc('whack_state', { p_token: Ava.token || null }).then(function (s) {
      if (s.game) {                 // игра осталась открытой: предложим продолжить
        game = { turn: s.game.turn, total: Number(s.game.total), canCash: !!s.game.can_cash };
        paused = true; paintStats(); paintButtons();
        showOver('Игра не закончена', 'Ход ' + (s.game.turn + 1) + ', в игре ' + fmt(s.game.total) + UNIT + '. Нажмите «Продолжить».');
      } else if (s.next_at) { setCooldown(s); showOver('Еноты отдыхают', 'Следующая игра станет доступна после кулдауна.'); }
      else { showOver('Ударь енота', 'Нажмите «Играть». Еноты +0.01, Авакян −1.'); paintButtons(); }
    }, function () { showOver('Ударь енота', 'Нажмите «Играть».'); paintButtons(); });
  });
})();
