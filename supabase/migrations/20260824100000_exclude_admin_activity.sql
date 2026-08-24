create or replace function public.record_page_view(visitor_token text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is not null and public.is_admin() then return; end if;
  if visitor_token is null or length(visitor_token) < 16 or length(visitor_token) > 100 then return; end if;
  insert into public.page_views (visitor_token) values (visitor_token);
end;
$$;

create or replace function public.record_product_click(p_product_id bigint)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is not null and public.is_admin() then return; end if;
  if exists (select 1 from public.products where id = p_product_id and active = true) then
    insert into public.product_clicks (product_id) values (p_product_id);
  end if;
end;
$$;

create or replace function public.record_search_query(p_query text, p_visitor_token text default null)
returns void language plpgsql security definer set search_path = public
as $$
declare normalized_query text;
begin
  if auth.uid() is not null and public.is_admin() then return; end if;
  normalized_query := regexp_replace(btrim(coalesce(p_query, '')), '\s+', ' ', 'g');
  if length(normalized_query) < 2 or length(normalized_query) > 120 then return; end if;
  if p_visitor_token is not null and (length(p_visitor_token) < 16 or length(p_visitor_token) > 100) then
    p_visitor_token := null;
  end if;
  insert into public.search_queries (search_term, visitor_token) values (normalized_query, p_visitor_token);
end;
$$;

grant execute on function public.record_page_view(text) to anon, authenticated;
grant execute on function public.record_product_click(bigint) to anon, authenticated;
grant execute on function public.record_search_query(text, text) to anon, authenticated;
