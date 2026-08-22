-- Acme Supply Co. — a self-contained demo store for cartapel.
--
-- Loaded automatically by the docker-compose demo (mounted into
-- /docker-entrypoint-initdb.d) and by `reset.sql`, which drops everything and
-- re-runs this file.
--
-- A REAL shop's shape, not a toy's. The old dataset had five tables and one
-- join; a shop has a catalogue with variants, addresses, payments that can
-- fail, shipments that arrive late, refunds, coupons and reviews — and it is
-- those relationships that give an admin tool something to be good at. Every
-- table below has a foreign key into another, so opening a record shows the
-- rows that hang off it without a line of configuration.
--
-- Sized so the admin has work to do: pagination, search, filters and sorting
-- all meet more rows than fit on a screen, while the whole thing still loads
-- in a few seconds on every container start.
--
-- DETERMINISTIC on purpose. Every value derives from the row's own id through
-- md5, never from random(), so the demo looks the same after each nightly
-- reset — a screenshot in the docs stays true, and "it looked different
-- yesterday" is never the explanation for a bug report.

-- A stable pseudo-random in [0,1) from any two keys. Deterministic across runs
-- and machines, unlike random(), and unlike a session seed it does not depend
-- on the order rows happen to be generated in.
CREATE OR REPLACE FUNCTION pick(salt text, n bigint) RETURNS double precision
  LANGUAGE sql IMMUTABLE AS
$$ SELECT ('x' || substr(md5(salt || n::text), 1, 8))::bit(32)::bigint / 4294967296.0 $$;


-- ── Catalogue ───────────────────────────────────────────────────────────────

CREATE TABLE categories (
    id          serial PRIMARY KEY,
    -- Self-referencing: a tree in one table, which is where a naive admin
    -- either loops forever or renders the parent as a raw integer.
    parent_id   integer REFERENCES categories(id),
    name        text NOT NULL,
    slug        text NOT NULL UNIQUE,
    position    integer NOT NULL DEFAULT 0
);

CREATE TABLE products (
    id          serial PRIMARY KEY,
    category_id integer NOT NULL REFERENCES categories(id),
    name        text NOT NULL,
    sku         text NOT NULL UNIQUE,
    description text,
    price       numeric(10, 2) NOT NULL,
    cost        numeric(10, 2) NOT NULL,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE variants (
    id          serial PRIMARY KEY,
    product_id  integer NOT NULL REFERENCES products(id),
    sku         text NOT NULL UNIQUE,
    option_name text NOT NULL,
    option_value text NOT NULL,
    price_delta numeric(10, 2) NOT NULL DEFAULT 0,
    -- Stock goes negative when a shop oversells. It happens, and an admin that
    -- assumes non-negative renders it wrong.
    stock       integer NOT NULL DEFAULT 0
);


-- ── People ──────────────────────────────────────────────────────────────────

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

CREATE TABLE addresses (
    id          serial PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES customers(id),
    kind        text NOT NULL DEFAULT 'shipping' CHECK (kind IN ('shipping', 'billing')),
    line1       text NOT NULL,
    line2       text,
    city        text NOT NULL,
    postcode    text NOT NULL,
    country     text NOT NULL,
    is_default  boolean NOT NULL DEFAULT false
);


-- ── Money ───────────────────────────────────────────────────────────────────

CREATE TABLE coupons (
    id          serial PRIMARY KEY,
    code        text NOT NULL UNIQUE,
    kind        text NOT NULL CHECK (kind IN ('percent', 'fixed')),
    value       numeric(10, 2) NOT NULL,
    active      boolean NOT NULL DEFAULT true,
    max_uses    integer,
    used        integer NOT NULL DEFAULT 0,
    expires_at  timestamptz
);

CREATE TABLE orders (
    id          serial PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES customers(id),
    address_id  integer REFERENCES addresses(id),
    coupon_id   integer REFERENCES coupons(id),
    status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'shipped', 'refunded', 'cancelled')),
    channel     text NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'ios', 'android', 'phone', 'marketplace')),
    currency    text NOT NULL DEFAULT 'EUR',
    subtotal    numeric(10, 2) NOT NULL DEFAULT 0,
    discount    numeric(10, 2) NOT NULL DEFAULT 0,
    shipping    numeric(10, 2) NOT NULL DEFAULT 0,
    tax         numeric(10, 2) NOT NULL DEFAULT 0,
    total       numeric(10, 2) NOT NULL DEFAULT 0,
    placed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
    id          serial PRIMARY KEY,
    order_id    integer NOT NULL REFERENCES orders(id),
    product_id  integer NOT NULL REFERENCES products(id),
    variant_id  integer REFERENCES variants(id),
    qty         integer NOT NULL DEFAULT 1,
    unit_price  numeric(10, 2) NOT NULL
);

