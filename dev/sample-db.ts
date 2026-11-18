import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

/**
 * Runs a throwaway in-memory PostgreSQL (PGlite) on 127.0.0.1:54329, seeded with a fake shop.
 * Any user/password is accepted. Data is regenerated on every start.
 */
const PORT = Number(process.env.SAMPLE_DB_PORT ?? 54329);

const SCHEMA_SQL = `
  create schema shop;
  create schema analytics;

  create table shop.customers (
    id serial primary key,
    email text not null unique,
    full_name text not null,
    country char(2) not null,
    created_at timestamptz not null default now(),
    marketing_opt_in boolean not null default false
  );

  create table shop.products (
    id serial primary key,
    sku text not null unique,
    name text not null,
    price numeric(10,2) not null check (price >= 0),
    tags text[] not null default '{}',
    attributes jsonb not null default '{}'
  );

  create table shop.orders (
    id bigserial primary key,
    customer_id int not null references shop.customers(id),
    status text not null check (status in ('pending','paid','shipped','refunded')),
    placed_at timestamptz not null,
    notes text
  );

  create table shop.order_items (
    order_id bigint not null references shop.orders(id),
    product_id int not null references shop.products(id),
    quantity int not null check (quantity > 0),
    unit_price numeric(10,2) not null,
    primary key (order_id, product_id)
  );

  create view shop.order_totals as
    select o.id as order_id, o.customer_id, o.status, sum(i.quantity * i.unit_price) as total
    from shop.orders o join shop.order_items i on i.order_id = o.id
    group by o.id;

  create table analytics.daily_revenue (
    day date primary key,
    revenue numeric(12,2) not null,
    orders int not null
  );

  create table public.app_settings (key text primary key, value text);
`;

const SEED_SQL = `
  select setseed(0.42);

  insert into shop.customers (email, full_name, country, created_at, marketing_opt_in)
  select 'customer' || g || '@example.test',
         (array['Ada','Grace','Alan','Linus','Margaret','Dennis','Barbara','Ken'])[1 + g % 8] || ' ' ||
         (array['Lovelace','Hopper','Turing','Torvalds','Hamilton','Ritchie','Liskov','Thompson'])[1 + (g * 7) % 8],
         (array['US','BR','DE','GB','PT','FR'])[1 + g % 6],
         timestamptz '2024-01-01' + (g || ' hours')::interval * 13,
         g % 3 = 0
  from generate_series(1, 250) g;

  insert into shop.products (sku, name, price, tags, attributes)
  select 'SKU-' || lpad(g::text, 4, '0'),
         (array['Mug','Notebook','Hoodie','Sticker pack','Water bottle','Cap','Tote bag','Desk mat'])[1 + g % 8] || ' v' || g,
         round((5 + random() * 95)::numeric, 2),
         array[(array['merch','office','apparel','gift'])[1 + g % 4]],
         jsonb_build_object('color', (array['black','white','green','navy'])[1 + g % 4], 'weight_g', 50 + g * 10)
  from generate_series(1, 40) g;

  insert into shop.orders (customer_id, status, placed_at, notes)
  select 1 + (random() * 249)::int,
         (array['pending','paid','paid','paid','shipped','shipped','refunded'])[1 + (random() * 6)::int],
         timestamptz '2025-01-01' + (random() * 365 || ' days')::interval,
         case when g % 17 = 0 then 'Gift wrap, please' end
  from generate_series(1, 1500) g;

  insert into shop.order_items (order_id, product_id, quantity, unit_price)
  select o.id, p.id, 1 + (random() * 3)::int, p.price
  from shop.orders o
  cross join lateral (select id, price from shop.products order by random() + o.id * 0 limit 1 + (o.id % 3)::int) p;

  insert into analytics.daily_revenue (day, revenue, orders)
  select placed_at::date, sum(t.total), count(*)
  from shop.orders o join shop.order_totals t on t.order_id = o.id
  where o.status <> 'refunded'
  group by 1;

  insert into public.app_settings values ('currency', 'USD'), ('maintenance_mode', 'off');
  analyze;
`;

/** Creates the in-memory database and loads the fake shop schema and data. */
async function createSampleDatabase(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(SCHEMA_SQL);
  await db.exec(SEED_SQL);
  return db;
}

const db = await createSampleDatabase();
const server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1', maxConnections: 10 });
await server.start();
const counts = await db.query<{ customers: number; orders: number }>(
  'select (select count(*) from shop.customers)::int as customers, (select count(*) from shop.orders)::int as orders',
);
console.log(`sample db ready on 127.0.0.1:${PORT} (database "postgres", any user/password) — ${counts.rows[0].customers} customers, ${counts.rows[0].orders} orders`);

process.on('SIGINT', async () => {
  await server.stop();
  await db.close();
  process.exit(0);
});
