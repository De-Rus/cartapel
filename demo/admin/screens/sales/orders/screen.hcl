label = "order"
label_plural = "Orders"

list {
  columns = ["id", "customer_id", "status", "channel", "total", "currency", "placed_at"]
  filters = ["status", "channel", "currency"]
  sort    = "-placed_at"
}

display {
  title = "Order #{id}"
}

# Opens in a side dock instead of navigating away. An order is something you
# check while scanning the list — was it paid, did it ship, why was it refunded
# — and losing the list to answer that means finding your place again for every
# row. Everything hanging off the order (its lines, payments, shipments and
# refunds) appears in there on its own, from the foreign keys.
detail {
  mode  = "drawer"
  stats = ["status", "total", "channel", "placed_at"]

  section {
    title  = "Order"
    fields = ["customer_id", "status", "channel", "placed_at"]
  }

  section {
    title  = "Money"
    fields = ["subtotal", "discount", "shipping", "tax", "total", "currency", "coupon_id"]
  }

  section {
    title  = "Delivery"
    fields = ["address_id"]
  }
}

field "total"    { format = "currency" }
field "subtotal" { format = "currency" }
field "discount" { format = "currency" }
field "shipping" { format = "currency" }
field "tax"      { format = "currency" }

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
