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
  balance       numeric(24,2) not null default 0,     -- может уходить в минус (игра «Еноты»)
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
  rarity text not null,
  weight numeric(10,2) not null check (weight > 0),   -- относительный шанс выпадения (можно дробный: 0.01)
  img    text,                               -- путь к картинке на сайте
  active boolean not null default true
);

alter table public.prizes drop constraint if exists prizes_rarity_check;
alter table public.prizes add constraint prizes_rarity_check check (rarity in ('common','rare','epic','legendary','mythic'));

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
  delta      numeric(24,2) not null,
  reason     text not null,
  created_at timestamptz not null default now()
);

-- Ракета: у каждого игрока своя игра, она запускается кнопкой «Запуск»
-- (старые таблицы rocket_rounds / rocket_bets версии с общими раундами больше не используются;
--  если они у вас есть, их можно удалить: drop table if exists public.rocket_bets, public.rocket_rounds;)
create table if not exists public.rocket_games (
  id           bigint generated always as identity primary key,
  account_id   bigint not null references public.accounts(id) on delete cascade,
  amount       numeric(24,2) not null check (amount > 0),
  auto_cashout numeric(8,2),
  crash_point  numeric(10,2) not null,       -- СЕКРЕТ: клиенту не отдаётся, пока игра не закончилась
  start_at     timestamptz not null,
  crash_at     timestamptz not null,
  status       text not null default 'active' check (status in ('active','won','lost')),
  cash_mult    numeric(10,2),
  payout       numeric(24,2) not null default 0,
  created_at   timestamptz not null default now()
);
create unique index if not exists rocket_games_one_active on public.rocket_games (account_id) where status = 'active';

-- комментарии форума: помечаем, написал ли их участник с аккаунтом
alter table public.comments add column if not exists account_id bigint references public.accounts(id) on delete set null;
alter table public.comments add column if not exists verified boolean not null default false;
-- ПРЕМИУМ: выдаёт только админ (кнопка ★ в админке)
alter table public.accounts add column if not exists is_premium boolean not null default false;
alter table public.comments add column if not exists premium boolean not null default false;   -- золотая плашка в сообщении

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
alter table public.accounts drop constraint if exists accounts_balance_check;   -- баланс может быть отрицательным

revoke all on public.accounts, public.sessions, public.login_attempts, public.prizes,
              public.inventory, public.balance_log, public.rocket_games
  from public, anon, authenticated;

-- гости по-прежнему могут писать на форуме, но только как гости
drop policy if exists "anon добавляет комментарии" on public.comments;
create policy "anon добавляет комментарии"
  on public.comments for insert to anon
  with check (approved = true and verified = false and account_id is null and premium = false);

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
$$ select interval '2 hours' $$;

-- Кулдаун бесплатной крутки у ПРЕМИУМ-аккаунта
create or replace function public._premium_drop_cooldown() returns interval language sql immutable as
$$ select interval '1 hour' $$;

-- кулдаун крутки для конкретного игрока
create or replace function public._drop_cd(p_premium boolean) returns interval language sql immutable as
$$ select case when p_premium then public._premium_drop_cooldown() else public._drop_cooldown() end $$;

-- Доля прибыли реферала, которую получает реферер (обычный / премиум)
create or replace function public._ref_rate(p_premium boolean) returns numeric language sql immutable as
$$ select case when p_premium then 0.10 else 0.07 end::numeric $$;

-- Цена дополнительной (платной) крутки в баллах
create or replace function public._paid_spin_cost() returns numeric language sql immutable as
$$ select 0.05::numeric $$;

-- Сколько баллов даёт предмет в зависимости от редкости
create or replace function public._reward(p_rarity text) returns numeric language sql immutable as
$$ select case p_rarity when 'common' then 0.01 when 'rare' then 0.03
                        when 'epic' then 0.06 when 'legendary' then 0.12 when 'mythic' then 1.00 else 0 end::numeric $$;

