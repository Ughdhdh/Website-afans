-- =====================================================================
--  АККАУНТЫ, AvakyanDrop (рулетка + ракета), форум для участников
--  Выполнить ОДИН РАЗ: Supabase -> SQL Editor -> New query -> вставить -> Run
--  (скрипт можно запускать повторно — он ничего не ломает и не стирает данные)
--
--  Сначала должен быть выполнен старый SUPABASE-SETUP.sql (таблица comments).
--
--  Как это защищено: к новым таблицам у посетителей НЕТ прямого доступа.
--  Всё (вход, крутка, ставки, баланс) делают функции ниже. Шансы, кулдаун,
--  баланс и результат ракеты считаются на сервере, подделать их из браузера нельзя.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- Нормализация логинов/ников: регистр не важен (в т.ч. для кириллицы, независимо от локали базы)
create or replace function public._norm(t text) returns text language sql immutable as
$$ select lower(translate(btrim(coalesce(t, '')),
                          'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ',
                          'абвгдеёжзийклмнопрстуфхцчшщъыьэюя')) $$;

-- ---------------------------------------------------------------------
--  ТАБЛИЦЫ
-- ---------------------------------------------------------------------
create table if not exists public.accounts (
  id            bigint generated always as identity primary key,
  login         text not null check (char_length(btrim(login)) between 3 and 80),
  display_name  text not null check (char_length(btrim(display_name)) between 1 and 30),
  pass_hash     text not null,
  status        text not null default 'pending' check (status in ('pending','approved','blocked')),
  is_admin      boolean not null default false,
  balance       numeric(14,2) not null default 0 check (balance >= 0),
  note          text,
  last_spin_at  timestamptz,
  created_at    timestamptz not null default now()
);
drop index if exists public.accounts_login_uq;
drop index if exists public.accounts_display_uq;
create unique index accounts_login_uq   on public.accounts (public._norm(login));
create unique index accounts_display_uq on public.accounts (public._norm(display_name));

create table if not exists public.sessions (
  token_hash text primary key,
  account_id bigint not null references public.accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);

create table if not exists public.login_attempts (
  id       bigint generated always as identity primary key,
  login_lc text not null,
  at       timestamptz not null default now()
);
create index if not exists login_attempts_idx on public.login_attempts (login_lc, at);

create table if not exists public.prizes (
  id     int primary key,
  name   text not null,
  rarity text not null check (rarity in ('common','rare','epic','legendary')),
  weight int  not null check (weight > 0),   -- относительный шанс выпадения
  img    text,                               -- путь к картинке на сайте
  active boolean not null default true
);

create table if not exists public.inventory (
  id         bigint generated always as identity primary key,
  account_id bigint not null references public.accounts(id) on delete cascade,
  prize_id   int    not null references public.prizes(id),
  got_at     timestamptz not null default now()
);
create index if not exists inventory_acc_idx on public.inventory (account_id);

create table if not exists public.balance_log (
  id         bigint generated always as identity primary key,
  account_id bigint not null references public.accounts(id) on delete cascade,
  delta      numeric(14,2) not null,
  reason     text not null,
  created_at timestamptz not null default now()
);

-- Ракета: у каждого игрока своя игра, она запускается кнопкой «Запуск»
-- (старые таблицы rocket_rounds / rocket_bets версии с общими раундами больше не используются;
--  если они у вас есть, их можно удалить: drop table if exists public.rocket_bets, public.rocket_rounds;)
create table if not exists public.rocket_games (
  id           bigint generated always as identity primary key,
  account_id   bigint not null references public.accounts(id) on delete cascade,
  amount       numeric(14,2) not null check (amount > 0),
  auto_cashout numeric(8,2),
  crash_point  numeric(10,2) not null,       -- СЕКРЕТ: клиенту не отдаётся, пока игра не закончилась
  start_at     timestamptz not null,
  crash_at     timestamptz not null,
  status       text not null default 'active' check (status in ('active','won','lost')),
  cash_mult    numeric(10,2),
  payout       numeric(14,2) not null default 0,
  created_at   timestamptz not null default now()
);
create unique index if not exists rocket_games_one_active on public.rocket_games (account_id) where status = 'active';

