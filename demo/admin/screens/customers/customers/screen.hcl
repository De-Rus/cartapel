label = "customer"
label_plural = "Customers"

list {
  columns = ["id", "name", "email", "country", "plan", "mrr", "active", "created_at"]
  search  = ["name", "email"]
  filters = ["plan", "country", "active"]
  sort    = "-created_at"
}

display {
  title = "{name}"
}

field "mrr" {
  format = "currency"
}

field "plan" {
  widget = "badge"
  params = {
    colors = {
      free       = "gray"
      pro        = "blue"
      enterprise = "green"
    }
    labels = {
      free       = "Free"
      pro        = "Pro"
      enterprise = "Enterprise"
    }
    fallback = "gray"
  }
}