CREATE TABLE payments (
    id           serial PRIMARY KEY,
    order_id     integer NOT NULL REFERENCES orders(id),
    method       text NOT NULL CHECK (method IN ('card', 'paypal', 'transfer', 'invoice', 'gift_card')),
    status       text NOT NULL CHECK (status IN ('authorized', 'captured', 'failed', 'refunded')),
    amount       numeric(10, 2) NOT NULL,
    provider_ref text NOT NULL,
    -- Null while a payment is only authorized: a date column that is empty for
    -- a reason, rather than because nobody filled it in.
    captured_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
    id          serial PRIMARY KEY,
    order_id    integer NOT NULL REFERENCES orders(id),
    amount      numeric(10, 2) NOT NULL,
    reason      text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipments (
    id           serial PRIMARY KEY,
    order_id     integer NOT NULL REFERENCES orders(id),
    carrier      text NOT NULL CHECK (carrier IN ('DHL', 'UPS', 'Correos', 'DPD', 'Royal Mail')),
    tracking     text NOT NULL,
    status       text NOT NULL CHECK (status IN ('label_created', 'in_transit', 'delivered', 'returned', 'lost')),
    shipped_at   timestamptz,
    delivered_at timestamptz
);

CREATE TABLE reviews (
    id          serial PRIMARY KEY,
    product_id  integer NOT NULL REFERENCES products(id),
    customer_id integer NOT NULL REFERENCES customers(id),
    rating      integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title       text NOT NULL,
    body        text,
    approved    boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
    id          serial PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES customers(id),
    product_id  integer NOT NULL REFERENCES products(id),
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'cancelled')),
    -- The column the demo masks, so it has to look like a real secret in every
    -- row rather than like a placeholder.
    api_token   text NOT NULL,
    started_at  timestamptz NOT NULL DEFAULT now(),
    renews_at   timestamptz
);


-- ── Categories ──────────────────────────────────────────────────────────────

INSERT INTO categories (id, parent_id, name, slug, position) VALUES
    (1, NULL, 'Workshop',    'workshop',    1),
    (2, NULL, 'Outdoor',     'outdoor',     2),
    (3, NULL, 'Kitchen',     'kitchen',     3),
    (4, NULL, 'Electronics', 'electronics', 4),
    (5, 1, 'Hand Tools',      'hand-tools',      1),
    (6, 1, 'Power Tools',     'power-tools',     2),
    (7, 1, 'Workbenches',     'workbenches',     3),
    (8, 2, 'Camping',         'camping',         1),
    (9, 2, 'Garden',          'garden',          2),
    (10, 3, 'Cookware',       'cookware',        1),
    (11, 3, 'Coffee',         'coffee',          2),
    (12, 4, 'Lighting',       'lighting',        1),
    (13, 4, 'Cables',         'cables',          2),
    (14, 4, 'Batteries',      'batteries',       3);
SELECT setval('categories_id_seq', 14);