-- Ракета: множитель = exp(рост * секунды). 0.12 => x2 через ~5.8 c, x10 через ~19 c
-- максимальная ставка в ракете (защита от numeric overflow при огромных выплатах)
create or replace function public._max_bet() returns numeric language sql immutable as $$ select 500::numeric $$;
create or replace function public._rk_growth()     returns numeric language sql immutable as $$ select 0.12::numeric $$;
create or replace function public._rk_mult(p_secs numeric) returns numeric language sql immutable as
$$ select exp(public._rk_growth() * greatest(p_secs, 0)) $$;

alter table public.prizes alter column weight type numeric(10,2);   -- если таблица осталась от версии с целым шансом
-- призы (названия и картинки взяты из вашей рулетки; шансы можно менять)
insert into public.prizes (id, name, rarity, weight, img) values
  (1, 'Летучка',     'common',    30, 'img/prizes/1.jpg'),
  (2, 'Колоквиум',   'common',    25, 'img/prizes/2.jpg'),
  (3, 'Контрольная', 'common',    25, 'img/prizes/3.jpg'),
  (4, 'Нам бы...',   'rare',      10, 'img/prizes/4.jpg'),
  (5, '7очка',       'epic',       7, 'img/prizes/5.jpg'),
  (6, '9очка',       'legendary',  1.99, 'img/prizes/6.jpg'),
  (7, 'ПаПа СтуЧАт', 'legendary',  1, 'img/prizes/7.jpg'),
  (8, 'А. М. П.', 'mythic',     0.01, 'img/prizes/8.jpg')
on conflict (id) do nothing;
update public.prizes set rarity = 'mythic' where id = 8;      -- А. М. П. теперь мифический (+1.00 б.)

-- ---------------------------------------------------------------------
--  ВНУТРЕННИЕ ФУНКЦИИ (из браузера недоступны)
-- ---------------------------------------------------------------------
create or replace function public._ms(t timestamptz) returns bigint language sql immutable as
$$ select (extract(epoch from t) * 1000)::bigint $$;

create or replace function public._user_json(a public.accounts) returns json language sql as
$$ select json_build_object('id', a.id, 'login', a.login, 'name', a.display_name,
                            'balance', a.balance, 'is_admin', a.is_admin, 'premium', a.is_premium) $$;

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
  nxt := a.last_spin_at + public._drop_cd(a.is_premium);
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
                           'premium_cooldown_ms', (extract(epoch from public._premium_drop_cooldown()) * 1000)::bigint,
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
    nxt := a.last_spin_at + public._drop_cd(a.is_premium);              -- платная крутка кулдаун не трогает
  else
    nxt := a.last_spin_at + public._drop_cd(a.is_premium);
    if nxt > now() then
      return json_build_object('ok', false, 'error', 'COOLDOWN', 'next_spin_at', public._ms(nxt),
                               'server_now', public._ms(now()));
    end if;
    update public.accounts set last_spin_at = now() where id = a.id;
    nxt := now() + public._drop_cd(a.is_premium);
  end if;
  p := public._pick_prize();
  rew := public._reward(p.rarity);
  insert into public.inventory (account_id, prize_id) values (a.id, p.id);
  if p_paid then perform public._credit(a.id, -cost, 'drop:paid'); end if;
  perform public._credit(a.id, rew, 'drop:' || p.id);
  perform public._ref_bonus(a.id, rew - cost);                          -- 7% (премиум 10%) рефереру с прибыли
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
      perform public._ref_bonus(g.account_id, pay - g.amount);
    else
      update public.rocket_games set status = 'lost' where id = g.id;
    end if;
  else
    cur := public._rk_mult(extract(epoch from now() - g.start_at));
    if g.auto_cashout is not null and g.auto_cashout <= cur then
      pay := floor(g.amount * g.auto_cashout * 100) / 100;
      update public.rocket_games set status = 'won', cash_mult = g.auto_cashout, payout = pay where id = g.id;
      perform public._credit(g.account_id, pay, 'rocket:win:' || g.id);
      perform public._ref_bonus(g.account_id, pay - g.amount);
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
    from (select id,                                   -- результат вывода: где игрок забрал, иначе где самолёт упал
                 case when status = 'won' then cash_mult
                      when status = 'active' and auto_cashout is not null and auto_cashout < crash_point then auto_cashout   -- автовывод ещё не оформлен
                      else crash_point end as cp
            from public.rocket_games where crash_at <= now() order by id desc limit 14) h;
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
  if amt < 0.01 then raise exception 'BAD_AMOUNT'; end if;
  if amt > public._max_bet() then raise exception 'BET_TOO_BIG'; end if;
  if p_auto is not null then
    au := round(p_auto, 2);
    if au < 1.5 or au > 100 then raise exception 'BAD_AUTO'; end if;
  end if;

  select * into a from public.accounts where id = a.id for update;     -- защита от двойного запуска
  perform public._rg_settle(a.id);
  if exists (select 1 from public.rocket_games where account_id = a.id and status = 'active') then
    raise exception 'ALREADY_FLYING';
  end if;
  select * into a from public.accounts where id = a.id;                 -- баланс мог измениться после settle
  if a.balance < amt then raise exception 'NO_FUNDS'; end if;

  u  := random();
  cp := least(100, greatest(1.00, floor(95 / (1 - u)::numeric) / 100)); -- ~3% перевес «казино»
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
    perform public._ref_bonus(a.id, pay - g.amount);
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
  insert into public.comments (nick, message, approved, account_id, verified, premium)
  values (a.display_name, msg, true, a.id, true, a.is_premium);
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
            'is_admin', ac.is_admin, 'premium', ac.is_premium, 'balance', ac.balance, 'note', ac.note, 'created_at', public._ms(ac.created_at),
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

