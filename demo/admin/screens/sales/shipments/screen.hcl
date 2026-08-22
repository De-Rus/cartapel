label = "shipment"
label_plural = "Shipments"

list {
  columns = ["id", "order_id", "carrier", "tracking", "status", "shipped_at", "delivered_at"]
  search  = ["tracking"]
  filters = ["status", "carrier"]
  sort    = "-shipped_at"
}

display {
  title = "{tracking}"
}
