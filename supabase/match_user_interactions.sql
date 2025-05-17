create or replace function match_user_interactions(
  p_user_id text,
  p_guild_id text,
  p_embedding vector,
  p_match_threshold float,
  p_match_count int
)
returns table (
  id int,
  message text,
  bot_reply text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    id,
    message,
    bot_reply,
    1 - (embedding <=> p_embedding) as similarity
  from user_interactions
  where user_id = p_user_id and guild_id = p_guild_id
    and embedding <=> p_embedding < (1 - p_match_threshold)
  order by embedding <=> p_embedding
  limit p_match_count;
end;
$$; 