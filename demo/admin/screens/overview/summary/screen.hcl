label = "Overview"
icon  = "layout-dashboard"

panel {
  type  = "stat"
  label = "Customers"
  sql   = "SELECT count(*) AS v FROM customers"
  w     = 2
}

panel {
  type  = "stat"
  label = "Orders"
  sql   = "SELECT count(*) AS v FROM orders"
  w     = 2
}

panel {
  type  = "table"
  label = "Latest orders"
  table = "orders"
  pp    = 8
  sort  = "-placed_at"
  link  = "orders"
  w     = 6
}
