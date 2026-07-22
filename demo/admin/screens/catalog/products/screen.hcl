label = "product"
label_plural = "Products"

list {
  columns = ["id", "name", "sku", "price", "active"]
  search  = ["name", "sku"]
  filters = ["active"]
  sort    = "name"
}

display {
  title = "{name}"
}

field "price" {
  format = "currency"
}

action "activate" {
  label   = "Activate"
  kind    = "update"
  confirm = "Activate {count} products?"
  set     = { "active" = true }
}

action "deactivate" {
  label   = "Deactivate"
  kind    = "update"
  confirm = "Deactivate {count} products?"
  set     = { "active" = false }
}
