label = "address"
label_plural = "Addresses"

list {
  columns = ["id", "customer_id", "kind", "line1", "city", "postcode", "country", "is_default"]
  search  = ["line1", "city", "postcode"]
  filters = ["kind", "country"]
  sort    = "-id"
}

display {
  title = "{line1}, {city}"
}
