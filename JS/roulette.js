/* AvakyanDrop — рулетка «Реклама». Одна крутка раз в 6 часов. */
(function () {
  'use strict';

  // ===== НАГРАДЫ (плейсхолдеры) — заменить на настоящие =====
  var PRIZES = [
    { id: 1, name: 'Летучка', rarity: 'common',      weight: 40, img: 'img/prizes/1.jpg' },
    { id: 2, name: 'Колоквиум', rarity: 'common',    weight: 20, img: 'img/prizes/2.jpg' },
    { id: 3, name: 'Контрольная', rarity: 'common',  weight: 19, img: 'img/prizes/3.jpg' },
    { id: 4, name: 'Нам бы...', rarity: 'rare',      weight: 10, img: 'img/prizes/4.jpg' },
    { id: 5, name: '7очка', rarity: 'epic',          weight: 7,  img: 'img/prizes/5.jpg' },
    { id: 6, name: '9очка', rarity: 'legendary',     weight: 3,  img: 'img/prizes/6.jpg' },
    { id: 7, name: 'ПаПа СтуЧАт', rarity: 'legendary', weight: 1, img: 'img/prizes/7.jpg' }
  ];

  var STORAGE_KEY = 'avakyanDrop.lastSpin';
  var STRIP_LEN = 56;      // длина ленты
  var WIN_INDEX = 46;      // позиция выигрышной ячейки
  var SPIN_MS = 6500;      // длительность анимации прокрутки

  // Кулдаун между крутками: 6 часов в миллисекундах (6 * 60 * 60 * 1000)
  var COOLDOWN_MS = 3000; 

  var root = document.getElementById('avakyanDrop');
  if (!root) return;
  var win = document.getElementById('dropWindow');
  var track = document.getElementById('dropTrack');
  var result = document.getElementById('dropResult');
  var btn = document.getElementById('dropBtn');
  var note = document.getElementById('dropNote');

  var spinning = false;
  var timer = null;

  function load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) { return null; }
  }
  function save(prize) {
    try { 
      // Сохраняем точную метку времени (timestamp) вместо даты YYYY-MM-DD
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ timestamp: Date.now(), id: prize.id })); 
    } catch (e) {}
  }
  function byId(id) {
    return PRIZES.filter(function (p) { return p.id === id; })[0];
  }

  function pickWeighted() {
    var total = PRIZES.reduce(function (s, p) { return s + p.weight; }, 0);
    var r = Math.random() * total;
    for (var i = 0; i < PRIZES.length; i++) {
      r -= PRIZES[i].weight;
      if (r < 0) return PRIZES[i];
    }
    return PRIZES[0];
  }
  function randomPrize() { return PRIZES[Math.floor(Math.random() * PRIZES.length)]; }

  // Старый метод проверки по дате удален. Теперь сравниваем разницу во времени.
  function isLocked() {
    var last = load();
    if (!last || !last.timestamp) return false;
    return (Date.now() - last.timestamp) < COOLDOWN_MS;
  }

  function iconHTML(p) {
    return p.img
      ? '<div class="ph has-img"><img src="' + p.img + '" alt=""></div>'
      : '<div class="ph">?</div>';
  }

  function itemHTML(p) {
    return '<div class="drop-item r-' + p.rarity + '">' + iconHTML(p) + '<span>' + p.name + '</span></div>';
  }

  function build(winner) {
    var html = '';
    for (var i = 0; i < STRIP_LEN; i++) {
      html += itemHTML(i === WIN_INDEX ? winner : randomPrize());
    }
    track.innerHTML = html;
  }

  function showResult(prize) {
    result.className = 'drop-result r-' + prize.rarity + ' show';
    result.innerHTML =
      iconHTML(prize) +
      '<div class="txt"><small>Вам выпало:</small><strong>' + prize.name + '</strong></div>';
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  
  // Обновленный таймер: считает время относительно последней крутки
  function updateCountdown() {
    var last = load();
    if (!last || !last.timestamp) { lockUI(false); return; }

    var nextSpinTime = last.timestamp + COOLDOWN_MS;
    var left = Math.max(0, nextSpinTime - Date.now());

    if (left === 0 || !isLocked()) { lockUI(false); return; }

    var h = Math.floor(left / 3600000), 
        m = Math.floor((left % 3600000) / 60000), 
        s = Math.floor((left % 60000) / 1000);

    note.textContent = 'Следующая крутка через ' + pad(h) + ':' + pad(m) + ':' + pad(s);
  }

  function lockUI(locked) {
    btn.disabled = locked || spinning;
    clearInterval(timer);
    if (locked) {
      updateCountdownText();
      timer = setInterval(updateCountdown, 1000);
    } else {
      note.textContent = '';
    }
  }
  function updateCountdownText() { updateCountdown(); }

  function centerOffset(index, jitter) {
    var el = track.children[index];
    return el.offsetLeft + el.offsetWidth / 2 + (jitter || 0) - win.clientWidth / 2;
  }

  function spin() {
    if (spinning || isLocked()) return;
    spinning = true;
    btn.disabled = true;
    note.textContent = 'Крутим…';
    result.className = 'drop-result';

    var prize = pickWeighted();
    save(prize); 

    track.style.transition = 'none';
    track.style.transform = 'translateX(0)';
    build(prize);
    void track.offsetWidth;

    var w = track.children[WIN_INDEX].offsetWidth;
    var target = centerOffset(WIN_INDEX, (Math.random() - 0.5) * w * 0.7);
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    var dur = reduce ? 800 : SPIN_MS;

    track.style.transition = 'transform ' + dur + 'ms cubic-bezier(0.12, 0.62, 0.1, 1)';
    track.style.transform = 'translateX(' + (-target) + 'px)';

    var done = false;
    function finish() {
      if (done) return;
      done = true;
      track.removeEventListener('transitionend', finish);
      spinning = false;
      showResult(prize);
      lockUI(true);
    }
    track.addEventListener('transitionend', finish);
    setTimeout(finish, dur + 300);
  }

  // ===== старт =====
  var last = load();
  // Проверяем блокировку по новому методу isLocked()
  if (last && isLocked() && byId(last.id)) {
    var p = byId(last.id);
    build(p);
    track.style.transform = 'translateX(' + (-centerOffset(WIN_INDEX, 0)) + 'px)';
    showResult(p);
    lockUI(true);
  } else {
    build(randomPrize());
    lockUI(false);
  }

  btn.addEventListener('click', spin);
})();
