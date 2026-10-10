-- Выполнить один раз: Supabase -> SQL Editor -> New query -> вставить -> Run

create table public.comments (
  id         bigint generated always as identity primary key,
  nick       text not null check (char_length(btrim(nick))    between 1 and 30),
  message    text not null check (char_length(btrim(message)) between 1 and 500),
  approved   boolean not null default true,   -- false = комментарий скрыт
  created_at timestamptz not null default now()
);

-- Защита: посетители (anon) могут только читать одобренные и добавлять новые.
-- Изменять и удалять комментарии они не могут, это делаете вы в панели Supabase.
alter table public.comments enable row level security;

create policy "anon читает одобренные"
  on public.comments for select to anon
  using (approved = true);

create policy "anon добавляет комментарии"
  on public.comments for insert to anon
  with check (approved = true);

-- ВАРИАНТ «сначала проверка»: если хотите, чтобы комментарии появлялись только после
-- вашего одобрения, замените в таблице default на false, а политику вставки на approved = false:
--   alter table public.comments alter column approved set default false;
--   drop policy "anon добавляет комментарии" on public.comments;
--   create policy "anon добавляет комментарии" on public.comments
--     for insert to anon with check (approved = false);
-- Тогда каждый новый комментарий нужно будет включать, поставив approved = true.
