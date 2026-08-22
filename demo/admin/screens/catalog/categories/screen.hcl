label = "category"
label_plural = "Categories"

list {
  columns = ["id", "name", "slug", "parent_id", "position"]
  search  = ["name", "slug"]
  sort    = "position"
}

display {
  title = "{name}"
}