-- ── Products ────────────────────────────────────────────────────────────────
-- Priced across four orders of magnitude, because a money column that only
-- ever holds two-digit numbers never shows whether it aligns, groups thousands
-- or overflows its cell. `cost` is there so a margin can be computed and a
-- panel can be about something other than revenue.

INSERT INTO products (category_id, name, sku, description, price, cost, active, created_at)
SELECT
    cat,
    noun,
    upper(substr(regexp_replace(noun, '[^a-zA-Z]', '', 'g'), 1, 6)) || '-' || lpad(i::text, 4, '0'),
    CASE WHEN pick('desc', i) < 0.75
         THEN noun || '. ' || (ARRAY[
            'Forged in one piece and balanced by hand, because a tool that fights you is a tool you stop reaching for.',
            'Built for the third winter, not the first weekend.',
            'Serviceable: every part that wears is a part you can replace.',
            'Quiet, unglamorous, and still here after the fashionable one broke.'
         ])[1 + floor(pick('blurb', i) * 4)::int]
    END,
    price,
    round(price * (0.35 + pick('margin', i) * 0.30)::numeric, 2),
    pick('pactive', i) > 0.12,
    now() - make_interval(days => floor(60 + pick('pborn', i) * 640)::int)
FROM (
    SELECT
        i,
        1 + floor(pick('cat', i) * 14)::int AS cat,
        -- Squared inside the exponent so the catalogue is mostly cheap with a
        -- thin expensive tail, which is what a shop looks like. Uniform in log
        -- space put as many four-figure items on the shelf as ten-euro ones and
        -- dragged the average order value to five thousand euros.
        round((power(10, 0.6 + power(pick('price', i), 2) * 2.3))::numeric, 2) AS price,
        (ARRAY['Bench Vice','Claw Hammer','Cordless Drill','Spirit Level','Socket Set','Tape Measure',
               'Circular Saw','Chisel Set','Workbench','Tool Chest','Head Torch','Camp Stove',
               'Sleeping Bag','Dry Bag','Folding Saw','Secateurs','Watering Can','Wheelbarrow',
               'Cast Iron Pan','Stock Pot','Chef Knife','Cutting Board','Burr Grinder','Moka Pot',
               'Pour-Over Kettle','Desk Lamp','Work Light','Extension Reel','USB-C Cable','Cable Tidy',
               'AA Batteries','Power Bank','Solar Panel','Multimeter','Soldering Iron','Angle Grinder',
               'Router Table','Dust Extractor','Clamp Set','Sharpening Stone'])
            [1 + floor(pick('noun', i) * 40)::int]
        || ' ' ||
        (ARRAY['Mk I','Mk II','Mk III','Pro','Compact','Heavy Duty','Classic','Studio','Field','Shop'])
            [1 + floor(pick('line', i) * 10)::int]
        AS noun
    FROM generate_series(1, 140) AS i
) g;

-- Named rows that exist to be awkward, each of which has broken some admin
-- somewhere: a free item, a four-figure one, a retired line still referenced
-- by old orders, and a name long enough to push every column off screen.
INSERT INTO products (category_id, name, sku, description, price, cost, active, created_at) VALUES
    (5,  'Sticker Pack', 'FREE-0001', 'Free with any order. Somebody has to meet the zero.', 0.00, 0.00, true, now() - interval '400 days'),
    (7,  'Cabinetmaker''s Workbench, European Beech, 2.4m, with Tail Vice and Dog Holes', 'BENCH-2400', 'The longest name on the books.', 4750.00, 2100.00, true, now() - interval '300 days'),
    (6,  'Angle Grinder (recalled)', 'RECALL-9001', 'Withdrawn from sale after the guard recall. Kept because old orders still point at it.', 89.00, 41.00, false, now() - interval '520 days'),
    (11, 'Café Crème Brûlée Spät-Röstung ☕', 'COFFEE-UTF8', 'Accents, an umlaut and an emoji in one name.', 18.50, 7.20, true, now() - interval '180 days');


