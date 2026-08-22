-- Acme — a self-contained demo dataset for cartapel.
--
-- Loaded automatically by the docker-compose demo (mounted into
-- /docker-entrypoint-initdb.d) and by `reset.sql`, which drops everything and
-- re-runs this file.
--
-- Sized so the admin has work to do. Ten customers and eight orders left every
-- interesting surface idle: nothing paginated, no filter narrowed anything, a
-- sort had nothing to reorder and a bar chart drew eight bars. The volumes
-- below are the smallest that exercise pagination, search, filters, sorting
-- and the dashboard's date windows, while still loading in a second or two on
-- every container start.
--
-- DETERMINISTIC on purpose. Every value derives from the row's own id through
-- md5, never from random(), so the demo looks the same after each nightly
-- reset — a screenshot in the docs stays true, and "it looked different
-- yesterday" is never the explanation for a bug report.

CREATE TABLE customers (
    id          serial PRIMARY KEY,
    name        text NOT NULL,
    email       text NOT NULL UNIQUE,
    country     text NOT NULL,
    plan        text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
    mrr         numeric(10, 2) NOT NULL DEFAULT 0,
    active      boolean NOT NULL DEFAULT true,
    -- Long, nullable prose: the column that shows whether a table truncates,
    -- wraps or blows its row height, and whether an empty cell reads as empty.
    notes       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
    id          serial PRIMARY KEY,
    name        text NOT NULL,
    sku         text NOT NULL UNIQUE,
    price       numeric(10, 2) NOT NULL,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
    id          serial PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES customers(id),
    status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'shipped', 'refunded', 'cancelled')),
    total       numeric(10, 2) NOT NULL DEFAULT 0,
    placed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
    id          serial PRIMARY KEY,
    order_id    integer NOT NULL REFERENCES orders(id),
    product_id  integer NOT NULL REFERENCES products(id),
    qty         integer NOT NULL DEFAULT 1,
    unit_price  numeric(10, 2) NOT NULL
);

CREATE TABLE subscriptions (
    id          serial PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES customers(id),
    product_id  integer NOT NULL REFERENCES products(id),
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'cancelled')),
    api_token   text NOT NULL,
    started_at  timestamptz NOT NULL DEFAULT now(),
    renews_at   timestamptz
);

-- A stable pseudo-random in [0,1) from any two keys. Deterministic across runs
-- and machines, unlike random(), and unlike a session seed it does not depend
-- on the order rows happen to be generated in.
CREATE OR REPLACE FUNCTION pick(salt text, n bigint) RETURNS double precision
  LANGUAGE sql IMMUTABLE AS
$$ SELECT ('x' || substr(md5(salt || n::text), 1, 8))::bit(32)::bigint / 4294967296.0 $$;


-- ── Products ────────────────────────────────────────────────────────────────
-- Priced across four orders of magnitude, because a money column that only
-- ever holds two-digit numbers never shows whether it aligns, groups
-- thousands or overflows its cell.

INSERT INTO products (name, sku, price, active, created_at) VALUES
    ('Starter Seat',        'SEAT-STD',   49.00,   true,  now() - interval '700 days'),
    ('Pro Seat',            'SEAT-PRO',   99.00,   true,  now() - interval '700 days'),
    ('Enterprise Seat',     'SEAT-ENT',   499.00,  true,  now() - interval '700 days'),
    ('Extra Storage 100GB', 'ADD-STOR',   9.00,    true,  now() - interval '640 days'),
    ('Extra Storage 1TB',   'ADD-STOR-XL',79.00,   true,  now() - interval '300 days'),
    ('Priority Support',    'ADD-SUPP',   29.00,   true,  now() - interval '620 days'),
    ('Dedicated CSM',       'ADD-CSM',    1200.00, true,  now() - interval '180 days'),
    ('Audit Log Export',    'ADD-AUDIT',  39.00,   true,  now() - interval '400 days'),
    ('SSO / SAML',          'ADD-SSO',    149.00,  true,  now() - interval '520 days'),
    ('Sandbox Environment', 'ADD-SANDBOX',19.00,   true,  now() - interval '260 days'),
    ('Data Residency (EU)', 'ADD-EU',     249.00,  true,  now() - interval '210 days'),
    ('On-Prem Agent',       'ADD-AGENT',  349.00,  true,  now() - interval '150 days'),
    ('Training Workshop',   'SVC-TRAIN',  2500.00, true,  now() - interval '330 days'),
    ('Migration Service',   'SVC-MIGR',   4900.00, true,  now() - interval '290 days'),
    ('Custom Integration',  'SVC-INTEG',  7500.00, true,  now() - interval '120 days'),
    -- Free, so the money formatter meets a zero.
    ('Community Plan',      'SEAT-FREE',  0.00,    true,  now() - interval '700 days'),
    -- Retired lines: the "active" filter needs something to hide.
    ('Legacy Add-on',       'ADD-LEG',    5.00,    false, now() - interval '700 days'),
    ('Beta Connector',      'ADD-BETA',   0.00,    false, now() - interval '450 days'),
    ('Phone Support (old)', 'ADD-PHONE',  59.00,   false, now() - interval '660 days'),
    ('Starter Seat (2023)', 'SEAT-STD-23',39.00,   false, now() - interval '700 days');


