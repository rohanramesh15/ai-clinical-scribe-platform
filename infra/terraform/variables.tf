variable "region" {
  type    = string
  default = "us-east-1"
}

variable "project" {
  type    = string
  default = "clinical-scribe"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "public_subnet_cidr" {
  type    = string
  default = "10.20.1.0/24"
}

# RDS requires a subnet group spanning >= 2 AZs.
variable "private_subnet_cidrs" {
  type    = list(string)
  default = ["10.20.11.0/24", "10.20.12.0/24"]
}

variable "azs" {
  type    = list(string)
  default = ["us-east-1a", "us-east-1b"]
}

variable "instance_type" {
  type    = string
  default = "t3.small"
}

variable "db_instance_class" {
  type    = string
  default = "db.t3.micro"
}

variable "key_name" {
  description = "Existing EC2 key pair name for SSH."
  type        = string
}

variable "admin_cidr" {
  description = "CIDR allowed to SSH (your IP/32). NOT 0.0.0.0/0."
  type        = string
}

variable "db_name" {
  type    = string
  default = "scribe"
}

variable "db_username" {
  type    = string
  default = "scribe"
}

# Secrets: supplied via a GITIGNORED terraform.tfvars (never committed). They are
# written into the Secrets Manager app secret; the app/Alembic read them at
# runtime via the instance role. NOTE: Terraform state will contain these — use
# an encrypted remote backend (see DEPLOY.md).
variable "db_password" {
  type      = string
  sensitive = true
}

variable "gemini_api_key" {
  type      = string
  sensitive = true
}