-- ── Variants ────────────────────────────────────────────────────────────────
-- One to four per product. Stock is allowed to go negative, because shops
-- oversell and the number has to survive being shown.

INSERT INTO variants (product_id, sku, option_name, option_value, price_delta, stock)
SELECT
    p.id,
    p.sku || '-' || n,
    opt.name,
    opt.value,
    CASE WHEN n = 1 THEN 0 ELSE round((pick('delta', p.id * 10 + n) * 40 - 5)::numeric, 2) END,
    -- Stocked, not stamped: what is on the shelf now is this number minus
    -- everything sold below, so the low, zero and oversold rows emerge from
    -- the orders instead of being decided here and then contradicted by them.
    30 + floor(pick('stock', p.id * 10 + n) * 260)::int
FROM products p
CROSS JOIN generate_series(1, 4) AS n
CROSS JOIN LATERAL (
    SELECT
        (ARRAY['Size','Colour','Length','Voltage'])[1 + floor(pick('optname', p.id) * 4)::int] AS name,
        (ARRAY['S','M','L','XL','Black','Olive','Steel','Red','1m','2m','5m','12V','18V','36V'])
            [1 + floor(pick('optval', p.id * 10 + n) * 14)::int] AS value
) opt
WHERE n <= 1 + floor(pick('nvariants', p.id) * 4);

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


-- ── Addresses ───────────────────────────────────────────────────────────────
-- One or two per customer, the first one default. `line2` is usually null,
-- which is what an optional field looks like in real data.

INSERT INTO addresses (customer_id, kind, line1, line2, city, postcode, country, is_default)
SELECT
    c.id,
    CASE WHEN n = 1 THEN 'shipping' ELSE 'billing' END,
    (1 + floor(pick('num', c.id * 10 + n) * 220)::int) || ' ' ||
      (ARRAY['Mill Lane','Kirchstraße','Rue des Lilas','Calle Mayor','Vasagatan','High Street',
             'Industrieweg','Via Roma','Elm Road','Harbour View'])
        [1 + floor(pick('street', c.id * 10 + n) * 10)::int],
    CASE WHEN pick('l2', c.id * 10 + n) < 0.18
         THEN (ARRAY['Unit 4','Building B','2nd floor','c/o Reception'])[1 + floor(pick('l2w', c.id * 10 + n) * 4)::int] END,
    (ARRAY['Manchester','Hamburg','Lyon','Valencia','Göteborg','Bristol','Utrecht','Bologna','Austin','Porto'])
        [1 + floor(pick('city', c.id * 10 + n) * 10)::int],
    upper(substr(md5('pc' || (c.id * 10 + n)::text), 1, 3)) || ' ' || (100 + floor(pick('pc2', c.id * 10 + n) * 900)::int),
    c.country,
    n = 1
FROM customers c
CROSS JOIN generate_series(1, 2) AS n
WHERE n = 1 OR pick('second_addr', c.id) < 0.35;


-- ── Coupons ─────────────────────────────────────────────────────────────────
-- Including the two states a coupon table exists to make visible: one expired
-- but still switched on, and one that has hit its cap.

INSERT INTO coupons (code, kind, value, active, max_uses, used, expires_at) VALUES
    ('WELCOME10',   'percent', 10.00, true,  NULL, 0, NULL),
    ('SPRING25',    'percent', 25.00, false, 1000, 0, now() - interval '120 days'),
    ('FREESHIP',    'fixed',    4.90, true,  NULL, 0, NULL),
    ('BLACKFRIDAY', 'percent', 40.00, false, 5000, 0, now() - interval '250 days'),
    ('LOYAL5',      'fixed',    5.00, true,  NULL, 0, now() + interval '200 days'),
    ('TRADE15',     'percent', 15.00, true,  500,  0, now() + interval '90 days'),
    ('SUMMER20',    'percent', 20.00, true,  NULL, 0, now() - interval '30 days'),
    ('VIP50',       'fixed',   50.00, true,  50,   0, now() + interval '400 days');


