label = "review"
label_plural = "Reviews"

list {
  columns = ["id", "product_id", "rating", "title", "approved", "created_at"]
  search  = ["title", "body"]
  filters = ["approved", "rating"]
  sort    = "-created_at"
}

display {
  title = "{title}"
}

action "approve" {
  label   = "Approve"
  kind    = "update"
  confirm = "Approve {count} reviews?"
  set     = { "approved" = true }
}

action "hide" {
  label     = "Hide"
  kind      = "update"
  confirm   = "Hide {count} reviews?"
  set       = { "approved" = false }
  danger    = true
}
