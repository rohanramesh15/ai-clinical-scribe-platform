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

# Pinned deliberately — do NOT switch back to a "latest AMI" data lookup (see
# the comment above aws_instance.app). Resolved 2026-08-25 via:
#   aws ec2 describe-images --owners 099720109477 \
#     --filters "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*" \
#     --query "reverse(sort_by(Images, &CreationDate))[:1]"
variable "ami_id" {
  description = "Pinned Ubuntu 24.04 AMI id (Canonical). Re-resolve deliberately, never 'latest'."
  type        = string
  default     = "ami-052355af2a014bd2c"
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

# Set to restore RDS from a snapshot (e.g. after a teardown) instead of
# creating an empty database. db_name/username are inherited from the
# snapshot in that case; see the aws_db_instance.db comment.
variable "db_snapshot_identifier" {
  type    = string
  default = null
}