-- ── Orders ──────────────────────────────────────────────────────────────────
-- Nobody orders before they sign up, so each order hangs off its customer's
-- own start date. Getting this wrong is the classic seeded-data tell: a
-- customer created last week with a year of purchase history behind them.

INSERT INTO orders (customer_id, address_id, coupon_id, status, channel, currency, placed_at)
SELECT
    c.id,
    (SELECT a.id FROM addresses a WHERE a.customer_id = c.id ORDER BY a.is_default DESC, a.id LIMIT 1),
    CASE WHEN pick('coupon', n * 100000 + c.id) < 0.22
         THEN 1 + floor(pick('which_coupon', n * 100000 + c.id) * 8)::int END,
    CASE WHEN pick('status', n * 100000 + c.id) < 0.46 THEN 'paid'
         WHEN pick('status', n * 100000 + c.id) < 0.80 THEN 'shipped'
         WHEN pick('status', n * 100000 + c.id) < 0.88 THEN 'pending'
         WHEN pick('status', n * 100000 + c.id) < 0.95 THEN 'refunded'
         ELSE 'cancelled' END,
    (ARRAY['web','web','web','web','ios','ios','android','phone','marketplace'])
        [1 + floor(pick('channel', n * 100000 + c.id) * 9)::int],
    CASE c.country WHEN 'US' THEN 'USD' WHEN 'GB' THEN 'GBP' WHEN 'JP' THEN 'JPY' ELSE 'EUR' END,
    -- Clamped: the hour-and-minute offset is added AFTER the day is drawn, so
    -- a date landing on the final day walked past now() and put orders in the
    -- future, which no order table should ever contain.
    least(now(), c.created_at + make_interval(
        days  => floor(pick('when', n * 100000 + c.id) * greatest(extract(epoch FROM now() - c.created_at) / 86400, 1))::int,
        hours => 8 + floor(pick('hour', n * 100000 + c.id) * 11)::int,
        mins  => floor(pick('min', n * 100000 + c.id) * 60)::int))
FROM customers c
CROSS JOIN generate_series(1, 14) AS n
-- Order count per customer is heavily skewed: most buy once or twice, a few
-- buy constantly. A uniform six-each makes every per-customer view identical
-- and every "top accounts" panel meaningless.
WHERE n <= CASE WHEN c.plan = 'enterprise' THEN 4 + floor(pick('freq', c.id) * 10)
                WHEN c.plan = 'pro'        THEN 2 + floor(pick('freq', c.id) * 6)
                ELSE floor(pick('freq', c.id) * 3) END
  AND c.name <> 'Zero Corp';


-- ── Order items ─────────────────────────────────────────────────────────────

INSERT INTO order_items (order_id, product_id, variant_id, qty, unit_price)
SELECT
    o.id,
    v.product_id,
    v.id,
    1 + floor(pick('qty', o.id * 10 + line) * 3)::int,
    round(v.price + v.price_delta, 2)
FROM orders o
CROSS JOIN generate_series(1, 4) AS line
JOIN LATERAL (
    SELECT vr.id, vr.product_id, vr.price_delta, p.price
    FROM variants vr
    JOIN products p ON p.id = vr.product_id
    WHERE p.active
    ORDER BY md5(vr.id::text || o.id::text || line::text)
    LIMIT 1
) v ON true
WHERE line <= 1 + floor(pick('lines', o.id) * 4);

-- Every money column on the order is DERIVED, never invented. A demo whose
-- header disagrees with the rows below it teaches the reader to distrust the
-- tool, which is the opposite of the job.
UPDATE orders o SET
    subtotal = t.sub,
    discount = t.disc,
    shipping = t.ship,
    tax      = round((t.sub - t.disc) * 0.21, 2),
    total    = round(t.sub - t.disc + t.ship + (t.sub - t.disc) * 0.21, 2)
