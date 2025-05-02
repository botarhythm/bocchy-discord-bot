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

-- ユーザープロファイル（個人属性・好み・傾向）
create table if not exists user_profiles (
  id serial primary key,
  user_id text not null,
  guild_id text not null,
  display_name text,
  preferences jsonb, -- 例: {"tone": "polite", "topics": ["音楽", "アニメ"]}
  last_active timestamp,
  created_at timestamp default now(),
  updated_at timestamp default now(),
  unique(user_id, guild_id)
);

-- 個別やりとり履歴＋埋め込み（長期記憶・パーソナライズ用）
create table if not exists user_interactions (
  id serial primary key,
  user_id text not null,
  guild_id text not null,
  message text not null,
  bot_reply text,
  embedding vector(1536), -- OpenAI埋め込み用
  sentiment text, -- positive/neutral/negative
  created_at timestamp default now()
);

-- ベクトル検索用 index
create index if not exists idx_user_interactions_embedding on user_interactions using ivfflat (embedding vector_cosine_ops); 