-- выдать / забрать премиум (только админ); заодно обновляем плашку в уже написанных сообщениях
create or replace function public.admin_set_premium(p_token text, p_id bigint, p_premium boolean) returns json
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._admin(p_token);
  if p_premium is null then raise exception 'BAD_STATUS'; end if;
  update public.accounts set is_premium = p_premium where id = p_id;
  if not found then raise exception 'NO_ACCOUNT'; end if;
  update public.comments set premium = p_premium where account_id = p_id;
  return json_build_object('ok', true, 'premium', p_premium);
end $$;

create or replace function public.admin_adjust_balance(p_token text, p_id bigint, p_delta numeric, p_reason text default 'admin') returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts; d numeric := round(coalesce(p_delta, 0), 2);
begin
  perform public._admin(p_token);
  if abs(d) > 1000000000000::numeric then raise exception 'BAD_AMOUNT'; end if;
  select * into a from public.accounts where id = p_id for update;
  if not found then raise exception 'NO_ACCOUNT'; end if;
  if a.balance + d < 0 then raise exception 'NO_FUNDS'; end if;
  perform public._credit(p_id, d, 'admin:' || left(coalesce(p_reason, ''), 60));
  return json_build_object('ok', true, 'balance', a.balance + d);
end $$;

-- ---------------------------------------------------------------------
--  ЕНОТЫ (удар крота): сетка 3x3, +0.01 за енота, -1 за Авакяна
-- ---------------------------------------------------------------------
-- Ход = одна раскладка. Енотов 2-4 (+0.01 за каждого), с шансом 40% вместе с ними вылезают Авакяны: -1.00 за клик.
-- Авакянов 1 на ходах 1-3, 2 на ходах 4-6 и так далее до 8. Время хода сокращается с каждым ходом.
-- Баллы копятся в игре; вывести можно после 5-го хода (в баланс идёт итог, он может быть и отрицательным).
-- Если бросить игру, плюс сгорает, а минус остаётся в силе.
create table if not exists public.whack_games (
  id          bigint generated always as identity primary key,
  account_id  bigint not null references public.accounts(id) on delete cascade,
  turn        int not null default 0,                 -- сыграно ходов
  total       numeric(24,2) not null default 0,       -- набрано в этой игре (может быть < 0)
  cells       int[] not null,                         -- раскладка текущего хода: 0 пусто, 1 енот, 2 Авакян
  round_ms    int not null,
  round_at    timestamptz not null default now(),
  status      text not null default 'active' check (status in ('active','cashed','abandoned')),
  payout      numeric(24,2),
  created_at  timestamptz not null default now()
);
alter table public.whack_games add column if not exists ended_at timestamptz;      -- когда игра закончилась (от этого считается кулдаун)
create unique index if not exists whack_games_one_active on public.whack_games (account_id) where status = 'active';

