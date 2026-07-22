label = "order"
label_plural = "Orders"

list {
  columns = ["id", "customer_id", "status", "total", "placed_at"]
  filters = ["status"]
  sort    = "-placed_at"
}

display {
  title = "Order #{id}"
}

field "total" {
  format = "currency"
}

action "mark_shipped" {
  label   = "Mark shipped"
  kind    = "update"
  confirm = "Mark {count} orders as shipped?"
  set     = { "status" = "shipped" }
}

action "refund" {
  label   = "Refund"
  kind    = "update"
  danger  = true
  confirm = "Refund {count} orders? This is a demo — no money moves."
  set     = { "status" = "refunded" }
}
