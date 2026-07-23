# `demo` is the public read-only role the hosted demo logs in as: it can view
# every table, use search/filters/detail views/dashboards, but cannot create,
# edit or delete rows, edit config, author dashboard SQL, manage users, run
# actions, or define webhooks — every mutating/SQL-authoring path is admin-only.
# It masks the fake `api_token`. This is what keeps an "anyone can log in" demo
# from being defaced or used to run arbitrary SQL.
role "demo" {
  tables = {
    "*" = "read"
  }
  masked = {
    "subscriptions" = ["api_token"]
  }
}

role "support" {
  tables = {
    "*" = "read"
  }
  masked = {
    "subscriptions" = ["api_token"]
  }
}