FROM (
    SELECT
        o2.id,
        sub,
        CASE WHEN o2.coupon_id IS NULL THEN 0
             WHEN c.kind = 'percent'   THEN round(sub * c.value / 100, 2)
             ELSE least(c.value, sub) END AS disc,
        CASE WHEN sub >= 100 THEN 0 ELSE 4.90 END AS ship
    FROM orders o2
    LEFT JOIN coupons c ON c.id = o2.coupon_id
    CROSS JOIN LATERAL (
        SELECT COALESCE(sum(oi.qty * oi.unit_price), 0) AS sub
        FROM order_items oi WHERE oi.order_id = o2.id
    ) s
) t
WHERE o.id = t.id;


-- ── Payments ────────────────────────────────────────────────────────────────
-- A shop's payments do not map one-to-one onto its orders: some fail and are
-- retried, a pending order has only an authorization, and a cancelled one may
-- have nothing at all.

INSERT INTO payments (order_id, method, status, amount, provider_ref, captured_at, created_at)
SELECT
    o.id,
    (ARRAY['card','card','card','card','paypal','paypal','transfer','invoice','gift_card'])
        [1 + floor(pick('method', o.id * 10 + attempt) * 9)::int],
    st.status,
    o.total,
    'ch_' || substr(md5('pay' || (o.id * 10 + attempt)::text), 1, 20),
    CASE WHEN st.status = 'captured'
         THEN o.placed_at + make_interval(mins => 1 + floor(pick('cap', o.id) * 300)::int) END,
    o.placed_at + make_interval(mins => attempt * 3)
FROM orders o
CROSS JOIN generate_series(1, 2) AS attempt
CROSS JOIN LATERAL (
    SELECT CASE
        WHEN attempt = 1 AND pick('fail', o.id) < 0.09 THEN 'failed'
        WHEN o.status = 'refunded' THEN 'refunded'
        WHEN o.status = 'pending'  THEN 'authorized'
        ELSE 'captured' END AS status
) st
-- The retry only exists where the first attempt failed.
WHERE o.status <> 'cancelled'
  AND (attempt = 1 OR pick('fail', o.id) < 0.09);


-- ── Refunds ─────────────────────────────────────────────────────────────────
-- Partial as well as full: a refund that always equals the order total never
-- shows whether the admin can add up a column.

INSERT INTO refunds (order_id, amount, reason, created_at)
SELECT
    o.id,
    CASE WHEN pick('partial', o.id) < 0.4
         THEN round(o.total * (0.2 + pick('part_amt', o.id) * 0.5)::numeric, 2)
         ELSE o.total END,
    (ARRAY['Damaged in transit','Wrong item shipped','Changed mind','Duplicate order',
           'Late delivery','Faulty on arrival'])[1 + floor(pick('reason', o.id) * 6)::int],
    o.placed_at + make_interval(days => 1 + floor(pick('rdays', o.id) * 20)::int)
FROM orders o
WHERE o.status = 'refunded';


-- ── Shipments ───────────────────────────────────────────────────────────────

INSERT INTO shipments (order_id, carrier, tracking, status, shipped_at, delivered_at)
SELECT
    o.id,
    (ARRAY['DHL','UPS','Correos','DPD','Royal Mail'])[1 + floor(pick('carrier', o.id) * 5)::int],
    upper(substr(md5('trk' || o.id::text), 1, 12)),
    st.status,
    sh.shipped,
    CASE WHEN st.status = 'delivered'
         THEN least(now(), sh.shipped + make_interval(days => 1 + floor(pick('transit', o.id) * 6)::int)) END