-- комментарии форума: помечаем, написал ли их участник с аккаунтом
alter table public.comments add column if not exists account_id bigint references public.accounts(id) on delete set null;
alter table public.comments add column if not exists verified boolean not null default false;

-- ---------------------------------------------------------------------
--  ПРАВА: прямого доступа к новым таблицам нет ни у кого, кроме функций
-- ---------------------------------------------------------------------
alter table public.accounts       enable row level security;
alter table public.sessions       enable row level security;
alter table public.login_attempts enable row level security;
alter table public.prizes         enable row level security;
alter table public.inventory      enable row level security;
alter table public.balance_log    enable row level security;
alter table public.rocket_games   enable row level security;

revoke all on public.accounts, public.sessions, public.login_attempts, public.prizes,
              public.inventory, public.balance_log, public.rocket_games
  from public, anon, authenticated;

-- гости по-прежнему могут писать на форуме, но только как гости
drop policy if exists "anon добавляет комментарии" on public.comments;
create policy "anon добавляет комментарии"
  on public.comments for insert to anon
  with check (approved = true and verified = false and account_id is null);

-- гость не может назваться ником зарегистрированного участника
create or replace function public._comments_guard() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.verified is not true then
    if exists (select 1 from public.accounts
                where public._norm(display_name) = public._norm(new.nick)
                   or public._norm(login)        = public._norm(new.nick)) then
      raise exception 'NICK_RESERVED';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists comments_guard on public.comments;
create trigger comments_guard before insert on public.comments
  for each row execute function public._comments_guard();

-- ---------------------------------------------------------------------
--  НАСТРОЙКИ (меняйте здесь)
-- ---------------------------------------------------------------------
-- Кулдаун бесплатной крутки
create or replace function public._drop_cooldown() returns interval language sql immutable as
$$ select interval '4 hours' $$;

-- Цена дополнительной (платной) крутки в баллах
create or replace function public._paid_spin_cost() returns numeric language sql immutable as
$$ select 0.04::numeric $$;

-- Сколько баллов даёт предмет в зависимости от редкости
create or replace function public._reward(p_rarity text) returns numeric language sql immutable as
$$ select case p_rarity when 'common' then 0.01 when 'rare' then 0.03
                        when 'epic' then 0.05 when 'legendary' then 0.09 else 0 end::numeric $$;

-- Ракета: множитель = exp(рост * секунды). 0.12 => x2 через ~5.8 c, x10 через ~19 c
create or replace function public._rk_growth()     returns numeric language sql immutable as $$ select 0.12::numeric $$;
create or replace function public._rk_mult(p_secs numeric) returns numeric language sql immutable as
$$ select exp(public._rk_growth() * greatest(p_secs, 0)) $$;

-- призы (названия и картинки взяты из вашей рулетки; шансы можно менять)
insert into public.prizes (id, name, rarity, weight, img) values
  (1, 'Летучка',     'common',    40, 'img/prizes/1.jpg'),
  (2, 'Колоквиум',   'common',    20, 'img/prizes/2.jpg'),
  (3, 'Контрольная', 'common',    19, 'img/prizes/3.jpg'),
  (4, 'Нам бы...',   'rare',      10, 'img/prizes/4.jpg'),
  (5, '7очка',       'epic',       7, 'img/prizes/5.jpg'),
  (6, '9очка',       'legendary',  3, 'img/prizes/6.jpg'),
  (7, 'ПаПа СтуЧАт', 'legendary',  1, 'img/prizes/7.jpg')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
--  ВНУТРЕННИЕ ФУНКЦИИ (из браузера недоступны)
-- ---------------------------------------------------------------------
create or replace function public._ms(t timestamptz) returns bigint language sql immutable as
$$ select (extract(epoch from t) * 1000)::bigint $$;

create or replace function public._user_json(a public.accounts) returns json language sql as
$$ select json_build_object('id', a.id, 'login', a.login, 'name', a.display_name,
                            'balance', a.balance, 'is_admin', a.is_admin) $$;

