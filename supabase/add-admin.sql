-- Run in Supabase SQL Editor AFTER creating the admin user in
-- Authentication -> Users -> "Add user" (email + password, auto-confirm).
-- Replace the email below with the admin account's email.
insert into public.admins (user_id, note)
select id, 'KCS Vote admin' from auth.users where email = 'admin@example.com'
on conflict (user_id) do nothing;

-- check
select a.user_id, u.email from public.admins a join auth.users u on u.id = a.user_id;
