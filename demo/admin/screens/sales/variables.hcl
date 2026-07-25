variable "days" {
  label   = "Window"
  type    = "int"
  options = ["7", "30", "90"]
  default = "30"
}
