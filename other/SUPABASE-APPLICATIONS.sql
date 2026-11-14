-- =====================================================================
--  ЗАЯВКИ НА ВСТУПЛЕНИЕ: аккаунт создаётся прямо из анкеты (статус «ожидает»),
--  админ только одобряет. Заметки аккаунтов редактируются в админке.
--
--  Выполнить ОДИН РАЗ ПОСЛЕ SUPABASE-ACCOUNTS.sql:
--  Supabase -> SQL Editor -> New query -> вставить -> Run
--  (повторный запуск ничего не ломает)
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. Имя на сайте теперь «Фамилия Имя Отчество» — лимит 30 символов мал,
--     поднимаем до 100 (и для ника в форуме, он берётся из имени аккаунта)
-- ---------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.accounts'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%display_name%' loop
    execute format('alter table public.accounts drop constraint %I', c.conname);
  end loop;
  for c in select conname from pg_constraint
            where conrelid = 'public.comments'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%nick%' loop
    execute format('alter table public.comments drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.accounts add constraint accounts_display_name_check
  check (char_length(btrim(display_name)) between 1 and 100);
alter table public.comments add constraint comments_nick_check
  check (char_length(btrim(nick)) between 1 and 100);

-- ---------------------------------------------------------------------
--  2. Заявка с сайта: создаёт аккаунт со статусом «ожидает»
--     Имя аккаунта = Фамилия + Имя + Отчество, в заметку кладётся e-mail
--     Ошибки: BAD_LOGIN, BAD_NAME, BAD_PASSWORD, LOGIN_TAKEN, NAME_TAKEN, TOO_MANY_APPS
-- ---------------------------------------------------------------------
create or replace function public.register_application(
  p_login text, p_password text, p_last text, p_first text, p_patronymic text, p_email text default null
) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  lg text := btrim(coalesce(p_login, ''));
  ln text := btrim(coalesce(p_last, ''));
  fn text := btrim(coalesce(p_first, ''));
  pn text := btrim(coalesce(p_patronymic, ''));
  nm text;
  em text := left(btrim(coalesce(p_email, '')), 120);
  v_id bigint;
  cname text;
begin
  nm := btrim(regexp_replace(ln || ' ' || fn || ' ' || pn, '\s+', ' ', 'g'));
  if char_length(lg) < 3 or char_length(lg) > 80 then raise exception 'BAD_LOGIN'; end if;
  if ln = '' or fn = '' or pn = '' or char_length(nm) > 100 then raise exception 'BAD_NAME'; end if;
  if char_length(coalesce(p_password, '')) < 4 or octet_length(p_password) > 72 then raise exception 'BAD_PASSWORD'; end if;

  -- защита от спама: не больше 30 новых заявок в час на весь сайт
  if (select count(*) from public.accounts
       where status = 'pending' and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'TOO_MANY_APPS';
  end if;

  begin
    insert into public.accounts (login, display_name, pass_hash, status, note)
    values (lg, nm, crypt(p_password, gen_salt('bf', 10)), 'pending',
            nullif('e-mail: ' || em, 'e-mail: '))
    returning accounts.id into v_id;
  exception when unique_violation then
    get stacked diagnostics cname = constraint_name;
    if cname = 'accounts_login_uq' then raise exception 'LOGIN_TAKEN'; else raise exception 'NAME_TAKEN'; end if;
  end;
  return json_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
--  3. Админка: редактирование заметки аккаунта
-- ---------------------------------------------------------------------
create or replace function public.admin_set_note(p_token text, p_id bigint, p_note text) returns json
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._admin(p_token);
  if char_length(coalesce(p_note, '')) > 500 then raise exception 'BAD_NOTE'; end if;
  update public.accounts set note = nullif(btrim(coalesce(p_note, '')), '') where id = p_id;
  if not found then raise exception 'NO_ACCOUNT'; end if;
  return json_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
--  4. Создание аккаунтов админом убираем совсем
-- ---------------------------------------------------------------------
drop function if exists public.admin_create_account(text, text, text, text, text, boolean);

-- ---------------------------------------------------------------------
--  5. Права на вызов из браузера
-- ---------------------------------------------------------------------
revoke all on function public.register_application(text, text, text, text, text, text) from public;
revoke all on function public.admin_set_note(text, bigint, text) from public;
grant execute on function public.register_application(text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.admin_set_note(text, bigint, text) to anon, authenticated;

notify pgrst, 'reload schema';
