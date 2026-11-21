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
      prizeDelay: 300       // мс: звук приза играет после появления результата в окне (оно проявляется 0.5 с)
    },
    // Видео-эффект ТОЛЬКО для мифических предметов (у легендарных обычная анимация-взрыв).
    // Пусто или файла нет, тогда вместо видео играет анимация-взрыв.
    // Сейчас лежит чёрная заглушка: замените файлы img/fx/mythic.webm и img/fx/mythic.mp4 своими.
    mythicVideo: 'img/fx/mythic.webm',
    mythicVideoFallback: 'img/fx/mythic.mp4'      // запасной файл для Safari/iOS (H.264)
  };
  // =====================================================================

  var STRIP_LEN = 60;          // длина ленты
  var WIN_INDEX = 50;          // позиция выигрышной ячейки
  var SPIN_MS = 10670;          // длительность анимации
  var GUEST_KEY = 'avakyanDrop.guest';
  var SOUND_KEY = 'avakyanDrop.sound';
  var SKIP_KEY = 'avakyanDrop.skip';

  var RARITY_RU = { common: 'Обычный', rare: 'Редкий', epic: 'Эпический', legendary: 'Легендарный', mythic: 'Мифический' };

  var $ = function (id) { return document.getElementById(id); };
  var panel = $('roulette'), win = $('dropWindow'), track = $('dropTrack'), result = $('dropResult');
  var btn = $('dropBtn'), sub = $('dropSub'), timerEl = null;
  var guestWarn = $('dropGuest'), legend = $('dropLegend'), sndBtn = $('dropSound'), skipBtn = $('dropSkip');
  var fx = $('dropFx'), video = $('dropVideo'), videoCv = $('dropVideoCv');
  var IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var invGrid = $('invGrid'), invTotal = $('invTotal');

  var cfg = { cooldown_ms: 2 * 3600 * 1000, premium_cooldown_ms: 3600 * 1000, paid_cost: 0.05 };   // уточняется с сервера (drop_config)
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
    sndBtn.textContent = (soundOn ? '🔊' : '🔇');
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

  // ===== скип анимации: прокрутки и её звука нет, сразу показывается выпавший предмет и играет его звук =====
  var skipOn = false;
  try { skipOn = localStorage.getItem(SKIP_KEY) === 'on'; } catch (e) {}
  var finishNow = null;                 // завершить идущую прокрутку немедленно
  function renderSkipBtn() {
    skipBtn.textContent = '⏭︎';
    skipBtn.classList.toggle('on', skipOn);
    skipBtn.setAttribute('aria-pressed', skipOn ? 'true' : 'false');
  }
  skipBtn.addEventListener('click', function () {
    skipOn = !skipOn;
    try { localStorage.setItem(SKIP_KEY, skipOn ? 'on' : 'off'); } catch (e) {}
    renderSkipBtn();
    if (skipOn && finishNow) finishNow();          // включили во время прокрутки: сразу к результату
  });
  renderSkipBtn();

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
  // прослушать звук предмета из инвентаря (кнопка ▶ на карточке; только для предметов, которые у игрока есть)
  var invAudio = null, invBtn = null;
  function stopPreview() {
    if (invAudio) { try { invAudio.pause(); invAudio.currentTime = 0; } catch (e) {} }
    if (invBtn) { invBtn.textContent = '\u25B6'; invBtn.classList.remove('on'); }
    invAudio = null; invBtn = null;
  }
  function previewSound(it, btn) {
    var same = invBtn === btn;
    stopPreview();
    if (same) return;                                   // повторное нажатие: стоп
    try {
      var a = new Audio(CONFIG.sounds.prize(it));
      a.volume = 0.8;
      invAudio = a; invBtn = btn;
      btn.textContent = '\u25A0'; btn.classList.add('on');
      a.addEventListener('ended', function () { if (invAudio === a) stopPreview(); });
      a.addEventListener('error', function () { if (invAudio === a) stopPreview(); });   // файла нет
      var pr = a.play();
      if (pr && pr.catch) pr.catch(function () { if (invAudio === a) stopPreview(); });
    } catch (e) { stopPreview(); }
  }
  function startSpinSound() { stopSpinSound(); spinAudio = play(CONFIG.sounds.spin); }
  function stopSpinSound() {
    if (spinAudio) { try { spinAudio.pause(); spinAudio.currentTime = 0; } catch (e) {} spinAudio = null; }
  }

  // ===================== эффект для легендарных =====================
  var fxRunning = false;

  function legendaryFx(rarity) {
    panel.classList.remove('shake'); void panel.offsetWidth; panel.classList.add('shake');
    setTimeout(function () { panel.classList.remove('shake'); }, 700);
    if (rarity === 'mythic' && CONFIG.mythicVideo) playVideoFx(); else if (rarity !== 'mythic') explosion();   // мифические: только видео, легендарные: взрыв
  }

  function playVideoFx() {
    video.textContent = '';
    // на iOS сначала MP4 (H.264): WebM там поддерживается не везде
    var urls = IOS && CONFIG.mythicVideoFallback ? [CONFIG.mythicVideoFallback, CONFIG.mythicVideo] : [CONFIG.mythicVideo, CONFIG.mythicVideoFallback];
    var s1;
    urls.forEach(function (u, i) {
      if (!u) return;
      var s = document.createElement('source'); s.src = u; video.appendChild(s); if (!s1) s1 = s;
    });
    video.muted = true; video.defaultMuted = true; video.playsInline = true;
    video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', '');
    var fell = false, cv = null;
    function done() { video.hidden = true; videoCv.hidden = true; video.classList.remove('src-hidden'); }
    function fallback(e) { if (fell) return; fell = true; done(); if (window.console) console.warn('Видео мифической не сработало:', e && (e.message || e.name || e.type) || e); }   // без запасного взрыва
    // iOS: рисуем кадры в canvas, а чёрный делаем прозрачным (яркость -> альфа)
    function startCanvas() {
      var w = 640, h = Math.max(1, Math.round(w * (video.videoHeight || 640) / (video.videoWidth || 1920)));
      videoCv.width = w; videoCv.height = h;
      var c = videoCv.getContext('2d', { willReadFrequently: true });
      videoCv.hidden = false;
      (function draw() {
        if (video.ended || video.hidden) { done(); return; }
        try {
          c.drawImage(video, 0, 0, w, h);
          var d = c.getImageData(0, 0, w, h), a = d.data;
          for (var i = 0; i < a.length; i += 4) {
            var m = a[i]; if (a[i + 1] > m) m = a[i + 1]; if (a[i + 2] > m) m = a[i + 2];
            if (m > 0) { a[i] = Math.min(255, a[i] * 255 / m); a[i + 1] = Math.min(255, a[i + 1] * 255 / m); a[i + 2] = Math.min(255, a[i + 2] * 255 / m); }
            a[i + 3] = m;
          }
          c.putImageData(d, 0, 0);
        } catch (e) { fallback(); return; }
        requestAnimationFrame(draw);
      })();
    }
    video.hidden = false;
    if (IOS) video.classList.add('src-hidden');
    video.onended = done;
    video.onerror = fallback;
    video.load();
    var pr = video.play();
    if (pr && pr.then) pr.then(function () { if (IOS) startCanvas(); }, fallback); else if (IOS) startCanvas();
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
  // Пока предмет ни разу не выпал, в ленте он приглушён, а вместо названия «???» (как в инвентаре)
  var owned = {};                                   // id предметов, которые уже есть в инвентаре
  function itemNode(p) {
    var has = !!owned[p.id];
    var d = el('div', 'drop-item rar-' + p.rarity + (has ? '' : ' locked'));
    d.setAttribute('data-id', p.id);
    d.appendChild(pic(p));
    d.appendChild(el('span', '', has ? p.name : '???'));
    return d;
  }
  function markOwned() {                            // обновить уже нарисованную ленту
    var kids = track.children;
    for (var i = 0; i < kids.length; i++) {
      var id = kids[i].getAttribute('data-id'), has = !!owned[id];
      kids[i].classList.toggle('locked', !has);
      var nm = kids[i].lastChild;
      if (!nm) continue;
      var p = prizes.filter(function (x) { return String(x.id) === id; })[0];
      nm.textContent = has && p ? p.name : '???';
    }
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
  function myCooldown() { return Ava.user && Ava.user.premium ? cfg.premium_cooldown_ms : cfg.cooldown_ms; }
  function hoursText() {
    var ms = myCooldown();
    if (ms < 3600000) return Math.round(ms / 60000) + ' мин';           // меньше часа: в минутах
    var h = ms / 3600000;
    return (Number.isInteger(h) ? String(h) : h.toFixed(1)) + ' ч';
  }
  // Одна кнопка на два режима:
  //  - бесплатная доступна: золотая «Крутить бесплатно»;
  //  - бесплатная на перезарядке: «Ещё за 0.05 б.» с таймером под надписью (крутка за баллы).
  function render() {
    if (spinning || !prizes.length) return;
    if (nextAt > Date.now()) {
      btn.className = 'paid-btn';
      btn.textContent = '';
      var l1 = document.createElement('span'); l1.textContent = 'Ещё за ' + Ava.fmt(cfg.paid_cost) + '\u00a0б.';
      timerEl = document.createElement('span'); timerEl.className = 'timer';
      btn.appendChild(l1); btn.appendChild(timerEl);
      tick();
      if (!Ava.user) { btn.disabled = false; btn.title = 'Войдите в аккаунт, чтобы крутить за баллы'; return; }
      var enough = Number(Ava.user.balance) + 1e-9 >= cfg.paid_cost;
      btn.disabled = !enough;
      btn.title = enough ? 'Дополнительная крутка за баллы (бесплатная не тратится)' : 'Не хватает баллов';
    } else {
      timerEl = null;
      btn.className = 'spin-btn';
      btn.textContent = 'Крутить бесплатно';
      btn.disabled = false; btn.title = '';
    }
  }
  function updatePaid() { render(); }

  function tick() {
    if (spinning) return;
    var left = nextAt - Date.now();
    if (left <= 0) { unlock(); return; }
    var h = Math.floor(left / 3600000), m = Math.floor(left % 3600000 / 60000), s = Math.floor(left % 60000 / 1000);
    if (timerEl) timerEl.textContent = pad(h) + ':' + pad(m) + ':' + pad(s);
  }
  function lock(untilMs) {
    nextAt = untilMs;
    clearInterval(timer);
    render();
    timer = setInterval(tick, 1000);
  }
  function unlock() {
    clearInterval(timer);
    nextAt = 0;
    if (!spinning) { hideResult(); render(); }
  }
  function afterSpin() {            // вернуть кнопки в правильное состояние
    spinning = false;
    if (nextAt > Date.now()) { clearInterval(timer); timer = setInterval(tick, 1000); render(); }
    else unlock();
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
      }, function (e) { btn.textContent = Ava.errText(e); });
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
    if (skipOn) {                                   // без анимации и звука прокрутки
      track.style.transition = 'none';
      build(prize);
      track.style.transform = 'translateX(' + (-centerOffset(WIN_INDEX, 0)) + 'px)';
      setTimeout(done, 0);
      return;
    }
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
    finishNow = function () {
      if (fired) return;
      track.style.setProperty('transition', 'none', 'important');
      track.style.transform = 'translateX(' + (-target) + 'px)';
      finish();
    };
    function finish(e) {
      // 3. Игнорируем завершение анимаций у дочерних карточек и картинок
      if (e && e.target !== track) return;
      if (fired) return;
      fired = true; finishNow = null;
      track.removeEventListener('transitionend', finish);
      stopSpinSound();
      done();
    }
    track.addEventListener('transitionend', finish);
    setTimeout(finish, dur + 400);
  }


  function spin() {
    if (spinning || !prizes.length) return;
    var paid = nextAt > Date.now();            // пока бесплатная на перезарядке, крутка идёт за баллы
    if (paid && !Ava.user) { Ava.openLogin(); return; }
    spinning = true;
    btn.disabled = true;
    btn.className = paid ? 'paid-btn' : 'spin-btn';
    btn.textContent = 'Крутим…';
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
        if (res.prize.rarity === 'legendary' || res.prize.rarity === 'mythic') legendaryFx(res.prize.rarity);
        if (logged) {
          Ava.setBalance(res.balance);
          Ava.release();
          if (res.next_spin_at) nextAt = res.next_spin_at - (res.server_now - Date.now());
          loadInventory();
        } else {
          var until = Date.now() + cfg.cooldown_ms;      // гость: обычный кулдаун
          try { localStorage.setItem(GUEST_KEY, JSON.stringify({ id: res.prize.id, until: until })); } catch (e) {}
          nextAt = until;
        }
        if (nextAt > Date.now()) { clearInterval(timer); timer = setInterval(tick, 1000); }
        afterSpin();
      });
    }, function (e) {
      Ava.release();
      afterSpin();
      btn.className = paid ? 'paid-btn' : 'spin-btn'; btn.textContent = Ava.errText(e);
    });
  }

  // ===================== легенда наград =====================
  function renderLegend() {
    legend.textContent = '';
    ['common', 'rare', 'epic', 'legendary', 'mythic'].forEach(function (r) {
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
    stopPreview();
    invGrid.textContent = '';
    if (!Ava.user) {
      owned = {}; markOwned();
      invTotal.textContent = '';
      invGrid.appendChild(el('div', 'inv-empty', 'Войдите в аккаунт, чтобы увидеть свой инвентарь.'));
      return;
    }
    Ava.call('my_inventory').then(function (inv) {
      invGrid.textContent = '';
      owned = {};
      inv.items.forEach(function (it) { if (it.count) owned[it.id] = true; });
      markOwned();
      invTotal.textContent = inv.total + ' ' + plural(inv.total, 'предмет', 'предмета', 'предметов');
      if (!inv.total) invGrid.appendChild(el('div', 'inv-empty', 'Пока пусто. Покрутите рулетку, и предметы появятся здесь.'));
      inv.items.forEach(function (it) {
        var c = el('div', 'inv-card rar-' + it.rarity + (it.count ? '' : ' none'));
        if (it.count) c.appendChild(el('span', 'cnt', '×' + it.count));
        var pbtn = null;
        if (it.count) {                                   // звук доступен только для имеющихся предметов
          var pb = el('button', 'inv-play', '\u25B6');
          pb.type = 'button'; pb.title = 'Проиграть звук'; pb.setAttribute('aria-label', 'Проиграть звук: ' + it.name);
          pb.addEventListener('click', function () { previewSound(it, pb); });
          pbtn = pb;
        }
        var pc = pic(it);
        if (pbtn) pc.appendChild(pbtn);                    // кнопка внутри картинки, в правом нижнем углу
        c.appendChild(pc);
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
  btn.addEventListener('click', spin);

  var lastUserId = undefined;
  function updateSub() {
    if (!cfg) return;
    sub.textContent = 'Бесплатная крутка раз в ' + hoursText() + (Ava.user && Ava.user.premium ? ' (премиум)' : '') + '. Предметы падают в инвентарь, за каждый начисляются баллы.';
  }
  Ava.onChange(function (u) {
    updatePaid(); updateSub();                              // баланс мог измениться
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
    updateSub();
  }, function () {}).then(function () {
    return Ava.rpc('drop_prizes');
  }).then(function (list) {
    prizes = list;
    build(null);
    renderLegend();
    updatePaid();
    refreshStatus();
  }, function (e) {
    btn.textContent = Ava.errText(e);
  });
})();
