label = "coupon"
label_plural = "Coupons"

list {
  columns = ["id", "code", "kind", "value", "used", "max_uses", "active", "expires_at"]
  search  = ["code"]
  filters = ["active", "kind"]
  sort    = "-used"
}

display {
  title = "{code}"
}

action "deactivate" {
  label     = "Deactivate"
  kind      = "update"
  confirm   = "Deactivate {count} coupons?"
  set       = { "active" = false }
  danger    = true
}