-- Кулдаун между играми «Еноты»
create or replace function public._wh_cooldown() returns interval language sql immutable as
$$ select interval '10 minutes' $$;

-- Кулдаун «Енотов» у ПРЕМИУМ-аккаунта
create or replace function public._premium_wh_cooldown() returns interval language sql immutable as
$$ select interval '5 minutes' $$;

-- когда игроку снова можно играть (null, если уже можно)
create or replace function public._wh_next_at(p_account bigint) returns timestamptz
language sql stable security definer set search_path = public, extensions as $$
  select case when t > now() then t end
  from (select max(coalesce(ended_at, round_at))
               + case when (select is_premium from public.accounts where id = p_account)
                      then public._premium_wh_cooldown() else public._wh_cooldown() end as t
          from public.whack_games where account_id = p_account and status <> 'active') x $$;
alter table public.whack_games enable row level security;
revoke all on public.whack_games from public, anon, authenticated;

create or replace function public._wh_ms(p_turn int) returns int language sql immutable as $$
  select greatest(400, round(800 * power(0.90, p_turn)))::int $$;

create or replace function public._wh_cells(p_turn int) returns int[]
language plpgsql volatile as $$
declare a int := 0; r int; c int[] := array_fill(0, array[9]); pos int[]; i int;
begin
  if random() < 0.5 then a := least(8, 1 + p_turn / 3); end if;
  r := least(2 + floor(random() * 3)::int, 9 - a);
  select array_agg(g order by random()) into pos from generate_series(0, 8) g;
  for i in 1..a loop c[pos[i] + 1] := 2; end loop;
  for i in a + 1..a + r loop c[pos[i] + 1] := 1; end loop;
  return c;
end $$;

-- брошенная игра (нет ответа дольше хода + 20 с): плюс сгорает, минус списывается
create or replace function public._wh_settle(p_account bigint) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare g public.whack_games; pay numeric;
begin
  select * into g from public.whack_games where account_id = p_account and status = 'active' for update;
  if not found then return; end if;
  if now() > g.round_at + make_interval(secs => g.round_ms / 1000.0 + 20) then
    pay := least(0, g.total);
    update public.whack_games set status = 'abandoned', payout = pay,
           ended_at = g.round_at + make_interval(secs => g.round_ms / 1000.0) where id = g.id;
    if pay <> 0 then perform public._credit(p_account, pay, 'whack:abandon:' || g.id); end if;
  end if;
end $$;

create or replace function public._wh_json(g public.whack_games) returns json
language sql security definer set search_path = public, extensions as $$
  select json_build_object('id', g.id, 'turn', g.turn, 'total', g.total, 'can_cash', g.turn >= 5,
                           'cells', to_json(g.cells), 'ms', g.round_ms, 'round_at', public._ms(g.round_at)) $$;

create or replace function public.whack_state(p_token text default null) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts; g public.whack_games; gj json;
begin
  begin a := public._acc(p_token); exception when others then a := null; end;
  if a.id is not null then
    perform public._wh_settle(a.id);
    select * into g from public.whack_games where account_id = a.id and status = 'active';
    if found then gj := public._wh_json(g); end if;
    select * into a from public.accounts where id = a.id;
  end if;
  return json_build_object('server_now', public._ms(now()), 'game', gj,
                           'next_at', case when a.id is not null and gj is null then public._ms(public._wh_next_at(a.id)) end,
                           'balance', case when a.id is not null then a.balance end);
