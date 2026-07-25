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