-- ── Customers ───────────────────────────────────────────────────────────────
-- The originals stay: the docs and screenshots name them, and a demo with a
-- recognisable first page reads better than a wall of generated companies.

INSERT INTO customers (name, email, country, plan, mrr, active, notes, created_at) VALUES
    ('Ada Lovelace',      'ada@analytical.io',     'GB', 'enterprise', 499.00, true,  'Renewal call booked. Wants the audit log export before signing the three-year term, and asked us to put the data residency clause in writing.', now() - interval '340 days'),
    ('Grace Hopper',      'grace@navy.mil',        'US', 'pro',         49.00, true,  null, now() - interval '210 days'),
    ('Alan Turing',       'alan@bletchley.uk',     'GB', 'pro',         49.00, true,  null, now() - interval '190 days'),
    ('Katherine Johnson', 'katherine@nasa.gov',    'US', 'enterprise', 499.00, true,  'Procurement runs on a 60-day cycle; do not chase before March.', now() - interval '150 days'),
    ('Linus Torvalds',    'linus@kernel.org',      'FI', 'pro',         49.00, true,  null, now() - interval '120 days'),
    ('Margaret Hamilton', 'margaret@mit.edu',      'US', 'free',         0.00, true,  null, now() - interval '90 days'),
    ('Dennis Ritchie',    'dennis@bell-labs.com',  'US', 'pro',         49.00, false, 'Churned — moved to an in-house tool. Worth a call in six months.', now() - interval '80 days'),
    ('Barbara Liskov',    'barbara@mit.edu',       'US', 'enterprise', 499.00, true,  null, now() - interval '45 days'),
    ('Donald Knuth',      'don@stanford.edu',      'US', 'free',         0.00, true,  null, now() - interval '20 days'),
    ('Radia Perlman',     'radia@spanningtree.net','US', 'pro',         49.00, true,  null, now() - interval '6 days'),
    -- Rows that exist to be awkward. An admin that renders these is an admin
    -- that renders a real customer table; each one has broken something in
    -- some tool at some point.
    ('O''Brien & Sons Ltd', 'billing@obrien-sons.ie', 'IE', 'pro',      49.00, true,  'Apostrophe in the legal name — quoting, search and CSV export all have to survive it.', now() - interval '260 days'),
    ('株式会社ヤマダ',        'keiri@yamada.co.jp',    'JP', 'enterprise', 499.00, true, 'Invoices must be issued in JPY; finance handles the conversion manually.', now() - interval '230 days'),
    ('مؤسسة الأفق',          'hisab@ufuq.sa',         'SA', 'pro',       49.00, true,  'Right-to-left name — check it does not reverse the rest of the row.', now() - interval '175 days'),
    ('Nordström Ölbryggeri', 'faktura@nordstrom.se',  'SE', 'pro',       49.00, true,  null, now() - interval '160 days'),
    ('🚀 Rocket Labs',       'ops@rocketlabs.dev',    'NZ', 'enterprise',499.00, true,  'Emoji in the display name, by their own request.', now() - interval '140 days'),
    ('Acme GmbH',            'ap@acme.de',            'DE', 'pro',       49.00, true,  'Not the same company as the other Acme GmbH — different VAT id, same name.', now() - interval '310 days'),
    ('Acme GmbH',            'buchhaltung@acme-holding.de','DE','enterprise',499.00,true,'The other one. Support tickets get mixed up weekly.', now() - interval '95 days'),
    ('Institut für angewandte Datenverarbeitung und Systemanalyse Süddeutschland', 'verwaltung@iadss.example', 'DE', 'enterprise', 499.00, true, 'The longest name on the books — a cell that does not truncate pushes every other column off screen.', now() - interval '205 days'),
    ('Zero Corp',            'noreply@zerocorp.test', 'US', 'free',       0.00, false, 'Signed up, never activated. Zero of everything.', now() - interval '55 days'),
    ('Ünïcödé Tëst AB',      'test@unicode.se',       'SE', 'free',       0.00, true,  null, now() - interval '35 days');

