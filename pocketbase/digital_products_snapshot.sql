select id::text as legacy_id,
       to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS"Z"') as created_at,
       name, description,
       (price * 100)::bigint as price_cents, image_url, purchase_url, active,
       file_path as source_file, file_name as download_name
from public.own_products
order by id;