-- участник по токену сессии; ошибки: AUTH_REQUIRED, NOT_APPROVED
create or replace function public._acc(p_token text) returns public.accounts
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts;
begin
  if p_token is null or length(p_token) < 20 then raise exception 'AUTH_REQUIRED'; end if;
  select ac.* into a
    from public.sessions s join public.accounts ac on ac.id = s.account_id
   where s.token_hash = encode(digest(p_token, 'sha256'), 'hex') and s.expires_at > now();
  if not found then raise exception 'AUTH_REQUIRED'; end if;
  if a.status <> 'approved' then raise exception 'NOT_APPROVED'; end if;
  return a;
end $$;

create or replace function public._admin(p_token text) returns public.accounts
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts;
begin
  a := public._acc(p_token);
  if not a.is_admin then raise exception 'FORBIDDEN'; end if;
  return a;
end $$;

-- изменение баланса с записью в журнал (вызывать, держа блокировку строки аккаунта)
create or replace function public._credit(p_account bigint, p_delta numeric, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.accounts set balance = balance + p_delta where id = p_account;
  insert into public.balance_log (account_id, delta, reason) values (p_account, p_delta, p_reason);
end $$;

create or replace function public._pick_prize() returns public.prizes
language plpgsql security definer set search_path = public, extensions as $$
declare total numeric; r numeric; p public.prizes;
begin
  select sum(weight) into total from public.prizes where active;
  if total is null then raise exception 'NO_PRIZES'; end if;
  r := random() * total;
  for p in select * from public.prizes where active order by id loop
    r := r - p.weight;
    if r < 0 then return p; end if;
  end loop;
  return p;
end $$;

-- ---------------------------------------------------------------------
--  ВХОД / ВЫХОД
-- ---------------------------------------------------------------------
-- Возвращает {ok:true, token, user} или {ok:false, error: BAD_CREDENTIALS|PENDING|BLOCKED|TOO_MANY}
create or replace function public.auth_login(p_login text, p_password text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts; tok text; lg text := public._norm(p_login);
begin
  if lg = '' or coalesce(p_password, '') = '' then
    return json_build_object('ok', false, 'error', 'BAD_CREDENTIALS');
  end if;
  delete from public.login_attempts where at < now() - interval '1 day';
  delete from public.sessions where expires_at < now();
  if (select count(*) from public.login_attempts
       where login_lc = lg and at > now() - interval '10 minutes') >= 8 then
    return json_build_object('ok', false, 'error', 'TOO_MANY');
  end if;

  select * into a from public.accounts where public._norm(login) = lg;
  if not found then
    perform crypt(p_password, gen_salt('bf', 10));          -- чтобы время ответа не выдавало, что логина нет
    insert into public.login_attempts (login_lc) values (lg);
    return json_build_object('ok', false, 'error', 'BAD_CREDENTIALS');
  end if;
  if a.pass_hash <> crypt(p_password, a.pass_hash) then
    insert into public.login_attempts (login_lc) values (lg);
    return json_build_object('ok', false, 'error', 'BAD_CREDENTIALS');
  end if;
  if a.status = 'pending' then return json_build_object('ok', false, 'error', 'PENDING'); end if;
  if a.status = 'blocked' then return json_build_object('ok', false, 'error', 'BLOCKED'); end if;

  delete from public.login_attempts where login_lc = lg;
  tok := encode(gen_random_bytes(32), 'hex');
  insert into public.sessions (token_hash, account_id) values (encode(digest(tok, 'sha256'), 'hex'), a.id);
  return json_build_object('ok', true, 'token', tok, 'user', public._user_json(a));
end $$;

create or replace function public.auth_me(p_token text) returns json
language plpgsql security definer set search_path = public, extensions as $$
begin
  return public._user_json(public._acc(p_token));
end $$;

create or replace function public.auth_logout(p_token text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from public.sessions where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
end $$;

-- ---------------------------------------------------------------------
--  РУЛЕТКА AvakyanDrop
-- ---------------------------------------------------------------------
create or replace function public.drop_prizes() returns json
language sql security definer set search_path = public, extensions as $$
  select coalesce(json_agg(json_build_object('id', id, 'name', name, 'rarity', rarity, 'img', img,
                                              'reward', public._reward(rarity)) order by id), '[]'::json)
    from public.prizes where active
$$;

-- состояние кулдауна (для гостя: logged=false)
create or replace function public.drop_status(p_token text default null) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts; nxt timestamptz;
begin
  begin a := public._acc(p_token); exception when others then a := null; end;
  if a.id is null then
    return json_build_object('logged', false, 'server_now', public._ms(now()));
  end if;
  nxt := a.last_spin_at + public._drop_cooldown();
  return json_build_object('logged', true, 'server_now', public._ms(now()),
    'next_spin_at', case when nxt > now() then public._ms(nxt) end,
    'last_prize', (select json_build_object('id', pr.id, 'name', pr.name, 'rarity', pr.rarity, 'img', pr.img,
                                            'reward', public._reward(pr.rarity))
                     from public.inventory i join public.prizes pr on pr.id = i.prize_id
                    where i.account_id = a.id order by i.id desc limit 1));
end $$;

-- настройки рулетки для страницы (кулдаун и цена платной крутки)
create or replace function public.drop_config() returns json
language sql security definer set search_path = public, extensions as $$
  select json_build_object('cooldown_ms', (extract(epoch from public._drop_cooldown()) * 1000)::bigint,
                           'paid_cost', public._paid_spin_cost())
$$;

-- крутка для участника: предмет в инвентарь + баллы за редкость.
-- p_paid = false: бесплатная (раз в кулдаун); p_paid = true: дополнительная за _paid_spin_cost() баллов
drop function if exists public.drop_spin(text);
create or replace function public.drop_spin(p_token text, p_paid boolean default false) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts; p public.prizes; nxt timestamptz; rew numeric; cost numeric := 0;
begin
  a := public._acc(p_token);
  select * into a from public.accounts where id = a.id for update;     -- защита от двойной крутки
  if p_paid then
    cost := public._paid_spin_cost();
    if a.balance < cost then raise exception 'NO_FUNDS'; end if;
    nxt := a.last_spin_at + public._drop_cooldown();                    -- платная крутка кулдаун не трогает
  else
    nxt := a.last_spin_at + public._drop_cooldown();
    if nxt > now() then
      return json_build_object('ok', false, 'error', 'COOLDOWN', 'next_spin_at', public._ms(nxt),
                               'server_now', public._ms(now()));
    end if;
    update public.accounts set last_spin_at = now() where id = a.id;
    nxt := now() + public._drop_cooldown();
  end if;
  p := public._pick_prize();
  rew := public._reward(p.rarity);
  insert into public.inventory (account_id, prize_id) values (a.id, p.id);
  if p_paid then perform public._credit(a.id, -cost, 'drop:paid'); end if;
  perform public._credit(a.id, rew, 'drop:' || p.id);
  return json_build_object('ok', true, 'paid', p_paid,
    'prize', json_build_object('id', p.id, 'name', p.name, 'rarity', p.rarity, 'img', p.img, 'reward', rew),
    'balance', a.balance - cost + rew,
    'next_spin_at', case when nxt > now() then public._ms(nxt) end,
    'server_now', public._ms(now()));
end $$;

-- крутка для гостя: приз выбирается, но никуда не сохраняется
create or replace function public.drop_guest_spin() returns json
language plpgsql security definer set search_path = public, extensions as $$
declare p public.prizes;
begin
  p := public._pick_prize();
  return json_build_object('ok', true,
    'prize', json_build_object('id', p.id, 'name', p.name, 'rarity', p.rarity, 'img', p.img, 'reward', public._reward(p.rarity)));
end $$;

-- инвентарь: все призы коллекции и сколько штук у участника
create or replace function public.my_inventory(p_token text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts;
begin
  a := public._acc(p_token);
  return (select json_build_object(
            'total', coalesce(sum(t.cnt), 0),
            'items', coalesce(json_agg(json_build_object('id', t.id, 'name', t.name, 'rarity', t.rarity,
                                                         'img', t.img, 'count', t.cnt) order by t.id), '[]'::json))
            from (select pr.id, pr.name, pr.rarity, pr.img, count(i.id) as cnt
                    from public.prizes pr
                    left join public.inventory i on i.prize_id = pr.id and i.account_id = a.id
                   where pr.active or i.id is not null
                   group by pr.id) t);
end $$;

-- ---------------------------------------------------------------------
--  РАКЕТА: игра запускается по кнопке (у каждого игрока своя)
-- ---------------------------------------------------------------------
-- убираем функции прежней версии (общие раунды)
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname in ('rocket_bet', 'rocket_cancel', '_rocket_settle', '_rocket_current', '_rk_bet_secs', '_rk_pause_secs')
                   or (p.proname = 'rocket_cashout' and p.pronargs = 2))
  loop
    execute 'drop function ' || r.sig::text;
  end loop;
end $$;

-- закрывает активную игру игрока: автовывод или проигрыш после падения
create or replace function public._rg_settle(p_account bigint) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare g public.rocket_games; cur numeric; pay numeric;
begin
  select * into g from public.rocket_games where account_id = p_account and status = 'active' for update;
  if not found then return; end if;
  if now() >= g.crash_at then
    if g.auto_cashout is not null and g.auto_cashout < g.crash_point then
      pay := floor(g.amount * g.auto_cashout * 100) / 100;
      update public.rocket_games set status = 'won', cash_mult = g.auto_cashout, payout = pay where id = g.id;
      perform public._credit(g.account_id, pay, 'rocket:win:' || g.id);
    else
      update public.rocket_games set status = 'lost' where id = g.id;
    end if;
  else
    cur := public._rk_mult(extract(epoch from now() - g.start_at));
    if g.auto_cashout is not null and g.auto_cashout <= cur then
      pay := floor(g.amount * g.auto_cashout * 100) / 100;
      update public.rocket_games set status = 'won', cash_mult = g.auto_cashout, payout = pay where id = g.id;
      perform public._credit(g.account_id, pay, 'rocket:win:' || g.id);
    end if;
  end if;
end $$;

create or replace function public._rg_json(g public.rocket_games) returns json language sql as
$$ select json_build_object('id', g.id, 'amount', g.amount, 'auto', g.auto_cashout, 'status', g.status,
                            'mult', g.cash_mult, 'payout', g.payout, 'start_at', public._ms(g.start_at),
                            'crash_point', case when g.status <> 'active' then g.crash_point end) $$;

-- состояние: последняя игра участника + история множителей (token необязателен)
create or replace function public.rocket_state(p_token text default null) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts; g public.rocket_games; gj json; hist json;
begin
  begin a := public._acc(p_token); exception when others then a := null; end;
  if a.id is not null then
    perform public._rg_settle(a.id);
    select * into g from public.rocket_games where account_id = a.id order by id desc limit 1;
    if found then gj := public._rg_json(g); end if;
    select * into a from public.accounts where id = a.id;              -- свежий баланс
  end if;
  select coalesce(json_agg(cp order by id desc), '[]'::json) into hist
    from (select id, crash_point as cp from public.rocket_games where crash_at <= now() order by id desc limit 14) h;
  return json_build_object('server_now', public._ms(now()), 'growth', public._rk_growth(),
                           'game', gj, 'history', hist,
                           'balance', case when a.id is not null then a.balance end);
end $$;

-- «Запуск»: ставка списывается, самолёт взлетает; точку падения выбирает сервер и не раскрывает
create or replace function public.rocket_launch(p_token text, p_amount numeric, p_auto numeric default null) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts; amt numeric; au numeric; u double precision; cp numeric;
begin
  a := public._acc(p_token);
  amt := round(coalesce(p_amount, 0), 2);
  if amt < 0.01 or amt > 1000 then raise exception 'BAD_AMOUNT'; end if;
  if p_auto is not null then
    au := round(p_auto, 2);
    if au < 1.01 or au > 1000 then raise exception 'BAD_AUTO'; end if;
  end if;

  select * into a from public.accounts where id = a.id for update;     -- защита от двойного запуска
  perform public._rg_settle(a.id);
  if exists (select 1 from public.rocket_games where account_id = a.id and status = 'active') then
    raise exception 'ALREADY_FLYING';
  end if;
  select * into a from public.accounts where id = a.id;                 -- баланс мог измениться после settle
  if a.balance < amt then raise exception 'NO_FUNDS'; end if;

  u  := random();
  cp := least(200, greatest(1.00, floor(97 / (1 - u)::numeric) / 100)); -- ~3% перевес «казино»
  insert into public.rocket_games (account_id, amount, auto_cashout, crash_point, start_at, crash_at)
  values (a.id, amt, au, cp, now(), now() + make_interval(secs => (ln(cp) / public._rk_growth())::double precision));
  perform public._credit(a.id, -amt, 'rocket:bet');
  return public.rocket_state(p_token);
end $$;

-- «Забрать»: выигрыш по текущему множителю; если самолёт уже упал, игра считается проигранной
create or replace function public.rocket_cashout(p_token text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts; g public.rocket_games; cur numeric; pay numeric;
begin
  a := public._acc(p_token);
  select * into a from public.accounts where id = a.id for update;
  perform public._rg_settle(a.id);
  select * into g from public.rocket_games where account_id = a.id and status = 'active' for update;
  if found then
    cur := greatest(1, floor(public._rk_mult(extract(epoch from now() - g.start_at)) * 100) / 100);
    pay := floor(g.amount * cur * 100) / 100;
    update public.rocket_games set status = 'won', cash_mult = cur, payout = pay where id = g.id;
    perform public._credit(a.id, pay, 'rocket:win:' || g.id);
  end if;
  return public.rocket_state(p_token);
end $$;

-- ---------------------------------------------------------------------
--  ФОРУМ: сообщение от участника (ник берётся из аккаунта, подделать нельзя)
-- ---------------------------------------------------------------------
create or replace function public.forum_post(p_token text, p_message text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts; msg text := btrim(coalesce(p_message, ''));
begin
  a := public._acc(p_token);
  if char_length(msg) < 1 or char_length(msg) > 500 then raise exception 'BAD_MESSAGE'; end if;
  if exists (select 1 from public.comments where account_id = a.id and created_at > now() - interval '10 seconds') then
    raise exception 'TOO_FAST';
  end if;
  insert into public.comments (nick, message, approved, account_id, verified)
  values (a.display_name, msg, true, a.id, true);
  return json_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
--  АДМИНКА (только для аккаунтов с is_admin = true)
-- ---------------------------------------------------------------------
create or replace function public.admin_list_accounts(p_token text) returns json
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._admin(p_token);
  return (select coalesce(json_agg(json_build_object(
            'id', ac.id, 'login', ac.login, 'name', ac.display_name, 'status', ac.status,
            'is_admin', ac.is_admin, 'balance', ac.balance, 'note', ac.note, 'created_at', public._ms(ac.created_at),
            'items', (select count(*) from public.inventory i where i.account_id = ac.id)
          ) order by (ac.status = 'pending') desc, ac.id desc), '[]'::json)
            from public.accounts ac);
end $$;

create or replace function public.admin_create_account(p_token text, p_login text, p_password text,
                                                       p_name text, p_note text default null,
                                                       p_approve boolean default false) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare lg text := btrim(coalesce(p_login, '')); nm text := btrim(coalesce(p_name, '')); id bigint; cname text;
begin
  perform public._admin(p_token);
  if char_length(lg) < 3 or char_length(lg) > 80 then raise exception 'BAD_LOGIN'; end if;
  if char_length(nm) < 1 or char_length(nm) > 30 then raise exception 'BAD_NAME'; end if;
  if char_length(coalesce(p_password, '')) < 4 or octet_length(p_password) > 72 then raise exception 'BAD_PASSWORD'; end if;
  begin
    insert into public.accounts (login, display_name, pass_hash, status, note)
    values (lg, nm, crypt(p_password, gen_salt('bf', 10)),
            case when p_approve then 'approved' else 'pending' end, nullif(btrim(coalesce(p_note, '')), ''))
    returning accounts.id into id;
  exception when unique_violation then
    get stacked diagnostics cname = constraint_name;
    if cname = 'accounts_login_uq' then raise exception 'LOGIN_TAKEN'; else raise exception 'NAME_TAKEN'; end if;
  end;
  return json_build_object('ok', true, 'id', id);
end $$;

create or replace function public.admin_set_status(p_token text, p_id bigint, p_status text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts;
begin
  a := public._admin(p_token);
  if p_status not in ('pending', 'approved', 'blocked') then raise exception 'BAD_STATUS'; end if;
  if p_id = a.id and p_status <> 'approved' then raise exception 'SELF'; end if;
  update public.accounts set status = p_status where id = p_id;
  if not found then raise exception 'NO_ACCOUNT'; end if;
  if p_status <> 'approved' then delete from public.sessions where account_id = p_id; end if;
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_reset_password(p_token text, p_id bigint, p_password text) returns json
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._admin(p_token);
  if char_length(coalesce(p_password, '')) < 4 or octet_length(p_password) > 72 then raise exception 'BAD_PASSWORD'; end if;
  update public.accounts set pass_hash = crypt(p_password, gen_salt('bf', 10)) where id = p_id;
  if not found then raise exception 'NO_ACCOUNT'; end if;
  delete from public.sessions where account_id = p_id;
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_adjust_balance(p_token text, p_id bigint, p_delta numeric, p_reason text default 'admin') returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts; d numeric := round(coalesce(p_delta, 0), 2);
begin
  perform public._admin(p_token);
  select * into a from public.accounts where id = p_id for update;
  if not found then raise exception 'NO_ACCOUNT'; end if;
  if a.balance + d < 0 then raise exception 'NO_FUNDS'; end if;
  perform public._credit(p_id, d, 'admin:' || left(coalesce(p_reason, ''), 60));
  return json_build_object('ok', true, 'balance', a.balance + d);
end $$;

-- ---------------------------------------------------------------------
--  КТО ЧТО МОЖЕТ ВЫЗЫВАТЬ ИЗ БРАУЗЕРА
-- ---------------------------------------------------------------------
revoke all on function
  public._norm(text), public._ms(timestamptz), public._user_json(public.accounts), public._acc(text), public._admin(text),
  public._credit(bigint, numeric, text), public._pick_prize(), public._rg_settle(bigint), public._rg_json(public.rocket_games),
  public._comments_guard(), public._drop_cooldown(), public._reward(text),
  public._paid_spin_cost(), public._rk_growth(), public._rk_mult(numeric)
  from public, anon, authenticated;

revoke all on function
  public.auth_login(text, text), public.auth_me(text), public.auth_logout(text),
  public.drop_prizes(), public.drop_config(), public.drop_status(text), public.drop_spin(text, boolean), public.drop_guest_spin(), public.my_inventory(text),
  public.rocket_state(text), public.rocket_launch(text, numeric, numeric), public.rocket_cashout(text),
  public.forum_post(text, text),
  public.admin_list_accounts(text), public.admin_create_account(text, text, text, text, text, boolean),
  public.admin_set_status(text, bigint, text), public.admin_reset_password(text, bigint, text),
  public.admin_adjust_balance(text, bigint, numeric, text)
  from public;

grant execute on function
  public.auth_login(text, text), public.auth_me(text), public.auth_logout(text),
  public.drop_prizes(), public.drop_config(), public.drop_status(text), public.drop_spin(text, boolean), public.drop_guest_spin(), public.my_inventory(text),
  public.rocket_state(text), public.rocket_launch(text, numeric, numeric), public.rocket_cashout(text),
  public.forum_post(text, text),
  public.admin_list_accounts(text), public.admin_create_account(text, text, text, text, text, boolean),
  public.admin_set_status(text, bigint, text), public.admin_reset_password(text, bigint, text),
  public.admin_adjust_balance(text, bigint, numeric, text)
  to anon, authenticated;

notify pgrst, 'reload schema';

-- =====================================================================
--  ПЕРВЫЙ АДМИН (выполнить отдельно, ПОДСТАВИВ свой логин и пароль):
--
--  insert into public.accounts (login, display_name, pass_hash, status, is_admin)
--  values ('admin', 'Админ', extensions.crypt('ВАШ_НАДЁЖНЫЙ_ПАРОЛЬ', extensions.gen_salt('bf', 10)), 'approved', true);
--
--  Дальше заходите на admin.html этим логином и паролем и добавляйте остальных.
-- =====================================================================