FROM orders o
CROSS JOIN LATERAL (
    SELECT least(now(), o.placed_at + make_interval(days => 1 + floor(pick('ship', o.id) * 3)::int)) AS shipped
) sh
CROSS JOIN LATERAL (
    SELECT CASE WHEN pick('shipstatus', o.id) < 0.80 THEN 'delivered'
                WHEN pick('shipstatus', o.id) < 0.93 THEN 'in_transit'
                WHEN pick('shipstatus', o.id) < 0.97 THEN 'returned'
                ELSE 'lost' END AS status
) st
WHERE o.status IN ('shipped', 'refunded');


-- ── Reviews ─────────────────────────────────────────────────────────────────
-- Ratings skew high, the way they do everywhere, with a tail of one-stars that
-- gives a "worst rated" panel something to find. Some are unapproved, so the
-- moderation filter has work.

INSERT INTO reviews (product_id, customer_id, rating, title, body, approved, created_at)
SELECT
    oi.product_id,
    o.customer_id,
    r.rating,
    (ARRAY['Does the job','Better than expected','Would buy again','Not for me',
           'Arrived damaged','Solid','Overpriced','Exactly as described'])
        [1 + floor(pick('rtitle', oi.id) * 8)::int],
    CASE WHEN pick('rbody', oi.id) < 0.6
         THEN (ARRAY[
            'Used it every day for a month before writing this. No complaints.',
            'Fine for light work, struggles with anything heavier.',
            'The finish is rougher than the photos suggest, but it works.',
            'Second one I have bought. The first is still going.'
         ])[1 + floor(pick('rbw', oi.id) * 4)::int]
    END,
    pick('approved', oi.id) > 0.07,
    least(now(), o.placed_at + make_interval(days => 3 + floor(pick('rwhen', oi.id) * 25)::int))
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
CROSS JOIN LATERAL (
    SELECT CASE WHEN pick('rating', oi.id) < 0.52 THEN 5
                WHEN pick('rating', oi.id) < 0.78 THEN 4
                WHEN pick('rating', oi.id) < 0.90 THEN 3
                WHEN pick('rating', oi.id) < 0.96 THEN 2
                ELSE 1 END AS rating
) r
WHERE o.status IN ('paid', 'shipped')
  AND pick('reviewed', oi.id) < 0.22;


-- ── Subscriptions ───────────────────────────────────────────────────────────
-- Subscribe-and-save, one per paying customer.

INSERT INTO subscriptions (customer_id, product_id, status, api_token, started_at, renews_at)
SELECT
    c.id,
    (SELECT id FROM products WHERE active ORDER BY md5(id::text || c.id::text) LIMIT 1),
    st.status,
    'sk_live_' || substr(md5('token' || c.id::text), 1, 24),
    c.created_at,
    -- A cancelled subscription has no next renewal, which is what puts NULLs
    -- in a date column that is otherwise always filled.
    CASE WHEN st.status = 'cancelled' THEN NULL
         ELSE now() + make_interval(days => 1 + floor(pick('renew', c.id) * 30)::int) END
FROM customers c
CROSS JOIN LATERAL (
    SELECT CASE WHEN NOT c.active             THEN 'cancelled'
                WHEN pick('sub', c.id) < 0.08 THEN 'past_due'
                ELSE 'active' END AS status
) st
WHERE c.plan <> 'free';


-- Stock and coupon usage reflect what actually happened above, so a low-stock
-- panel is about this dataset rather than about the number it was seeded with.
-- The floor is -5: a shop oversells, but not without noticing.
UPDATE variants v
SET stock = greatest(v.stock - sold.qty, -5)
FROM (SELECT variant_id, sum(qty) AS qty FROM order_items WHERE variant_id IS NOT NULL GROUP BY variant_id) sold
WHERE sold.variant_id = v.id;

UPDATE coupons c
SET used = u.n
FROM (SELECT coupon_id, count(*) AS n FROM orders WHERE coupon_id IS NOT NULL GROUP BY coupon_id) u
WHERE u.coupon_id = c.id;

DROP FUNCTION IF EXISTS pick(text, bigint);
