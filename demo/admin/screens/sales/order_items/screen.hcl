label = "order item"
label_plural = "Order items"

list {
  columns = ["id", "order_id", "product_id", "qty", "unit_price"]
  sort    = "-id"
}

field "unit_price" {
  format = "currency"
}
