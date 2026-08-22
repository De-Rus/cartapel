columns = 4

panel {
  type          = "stat"
  label         = "MRR"
  category      = "Revenue"
  format        = "money"
  sql           = "SELECT coalesce(sum(mrr), 0) AS v FROM customers WHERE active"
  good_when     = "up"
}

panel {
  type          = "stat"
  label         = "Active customers"
  category      = "Revenue"
  sql           = "SELECT count(*) AS v FROM customers WHERE active"
  good_when     = "up"
}

panel {
  type          = "stat"
  label         = "Orders"
  category      = "Sales"
  sql           = "SELECT count(*) AS v FROM orders WHERE placed_at > now() - {{days}} * interval '1 day'"
  spark         = "SELECT count(*) AS v FROM orders WHERE placed_at > now() - {{days}} * interval '1 day' GROUP BY date_trunc('day', placed_at) ORDER BY date_trunc('day', placed_at)"
  good_when     = "up"
}

panel {
  type          = "stat"
  label         = "Past-due subscriptions"
  category      = "Health"
  sql           = "SELECT count(*) AS v FROM subscriptions WHERE status = 'past_due'"
  good_when     = "down"
  alert_above   = 0
}

panel {
  type    = "chart"
  label   = "Revenue booked per day"
  chart   = "bar"
  w       = 2
  h       = 2
  sql     = "SELECT date_trunc('day', placed_at)::date AS label, sum(total) AS value FROM orders WHERE status IN ('paid', 'shipped') AND placed_at > now() - {{days}} * interval '1 day' GROUP BY 1 ORDER BY 1"
}

panel {
  type    = "table"
  label   = "Latest orders"
  w       = 2
  h       = 2
  sql     = "SELECT o.id, c.name AS customer, o.status, o.total, o.placed_at FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.placed_at > now() - {{days}} * interval '1 day' ORDER BY o.placed_at DESC LIMIT 8"
}

# Shop panels. None of these were expressible before: they need the catalogue,
# the refunds and the per-line data that the five-table dataset did not have.

panel {
  type      = "stat"
  label     = "Average order value"
  category  = "Sales"
  format    = "money"
  sql       = "SELECT coalesce(avg(total), 0) AS v FROM orders WHERE status IN ('paid','shipped') AND placed_at > now() - {{days}} * interval '1 day'"
  good_when = "up"
}

panel {
  type        = "stat"
  label       = "Refund rate"
  category    = "Health"
  format      = "percent"
  sql         = "SELECT coalesce(100.0 * count(*) FILTER (WHERE status = 'refunded') / nullif(count(*), 0), 0) AS v FROM orders WHERE placed_at > now() - {{days}} * interval '1 day'"
  good_when   = "down"
  alert_above = 10
}

panel {
  type        = "stat"
  label       = "Oversold variants"
  category    = "Health"
  sql         = "SELECT count(*) AS v FROM variants WHERE stock < 0"
  good_when   = "down"
  alert_above = 0
}

panel {
  type      = "stat"
  label     = "Failed payments"
  category  = "Health"
  sql       = "SELECT count(*) AS v FROM payments WHERE status = 'failed' AND created_at > now() - {{days}} * interval '1 day'"
  good_when = "down"
}

panel {
  type  = "chart"
  label = "Revenue by category"
  chart = "bar"
  w     = 2
  h     = 2
  sql   = "SELECT cat.name AS label, sum(oi.qty * oi.unit_price) AS value FROM order_items oi JOIN products p ON p.id = oi.product_id JOIN categories cat ON cat.id = p.category_id JOIN orders o ON o.id = oi.order_id WHERE o.status IN ('paid','shipped') AND o.placed_at > now() - {{days}} * interval '1 day' GROUP BY 1 ORDER BY 2 DESC LIMIT 10"
}

panel {
  type  = "chart"
  label = "Orders by channel"
  chart = "bar"
  w     = 2
  h     = 2
  sql   = "SELECT channel AS label, count(*) AS value FROM orders WHERE placed_at > now() - {{days}} * interval '1 day' GROUP BY 1 ORDER BY 2 DESC"
}

panel {
  type  = "table"
  label = "Low stock"
  w     = 2
  sql   = "SELECT p.name AS product, v.option_value AS variant, v.stock FROM variants v JOIN products p ON p.id = v.product_id WHERE v.stock < 20 ORDER BY v.stock LIMIT 12"
}

panel {
  type  = "table"
  label = "Worst rated"
  w     = 2
  sql   = "SELECT p.name AS product, round(avg(r.rating), 2) AS rating, count(*) AS reviews FROM reviews r JOIN products p ON p.id = r.product_id WHERE r.approved GROUP BY 1 HAVING count(*) >= 5 ORDER BY 2 LIMIT 12"
}