-- …and 1,180 generated ones, so a page is a page and search has a haystack.
-- Signup dates lean recent: a flat spread over two years describes no business
-- anyone recognises, and makes every growth chart a straight line.
INSERT INTO customers (name, email, country, plan, mrr, active, notes, created_at)
SELECT
    company,
    lower(regexp_replace(company, '[^a-zA-Z0-9]', '', 'g')) || i || '@example.com',
    (ARRAY['US','US','US','US','GB','GB','DE','DE','FR','ES','IT','NL','SE','PL','BR','IN','JP','CA','AU','MX'])
        [1 + floor(pick('country', i) * 20)::int],
    plan,
    CASE plan WHEN 'enterprise' THEN 499.00 WHEN 'pro' THEN 49.00 ELSE 0.00 END,
    -- Churn rises with age: the oldest cohorts have had the most chances to leave.
    pick('active', i) > 0.05 + 0.20 * (age_days / 730.0),
    CASE WHEN pick('notes', i) < 0.12
         THEN (ARRAY[
             'Migrated from a competitor; watch the first renewal.',
             'Pays by bank transfer, always two weeks late.',
             'Security review pending — they asked for the SOC 2 report.',
             'Expansion opportunity: three teams evaluating internally.',
             'Support-heavy account. Two tickets a week, all configuration.'
         ])[1 + floor(pick('note_which', i) * 5)::int]
    END,
    now() - make_interval(days => age_days::int, hours => floor(pick('hour', i) * 24)::int)
FROM (
    SELECT
        i,
        -- Squaring biases the draw towards 0, i.e. towards recent signups.
        (730 * power(pick('age', i), 2))::numeric AS age_days,
        CASE WHEN pick('plan', i) < 0.62 THEN 'free'
             WHEN pick('plan', i) < 0.94 THEN 'pro'
             ELSE 'enterprise' END AS plan,
        (ARRAY['Northwind','Globex','Initech','Umbrella','Soylent','Vandelay','Cyberdyne','Tyrell','Wonka',
               'Stark','Wayne','Oscorp','Gringotts','Duff','Pied Piper','Hooli','Prestige','Bluth',
               'Sterling Cooper','Dunder Mifflin','Vehement','Massive Dynamic','Bluebird','Hanso',
               'Aperture','Black Mesa','Weyland','Abstergo','Rekall','Omni'])
            [1 + floor(pick('brand', i) * 30)::int]
        || ' ' ||
        (ARRAY['Analytics','Logistics','Robotics','Health','Capital','Studios','Foods','Energy','Labs',
               'Systems','Partners','Digital','Ventures','Works','Group','Industries','Media','Retail'])
            [1 + floor(pick('sector', i) * 18)::int]
        || ' ' ||
        (ARRAY['Inc','Ltd','GmbH','SA','BV','AB','Oy','SL','Pty','LLC'])
            [1 + floor(pick('suffix', i) * 10)::int]
        AS company
    FROM generate_series(1, 1180) AS i
) g;


-- ── Orders ──────────────────────────────────────────────────────────────────
-- Nobody orders before they sign up, so each order hangs off its customer's
-- own start date. Getting this wrong is the classic seeded-data tell: a
-- customer created last week with a year of purchase history behind them.

