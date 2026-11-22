select jsonb_build_object(
    'categories', (
        select coalesce(jsonb_agg(to_jsonb(source_row) order by source_row.legacy_id::bigint), '[]'::jsonb)
        from (
            select id::text as legacy_id, name, sort_order, active, created_at
            from public.categories
        ) as source_row
    ),
    'partners', (
        select coalesce(jsonb_agg(to_jsonb(source_row) order by source_row.legacy_id::bigint), '[]'::jsonb)
        from (
            select id::text as legacy_id, name, sort_order, active, created_at
            from public.partners
        ) as source_row
    ),
    'products', (
        select coalesce(jsonb_agg(to_jsonb(source_row) order by source_row.legacy_id::bigint), '[]'::jsonb)
        from (
            select id::text as legacy_id, name, description, link, category, image_url,
                   active, created_at, partner, featured, is_disney, normal_link, keywords
            from public.products
        ) as source_row
    )
) as catalog;
