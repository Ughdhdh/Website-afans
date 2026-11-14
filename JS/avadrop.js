/* AvakyanDrop: рулетка + инвентарь.
   Приз, кулдаун и баллы определяет СЕРВЕР (SQL-функции drop_spin / drop_guest_spin).
   Страница только крутит анимацию до того приза, который выбрал сервер. */
(function () {
  'use strict';

  // ===================== НАСТРОЙКИ (меняйте здесь) =====================
  var CONFIG = {
    sounds: {
      spin: 'sounds/spin.wav',                                          // звук прокрутки
      prize: function (p) { return 'sounds/prize-' + p.id + '.wav'; },  // у каждого предмета свой: prize-1.wav ... prize-7.wav
      prizeDelay: 600       // мс: звук приза играет после появления результата в окне (оно проявляется 0.5 с)
    },
    // Видео-эффект для легендарных предметов (WebM с прозрачным фоном), например 'img/fx/legendary.webm'.
    // Пусто или файла нет, тогда играет анимация-взрыв.
    legendaryVideo: '',
    legendaryVideoFallback: ''      // необязательно: запасной файл для Safari, например 'img/fx/legendary.mov' (HEVC с альфа-каналом)
  };
  // =====================================================================

  var STRIP_LEN = 60;          // длина ленты
  var WIN_INDEX = 50;          // позиция выигрышной ячейки
  var SPIN_MS = 10670;          // длительность анимации
  var GUEST_KEY = 'avakyanDrop.guest';
  var SOUND_KEY = 'avakyanDrop.sound';

  var RARITY_RU = { common: 'Обычный', rare: 'Редкий', epic: 'Эпический', legendary: 'Легендарный' };

  var $ = function (id) { return document.getElementById(id); };
  var panel = $('roulette'), win = $('dropWindow'), track = $('dropTrack'), result = $('dropResult');
  var btn = $('dropBtn'), paidBtn = $('dropPaid'), note = $('dropNote'), sub = $('dropSub');
  var guestWarn = $('dropGuest'), legend = $('dropLegend'), sndBtn = $('dropSound');
  var fx = $('dropFx'), video = $('dropVideo');
  var invGrid = $('invGrid'), invTotal = $('invTotal');

  var cfg = { cooldown_ms: 4 * 3600 * 1000, paid_cost: 0.05 };   // уточняется с сервера (drop_config)
  var prizes = [];
  var spinning = false;
  var nextAt = 0;              // когда можно крутить бесплатно (время браузера, мс), 0 = можно
  var timer = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function pic(p) {
    var d = el('div', 'pic');
    if (p.img) { var i = el('img'); i.src = p.img; i.alt = ''; d.appendChild(i); }
    else d.textContent = '?';
    return d;
  }
  function pad(n) { return String(n).padStart(2, '0'); }

  // ===================== звук =====================
  var soundOn = true;
  try { soundOn = localStorage.getItem(SOUND_KEY) !== 'off'; } catch (e) {}
  var spinAudio = null;

  function renderSoundBtn() {
    sndBtn.textContent = 'Звук: ' + (soundOn ? 'вкл' : 'выкл');
    sndBtn.classList.toggle('off', !soundOn);
    sndBtn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
  }
  sndBtn.addEventListener('click', function () {
    soundOn = !soundOn;
    try { localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off'); } catch (e) {}
    if (!soundOn) stopSpinSound();
    renderSoundBtn();
  });
  renderSoundBtn();

  function play(src) {
    if (!soundOn || !src) return null;
    try {
      var a = new Audio(src);
      a.volume = 0.8;
      var pr = a.play();
      if (pr && pr.catch) pr.catch(function () {});     // файла нет или браузер не разрешил: молча пропускаем
      return a;
    } catch (e) { return null; }
  }
  function startSpinSound() { stopSpinSound(); spinAudio = play(CONFIG.sounds.spin); }
  function stopSpinSound() {
    if (spinAudio) { try { spinAudio.pause(); spinAudio.currentTime = 0; } catch (e) {} spinAudio = null; }
  }

  // ===================== эффект для легендарных =====================
  var fxRunning = false;

  function legendaryFx() {
    panel.classList.remove('shake'); void panel.offsetWidth; panel.classList.add('shake');
    setTimeout(function () { panel.classList.remove('shake'); }, 700);
    if (CONFIG.legendaryVideo) playVideoFx(); else explosion();
  }

  function playVideoFx() {
    video.textContent = '';
    var s1 = document.createElement('source');
    s1.src = CONFIG.legendaryVideo;
    video.appendChild(s1);
    if (CONFIG.legendaryVideoFallback) {
      var s2 = document.createElement('source');
      s2.src = CONFIG.legendaryVideoFallback;
      video.appendChild(s2);
    }
    video.hidden = false;
    var fell = false;
    function fallback() { if (fell) return; fell = true; video.hidden = true; explosion(); }
    video.onended = function () { video.hidden = true; };
    video.onerror = fallback;
    s1.addEventListener('error', function () { if (!CONFIG.legendaryVideoFallback) fallback(); });
    video.load();
    var pr = video.play();
    if (pr && pr.catch) pr.catch(fallback);
  }

  // запасной (и стандартный) вариант: взрыв из искр + ударная волна + вспышка
  function explosion() {
    if (fxRunning) return;
    fxRunning = true;
    var r = panel.getBoundingClientRect(), wr = win.getBoundingClientRect();
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    fx.width = Math.round(r.width * dpr); fx.height = Math.round(r.height * dpr);
    var c = fx.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    var cx = wr.left - r.left + wr.width / 2, cy = wr.top - r.top + wr.height / 2;
    var colors = ['#fde68a', '#fbbf24', '#f97316', '#ffffff', '#e879f9', '#a855f7'];
    var parts = [];
    for (var i = 0; i < 240; i++) {
      var a = Math.random() * Math.PI * 2, sp = 100 + Math.random() * 460;
      parts.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80, r: 2.5 + Math.random() * 4.5, c: colors[i % colors.length], life: 1, d: 0.9 + Math.random() * 0.9 });
    }
    var t0 = performance.now(), last = t0, DUR = 2300;
    (function loop(now) {
      var dt = Math.min(0.05, (now - last) / 1000), t = now - t0; last = now;
      c.clearRect(0, 0, r.width, r.height);
      // вспышка
      if (t < 450) {
        var g = c.createRadialGradient(cx, cy, 0, cx, cy, r.width * 0.6);
        var al = (1 - t / 450) * 0.75;
        g.addColorStop(0, 'rgba(255,245,200,' + al + ')'); g.addColorStop(1, 'rgba(255,245,200,0)');
        c.fillStyle = g; c.fillRect(0, 0, r.width, r.height);
      }
      // ударные волны
      [0, 180].forEach(function (delay) {
        var k = (t - delay) / 900;
        if (k > 0 && k < 1) {
          c.strokeStyle = 'rgba(253,230,138,' + (1 - k) + ')'; c.lineWidth = 6 * (1 - k) + 1;
          c.beginPath(); c.arc(cx, cy, k * r.width * 0.45, 0, Math.PI * 2); c.stroke();
        }
      });
      // искры
      parts.forEach(function (p) {
        p.vy += 380 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.99;
        p.life -= dt / p.d;
        if (p.life <= 0) return;
        c.globalAlpha = Math.max(0, p.life); c.fillStyle = p.c;
        c.beginPath(); c.arc(p.x, p.y, p.r * (0.5 + p.life / 2), 0, Math.PI * 2); c.fill();
      });
      c.globalAlpha = 1;
      if (t < DUR) requestAnimationFrame(loop);
      else { c.clearRect(0, 0, r.width, r.height); fxRunning = false; }
    })(t0);
  }

  // ===================== лента =====================
  function itemNode(p) {
    var d = el('div', 'drop-item rar-' + p.rarity);
    d.appendChild(pic(p));
    d.appendChild(el('span', '', p.name));
    return d;
  }
  function randomPrize() { return prizes[Math.floor(Math.random() * prizes.length)]; }

  function build(winner) {
    track.textContent = '';
    for (var i = 0; i < STRIP_LEN; i++) track.appendChild(itemNode(i === WIN_INDEX && winner ? winner : randomPrize()));
  }
  function centerOffset(index, jitter) {
    var it = track.children[index];
    return it.offsetLeft + it.offsetWidth / 2 + (jitter || 0) - win.clientWidth / 2;
  }

  // ===================== результат в окне =====================
  function showResult(p, logged) {
    result.textContent = '';
    result.className = 'drop-result rar-' + p.rarity + ' show';
    result.appendChild(pic(p));
    var t = el('div', 'txt');
    t.appendChild(el('small', '', 'Вам выпало:'));
    t.appendChild(el('strong', '', p.name));
    t.appendChild(el('span', 'rar', RARITY_RU[p.rarity] || p.rarity));
    t.appendChild(el('em', '', logged ? '+' + Ava.fmt(p.reward) + '\u00a0б. и предмет в инвентаре' : 'Войдите, чтобы забрать предмет'));
    result.appendChild(t);
  }
  function hideResult() { result.className = 'drop-result'; }

  // ===================== кулдаун и кнопки =====================
  function hoursText() {
    var h = cfg.cooldown_ms / 3600000;
    return Number.isInteger(h) ? String(h) : h.toFixed(1);
  }
  function updatePaid() {
    paidBtn.textContent = 'Ещё раз за ' + Ava.fmt(cfg.paid_cost) + '\u00a0б.';
    if (!Ava.user) {
      paidBtn.disabled = spinning || !prizes.length;
      paidBtn.title = 'Войдите в аккаунт, чтобы крутить за баллы';
      return;
    }
    var enough = Number(Ava.user.balance) + 1e-9 >= cfg.paid_cost;
    paidBtn.disabled = spinning || !prizes.length || !enough;
    paidBtn.title = enough ? 'Дополнительная крутка за баллы (бесплатная не тратится)' : 'Не хватает баллов';
  }

  function tick() {
    if (spinning) return;
    var left = nextAt - Date.now();
    if (left <= 0) { unlock(); return; }
    var h = Math.floor(left / 3600000), m = Math.floor(left % 3600000 / 60000), s = Math.floor(left % 60000 / 1000);
    note.textContent = 'Бесплатная крутка через ' + pad(h) + ':' + pad(m) + ':' + pad(s);
  }
  function lock(untilMs) {
    nextAt = untilMs;
    btn.disabled = true;
    clearInterval(timer);
    tick();
    timer = setInterval(tick, 1000);
  }
  function unlock() {
    clearInterval(timer);
    nextAt = 0;
    if (!spinning) { hideResult(); btn.disabled = false; note.textContent = 'Бесплатная крутка готова!'; }
  }
  function afterSpin() {            // вернуть кнопки в правильное состояние
    spinning = false;
    if (nextAt > Date.now()) { btn.disabled = true; tick(); }
    else unlock();
    updatePaid();
  }

  function guestLast() {
    try { return JSON.parse(localStorage.getItem(GUEST_KEY) || 'null'); } catch (e) { return null; }
  }

  function refreshStatus() {
    if (!prizes.length || spinning) return;
    guestWarn.hidden = !!Ava.user;
    if (Ava.user) {
      Ava.call('drop_status').then(function (s) {
        var off = s.server_now - Date.now();
        if (s.next_spin_at) {
          if (s.last_prize) showResult(s.last_prize, true);
          lock(s.next_spin_at - off);
        } else unlock();
      }, function (e) { note.textContent = Ava.errText(e); });
    } else {
      var g = guestLast();
      if (g && g.until > Date.now()) {
        var p = prizes.filter(function (x) { return x.id === g.id; })[0];
        if (p) showResult(p, false);
        lock(g.until);
      } else unlock();
    }
  }

  // ===================== крутка =====================
  function animateTo(prize, done) {
    track.style.transition = 'none';
    track.style.transform = 'translateX(0)';
    build(prize);
    void track.offsetWidth;
    var w = track.children[WIN_INDEX].offsetWidth;
    var target = centerOffset(WIN_INDEX, (Math.random() - 0.5) * w * 0.7);

    var dur = SPIN_MS;

    track.style.setProperty('transition', 'transform ' + dur + 'ms cubic-bezier(0.15, 0.85, 0.35, 1)', 'important');
    track.style.transform = 'translateX(' + (-target) + 'px)';
    startSpinSound();
    
    var fired = false;
    function finish(e) {
      // 3. Игнорируем завершение анимаций у дочерних карточек и картинок
      if (e && e.target !== track) return;
      if (fired) return;
      fired = true;
      track.removeEventListener('transitionend', finish);
      stopSpinSound();
      done();
    }
    track.addEventListener('transitionend', finish);
    setTimeout(finish, dur + 400);
  }


  function spin(paid) {
    if (spinning || !prizes.length) return;
    if (!paid && nextAt > Date.now()) return;
    if (paid && !Ava.user) { Ava.openLogin(); return; }
    spinning = true;
    btn.disabled = true;
    paidBtn.disabled = true;
    note.textContent = 'Крутим…';
    hideResult();
    var logged = !!Ava.user;
    if (logged) Ava.hold = true;       // баланс в шапке обновится после остановки ленты

    var req = logged ? Ava.call('drop_spin', { p_paid: !!paid }) : Ava.rpc('drop_guest_spin');
    req.then(function (res) {
      if (!res.ok) {                   // бесплатная крутка ещё на кулдауне
        Ava.release();
        nextAt = res.next_spin_at - (res.server_now - Date.now());
        afterSpin();
        return;
      }
      animateTo(res.prize, function () {
        showResult(res.prize, logged);
        setTimeout(function () { play(CONFIG.sounds.prize(res.prize)); }, CONFIG.sounds.prizeDelay);   // после анимации появления
        if (res.prize.rarity === 'legendary') legendaryFx();
        if (logged) {
          Ava.setBalance(res.balance);
          Ava.release();
          if (res.next_spin_at) nextAt = res.next_spin_at - (res.server_now - Date.now());
          loadInventory();
        } else {
          var until = Date.now() + cfg.cooldown_ms;
          try { localStorage.setItem(GUEST_KEY, JSON.stringify({ id: res.prize.id, until: until })); } catch (e) {}
          nextAt = until;
        }
        if (nextAt > Date.now()) { clearInterval(timer); timer = setInterval(tick, 1000); }
        afterSpin();
      });
    }, function (e) {
      Ava.release();
      afterSpin();
      note.textContent = Ava.errText(e);
    });
  }

  // ===================== легенда наград =====================
  function renderLegend() {
    legend.textContent = '';
    ['common', 'rare', 'epic', 'legendary'].forEach(function (r) {
      var p = prizes.filter(function (x) { return x.rarity === r; })[0];
      if (!p) return;
      var li = el('li', 'rar-' + r);
      li.appendChild(document.createTextNode(RARITY_RU[r] + ': '));
      li.appendChild(el('b', '', '+' + Ava.fmt(p.reward) + '\u00a0б.'));
      legend.appendChild(li);
    });
  }

  // ===================== инвентарь =====================
  function loadInventory() {
    invGrid.textContent = '';
    if (!Ava.user) {
      invTotal.textContent = '';
      invGrid.appendChild(el('div', 'inv-empty', 'Войдите в аккаунт, чтобы увидеть свой инвентарь.'));
      return;
    }
    Ava.call('my_inventory').then(function (inv) {
      invGrid.textContent = '';
      invTotal.textContent = inv.total + ' ' + plural(inv.total, 'предмет', 'предмета', 'предметов');
      if (!inv.total) invGrid.appendChild(el('div', 'inv-empty', 'Пока пусто. Покрутите рулетку, и предметы появятся здесь.'));
      inv.items.forEach(function (it) {
        var c = el('div', 'inv-card rar-' + it.rarity + (it.count ? '' : ' none'));
        if (it.count) c.appendChild(el('span', 'cnt', '×' + it.count));
        c.appendChild(pic(it));
        c.appendChild(el('span', '', it.count ? it.name : '???'));
        c.appendChild(el('span', 'rn', RARITY_RU[it.rarity]));
        invGrid.appendChild(c);
      });
    }, function (e) { invGrid.appendChild(el('div', 'inv-empty', Ava.errText(e))); });
  }
  function plural(n, a, b, c) {
    var m = n % 100, k = n % 10;
    if (m > 10 && m < 15) return c;
    return k === 1 ? a : (k >= 2 && k <= 4 ? b : c);
  }

  // ===================== старт =====================
  Ava.mount($('accMount'), { showInfo: true });
  $('dropLogin').addEventListener('click', Ava.openLogin);
  btn.addEventListener('click', function () { spin(false); });
  paidBtn.addEventListener('click', function () { spin(true); });

  var lastUserId = undefined;
  Ava.onChange(function (u) {
    updatePaid();                              // баланс мог измениться
    var id = u ? u.id : null;
    if (id === lastUserId) return;             // обновился только баланс: статус перезагружать не нужно
    lastUserId = id;
    loadInventory();
    clearInterval(timer);
    nextAt = 0;
    hideResult();
    refreshStatus();
  });

  Ava.rpc('drop_config').then(function (c) {
    cfg = c;
    sub.textContent = 'Бесплатная крутка раз в ' + hoursText() + ' ч. Предметы падают в инвентарь, за каждый начисляются баллы.';
  }, function () {}).then(function () {
    return Ava.rpc('drop_prizes');
  }).then(function (list) {
    prizes = list;
    build(null);
    renderLegend();
    updatePaid();
    refreshStatus();
  }, function (e) {
    note.textContent = Ava.errText(e);
  });
})();