INSERT INTO orders (customer_id, status, placed_at)
SELECT
    c.id,
    CASE WHEN pick('status', n * 100000 + c.id) < 0.50 THEN 'paid'
         WHEN pick('status', n * 100000 + c.id) < 0.82 THEN 'shipped'
         WHEN pick('status', n * 100000 + c.id) < 0.89 THEN 'pending'
         WHEN pick('status', n * 100000 + c.id) < 0.96 THEN 'refunded'
         ELSE 'cancelled' END,
    -- Clamped: the hour-and-minute offset is added AFTER the day is drawn, so
    -- a date landing on the final day walked past now() and put orders in the
    -- future — 27 of them, which no order table should ever contain.
    least(now(), c.created_at + make_interval(
        days  => floor(pick('when', n * 100000 + c.id) * greatest(extract(epoch FROM now() - c.created_at) / 86400, 1))::int,
        hours => 8 + floor(pick('hour', n * 100000 + c.id) * 11)::int,
        mins  => floor(pick('min', n * 100000 + c.id) * 60)::int))
FROM customers c
CROSS JOIN generate_series(1, 12) AS n
-- Order count per customer is heavily skewed: most buy once or twice, a few
-- buy constantly. A uniform 6-orders-each makes every per-customer view
-- identical and every "top accounts" panel meaningless.
WHERE n <= CASE WHEN c.plan = 'enterprise' THEN 3 + floor(pick('freq', c.id) * 9)
                WHEN c.plan = 'pro'        THEN 1 + floor(pick('freq', c.id) * 5)
                ELSE floor(pick('freq', c.id) * 2) END
  AND c.name <> 'Zero Corp';


-- ── Order items ─────────────────────────────────────────────────────────────
-- One to three lines per order, priced from the product. Enterprise customers
-- reach the expensive catalogue; free ones do not.

INSERT INTO order_items (order_id, product_id, qty, unit_price)
SELECT
    o.id,
    p.id,
    1 + floor(pick('qty', o.id * 10 + line) * 3)::int,
    p.price
FROM orders o
JOIN customers c ON c.id = o.customer_id
CROSS JOIN generate_series(1, 3) AS line
JOIN LATERAL (
    SELECT id, price FROM products
    WHERE active
      AND CASE WHEN c.plan = 'enterprise' THEN true
               WHEN c.plan = 'pro'        THEN price <= 500
               ELSE price <= 100 END
    ORDER BY md5(id::text || o.id::text || line::text)
    LIMIT 1
) p ON true
WHERE line <= 1 + floor(pick('lines', o.id) * 3);

-- The order total is the sum of its lines, computed rather than invented. A
-- demo where the header disagrees with the rows below it teaches the reader to
-- distrust the tool, which is the opposite of the job.
UPDATE orders o
SET total = COALESCE((SELECT sum(qty * unit_price) FROM order_items WHERE order_id = o.id), 0);


-- ── Subscriptions ───────────────────────────────────────────────────────────
-- One per paying customer. `api_token` is the column the demo masks, so it has
-- to look like a real secret in every row, not like a placeholder.

INSERT INTO subscriptions (customer_id, product_id, status, api_token, started_at, renews_at)
SELECT
    c.id,
    CASE c.plan WHEN 'enterprise' THEN 3 ELSE 2 END,
    st.status,
    'sk_live_' || substr(md5('token' || c.id::text), 1, 24),
    c.created_at,
    -- A cancelled subscription has no next renewal, which is what puts NULLs
    -- in a date column that is otherwise always filled.
    CASE WHEN st.status = 'cancelled' THEN NULL
         ELSE now() + make_interval(days => 1 + floor(pick('renew', c.id) * 30)::int) END
FROM customers c
CROSS JOIN LATERAL (
    SELECT CASE WHEN NOT c.active            THEN 'cancelled'
                WHEN pick('sub', c.id) < 0.08 THEN 'past_due'
                ELSE 'active' END AS status
) st
WHERE c.plan <> 'free';


DROP FUNCTION IF EXISTS pick(text, bigint);
