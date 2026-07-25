-- Acme — a self-contained demo dataset for cartapel.
-- Loaded automatically by the docker-compose demo (mounted into
-- /docker-entrypoint-initdb.d). FK-rich, with enums, money, timestamps and one
-- secret column so every cartapel feature has something to show.

CREATE TABLE customers (
    id          serial PRIMARY KEY,
    name        text NOT NULL,
    email       text NOT NULL UNIQUE,
    country     text NOT NULL,
    plan        text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
    mrr         numeric(10, 2) NOT NULL DEFAULT 0,
    active      boolean NOT NULL DEFAULT true,
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

INSERT INTO customers (name, email, country, plan, mrr, active, created_at) VALUES
    ('Ada Lovelace',      'ada@analytical.io',    'GB', 'enterprise', 499.00, true,  now() - interval '340 days'),
    ('Grace Hopper',      'grace@navy.mil',       'US', 'pro',         49.00, true,  now() - interval '210 days'),
    ('Alan Turing',       'alan@bletchley.uk',    'GB', 'pro',         49.00, true,  now() - interval '190 days'),
    ('Katherine Johnson', 'katherine@nasa.gov',   'US', 'enterprise', 499.00, true,  now() - interval '150 days'),
    ('Linus Torvalds',    'linus@kernel.org',     'FI', 'pro',         49.00, true,  now() - interval '120 days'),
    ('Margaret Hamilton', 'margaret@mit.edu',     'US', 'free',         0.00, true,  now() - interval '90 days'),
    ('Dennis Ritchie',    'dennis@bell-labs.com', 'US', 'pro',         49.00, false, now() - interval '80 days'),
    ('Barbara Liskov',    'barbara@mit.edu',      'US', 'enterprise', 499.00, true,  now() - interval '45 days'),
    ('Donald Knuth',      'don@stanford.edu',     'US', 'free',         0.00, true,  now() - interval '20 days'),
    ('Radia Perlman',     'radia@spanningtree.net','US','pro',         49.00, true,  now() - interval '6 days');

INSERT INTO products (name, sku, price, active) VALUES
    ('Starter Seat',    'SEAT-STD',  49.00,  true),
    ('Pro Seat',        'SEAT-PRO',  99.00,  true),
    ('Enterprise Seat', 'SEAT-ENT',  499.00, true),
    ('Extra Storage',   'ADD-STOR',  9.00,   true),
    ('Priority Support','ADD-SUPP',  29.00,  true),
    ('Legacy Add-on',   'ADD-LEG',   5.00,   false);

INSERT INTO orders (customer_id, status, total, placed_at) VALUES
    (1, 'shipped',   499.00, now() - interval '30 days'),
    (2, 'paid',      108.00, now() - interval '18 days'),
    (4, 'shipped',   499.00, now() - interval '12 days'),
    (5, 'refunded',   99.00, now() - interval '9 days'),
    (3, 'paid',       58.00, now() - interval '5 days'),
    (8, 'pending',   528.00, now() - interval '2 days'),
    (10,'paid',       78.00, now() - interval '1 day'),
    (2, 'cancelled',  49.00, now() - interval '4 hours');

INSERT INTO order_items (order_id, product_id, qty, unit_price) VALUES
    (1, 3, 1, 499.00),
    (2, 2, 1, 99.00), (2, 4, 1, 9.00),
    (3, 3, 1, 499.00),
    (4, 2, 1, 99.00),
    (5, 1, 1, 49.00), (5, 4, 1, 9.00),
    (6, 3, 1, 499.00), (6, 5, 1, 29.00),
    (7, 1, 1, 49.00), (7, 5, 1, 29.00),
    (8, 1, 1, 49.00);

INSERT INTO subscriptions (customer_id, product_id, status, api_token, started_at, renews_at) VALUES
    (1, 3, 'active',   'sk_live_a1b2c3d4e5f6a7b8', now() - interval '340 days', now() + interval '25 days'),
    (2, 2, 'active',   'sk_live_9f8e7d6c5b4a3928', now() - interval '210 days', now() + interval '11 days'),
    (3, 2, 'active',   'sk_live_1122334455667788', now() - interval '190 days', now() + interval '2 days'),
    (4, 3, 'active',   'sk_live_aabbccddeeff0011', now() - interval '150 days', now() + interval '18 days'),
    (5, 2, 'past_due', 'sk_live_deadbeefcafef00d', now() - interval '120 days', now() - interval '3 days'),
    (7, 2, 'cancelled','sk_live_0f0f0f0f0f0f0f0f', now() - interval '80 days',  null),
    (8, 3, 'active',   'sk_live_5566778899aabbcc', now() - interval '45 days',  now() + interval '29 days'),
    (10,2, 'active',   'sk_live_c0ffee00c0ffee00', now() - interval '6 days',   now() + interval '24 days');
