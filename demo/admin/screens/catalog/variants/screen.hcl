label = "variant"
label_plural = "Variants"

list {
  columns = ["id", "product_id", "sku", "option_name", "option_value", "price_delta", "stock"]
  search  = ["sku", "option_value"]
  sort    = "-stock"
}

display {
  title = "{sku}"
}

field "price_delta" {
  format = "currency"
}

# Negative means oversold, which is a real state and not a rendering accident.
field "stock" {
  format = "number"
}