end $$;

create or replace function public.whack_start(p_token text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts;
begin
  a := public._acc(p_token);
  select * into a from public.accounts where id = a.id for update;
  perform public._wh_settle(a.id);
  if not exists (select 1 from public.whack_games where account_id = a.id and status = 'active') then
    if public._wh_next_at(a.id) is not null then raise exception 'WH_COOLDOWN'; end if;      -- кулдаун ещё идёт
    insert into public.whack_games (account_id, turn, cells, round_ms) values (a.id, 0, public._wh_cells(0), public._wh_ms(0));
  end if;
  return public.whack_state(p_token);
end $$;

-- конец хода: клиент присылает номера клеток (0-8), по которым успел кликнуть
create or replace function public.whack_turn(p_token text, p_hits int[]) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts; g public.whack_games; h int[] := coalesce(p_hits, '{}'); rac int := 0; ava int := 0; i int; d numeric; res jsonb;
begin
  a := public._acc(p_token);
  select * into a from public.accounts where id = a.id for update;
  perform public._wh_settle(a.id);
  select * into g from public.whack_games where account_id = a.id and status = 'active' for update;
  if not found then raise exception 'NO_GAME'; end if;
  if now() < g.round_at + make_interval(secs => g.round_ms / 1000.0 * 0.9) then raise exception 'TOO_FAST'; end if;
  if coalesce(array_length(h, 1), 0) > 9
     or exists (select 1 from unnest(h) x where x < 0 or x > 8 or x is null)
     or (select count(distinct x) from unnest(h) x) <> coalesce(array_length(h, 1), 0) then
    raise exception 'BAD_HITS';
  end if;
  for i in 1..coalesce(array_length(h, 1), 0) loop
    if g.cells[h[i] + 1] = 1 then rac := rac + 1; elsif g.cells[h[i] + 1] = 2 then ava := ava + 1; end if;
  end loop;
  d := rac * 0.01 - ava * 1.00;
  update public.whack_games
     set total = total + d, turn = turn + 1, cells = public._wh_cells(turn + 1), round_ms = public._wh_ms(turn + 1), round_at = now()
   where id = g.id;
   if g.turn + 1 >= 12 then
    update public.whack_games set status = 'cashed', payout = g.total + d, ended_at = now() where id = g.id;
    if g.total + d <> 0 then perform public._credit(a.id, g.total + d, 'whack:cash:' || g.id); end if;
    perform public._ref_bonus(a.id, g.total + d);
    res := public.whack_state(p_token)::jsonb;
    return (res || jsonb_build_object('last', jsonb_build_object('raccoons', rac, 'avakyans', ava, 'delta', d),
                                      'cashed', g.total + d))::json;
    end if;
  res := public.whack_state(p_token)::jsonb;
  return (res || jsonb_build_object('last', jsonb_build_object('raccoons', rac, 'avakyans', ava, 'delta', d)))::json;
end $$;

-- вывести набранное в баланс (после 5-го хода); итог может быть отрицательным
create or replace function public.whack_cashout(p_token text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts; g public.whack_games; res jsonb;
begin
  a := public._acc(p_token);
  select * into a from public.accounts where id = a.id for update;
  perform public._wh_settle(a.id);
  select * into g from public.whack_games where account_id = a.id and status = 'active' for update;
  if not found then raise exception 'NO_GAME'; end if;
  if g.turn < 5 then raise exception 'TOO_EARLY'; end if;
  update public.whack_games set status = 'cashed', payout = g.total, ended_at = now() where id = g.id;
  if g.total <> 0 then perform public._credit(a.id, g.total, 'whack:cash:' || g.id); end if;
  perform public._ref_bonus(a.id, g.total);
  res := public.whack_state(p_token)::jsonb;
  return (res || jsonb_build_object('cashed', g.total))::json;
end $$;

-- ---------------------------------------------------------------------
--  РЕФЕРАЛЫ: у каждого аккаунта свой код из 5 цифр; ввести можно один код, один раз, менять нельзя.
--  Реферер получает 7% (если он премиум, то 10%) от прибыли реферала (выигрыш рулетки, чистый выигрыш ракеты, итог «Енотов»).
--  Бонус платит система, у реферала ничего не вычитается. Убытки реферала бонус не уменьшают.
-- ---------------------------------------------------------------------
alter table public.accounts add column if not exists ref_code text;

create or replace function public._ref_gen() returns text
language plpgsql volatile as $$
declare c text;
begin
  loop
    c := (10000 + floor(random() * 90000))::int::text;
    exit when not exists (select 1 from public.accounts where ref_code = c);
  end loop;
  return c;
end $$;

do $$ declare r record;
begin
  for r in select id from public.accounts where ref_code is null loop
    update public.accounts set ref_code = public._ref_gen() where id = r.id;
  end loop;
end $$;
create unique index if not exists accounts_ref_code_key on public.accounts (ref_code);

create or replace function public._ref_assign() returns trigger language plpgsql as $$
begin
  if new.ref_code is null then new.ref_code := public._ref_gen(); end if;
  return new;
end $$;
drop trigger if exists accounts_ref_code on public.accounts;
create trigger accounts_ref_code before insert on public.accounts for each row execute function public._ref_assign();

create table if not exists public.referrals (
  invitee_id  bigint primary key references public.accounts(id) on delete cascade,   -- один реферер на человека, навсегда
  referrer_id bigint not null references public.accounts(id) on delete cascade,
  earned      numeric(26,4) not null default 0,       -- сколько бонуса заработано (с долями копейки)
  paid        numeric(24,2) not null default 0,       -- сколько из этого уже зачислено рефереру
  created_at  timestamptz not null default now()
);
create index if not exists referrals_referrer on public.referrals (referrer_id);
alter table public.referrals enable row level security;
revoke all on public.referrals from public, anon, authenticated;

-- начислить рефереру 7% (премиум 10%) с прибыли (p_profit <= 0 ничего не делает)
create or replace function public._ref_bonus(p_account bigint, p_profit numeric) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare r public.referrals; due numeric; prem boolean;
begin
  if p_profit is null or p_profit <= 0 then return; end if;
  select * into r from public.referrals where invitee_id = p_account for update;
  if not found then return; end if;
  select is_premium into prem from public.accounts where id = r.referrer_id;     -- у премиум-реферера 10%
  r.earned := r.earned + p_profit * public._ref_rate(coalesce(prem, false));
  due := floor((r.earned - r.paid) * 100) / 100;          -- в баланс идут целые сотые, остаток копится
  update public.referrals set earned = r.earned, paid = paid + greatest(due, 0) where invitee_id = p_account;
  if due > 0 then perform public._credit(r.referrer_id, due, 'ref:' || p_account); end if;
end $$;

create or replace function public.ref_info(p_token text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts; ref text; lst json; tot numeric;
begin
  a := public._acc(p_token);
  select a2.login into ref from public.referrals r join public.accounts a2 on a2.id = r.referrer_id where r.invitee_id = a.id;
  select coalesce(json_agg(json_build_object('login', x.login, 'earned', round(r.earned, 2), 'since', public._ms(r.created_at), 'premium', x.is_premium)
                           order by r.earned desc, r.created_at), '[]'::json), coalesce(sum(r.earned), 0)
    into lst, tot
    from public.referrals r join public.accounts x on x.id = r.invitee_id where r.referrer_id = a.id;
  return json_build_object('code', a.ref_code, 'referrer', ref, 'rate', public._ref_rate(a.is_premium), 'total', round(tot, 2), 'list', lst);
end $$;

create or replace function public.ref_set(p_token text, p_code text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a public.accounts; t public.accounts; c text := btrim(coalesce(p_code, ''));
begin
  a := public._acc(p_token);
  select * into a from public.accounts where id = a.id for update;
  if c !~ '^[0-9]{5}$' then raise exception 'BAD_CODE'; end if;
  if exists (select 1 from public.referrals where invitee_id = a.id) then raise exception 'REF_EXISTS'; end if;
  select * into t from public.accounts where ref_code = c and status = 'approved';
  if not found then raise exception 'NO_CODE'; end if;
  if t.id = a.id then raise exception 'REF_SELF'; end if;
  if exists (select 1 from public.referrals where invitee_id = t.id and referrer_id = a.id) then raise exception 'REF_CYCLE'; end if;
  insert into public.referrals (invitee_id, referrer_id) values (a.id, t.id);
  perform public._credit(a.id, 0.67, 'ref:welcome');       -- бонус за ввод кода (код вводится один раз, поэтому и бонус один раз)
  return public.ref_info(p_token);
end $$;

-- ---------------------------------------------------------------------
--  КТО ЧТО МОЖЕТ ВЫЗЫВАТЬ ИЗ БРАУЗЕРА
-- ---------------------------------------------------------------------
revoke all on function
  public._norm(text), public._ms(timestamptz), public._user_json(public.accounts), public._acc(text), public._admin(text),
  public._credit(bigint, numeric, text), public._pick_prize(), public._rg_settle(bigint), public._rg_json(public.rocket_games),
  public._comments_guard(), public._drop_cooldown(), public._reward(text),
  public._paid_spin_cost(), public._premium_drop_cooldown(), public._drop_cd(boolean), public._ref_rate(boolean), public._premium_wh_cooldown(), public._rk_growth(), public._rk_mult(numeric),
  public._wh_cooldown(), public._wh_next_at(bigint), public._wh_ms(int), public._wh_cells(int), public._wh_settle(bigint), public._wh_json(public.whack_games),
  public._ref_gen(), public._ref_assign(), public._ref_bonus(bigint, numeric)
  from public, anon, authenticated;

revoke all on function
  public.auth_login(text, text), public.auth_me(text), public.auth_logout(text),
  public.drop_prizes(), public.drop_config(), public.drop_status(text), public.drop_spin(text, boolean), public.drop_guest_spin(), public.my_inventory(text),
  public.rocket_state(text), public.rocket_launch(text, numeric, numeric), public.rocket_cashout(text),
  public.whack_state(text), public.whack_start(text), public.whack_turn(text, int[]), public.whack_cashout(text),
  public.ref_info(text), public.ref_set(text, text),
  public.forum_post(text, text),
  public.admin_list_accounts(text), public.admin_create_account(text, text, text, text, text, boolean),
  public.admin_set_status(text, bigint, text), public.admin_reset_password(text, bigint, text),
  public.admin_adjust_balance(text, bigint, numeric, text), public.admin_set_premium(text, bigint, boolean)
  from public;

grant execute on function
  public.auth_login(text, text), public.auth_me(text), public.auth_logout(text),
  public.drop_prizes(), public.drop_config(), public.drop_status(text), public.drop_spin(text, boolean), public.drop_guest_spin(), public.my_inventory(text),
  public.rocket_state(text), public.rocket_launch(text, numeric, numeric), public.rocket_cashout(text),
  public.whack_state(text), public.whack_start(text), public.whack_turn(text, int[]), public.whack_cashout(text),
  public.ref_info(text), public.ref_set(text, text),
  public.forum_post(text, text),
  public.admin_list_accounts(text), public.admin_create_account(text, text, text, text, text, boolean),
  public.admin_set_status(text, bigint, text), public.admin_reset_password(text, bigint, text),
  public.admin_adjust_balance(text, bigint, numeric, text), public.admin_set_premium(text, bigint, boolean)
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
