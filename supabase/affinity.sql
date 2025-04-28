create table user_affinity (
  user_id uuid not null,
  guild_id text not null,
  affinity numeric default 0,
  updated_at timestamptz default now(),
  primary key (user_id, guild_id)
);

create or replace function adjust_affinity(
  p_user_id uuid,
  p_guild_id text,
  p_delta numeric
) returns void language plpgsql as $$
begin
  insert into user_affinity (user_id, guild_id, affinity)
  values (p_user_id, p_guild_id, p_delta)
  on conflict (user_id, guild_id)
  do update
    set affinity = greatest(least(user_affinity.affinity + p_delta, 1), -1),
        updated_at = now();
end;
$$; 