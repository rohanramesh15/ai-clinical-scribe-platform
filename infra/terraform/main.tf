# Clinical Scribe — default take-home topology.
#
#   Internet ──► EC2 (public subnet, nginx+app, SG: 443/80 only) ──► RDS
#                                                                  (private
#   subnets, publicly_accessible=false, SG: 5432 from the app SG only)
#
# The app reaches Gemini via the Internet Gateway (no NAT needed). Secrets are
# read from Secrets Manager through the EC2 instance role (no keys on disk).
#
# Scale-up (private EC2 + ALB + NAT + VPC endpoints + S3/CloudFront) is noted in
# DEPLOY.md, not built here.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.region
}

locals {
  name = var.project
  tags = { Project = var.project, ManagedBy = "terraform" }
}

# --- Networking -------------------------------------------------------------
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "${local.name}-vpc" })
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.tags, { Name = "${local.name}-igw" })
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidr
  availability_zone       = var.azs[0]
  map_public_ip_on_launch = true
  tags                    = merge(local.tags, { Name = "${local.name}-public" })
}

# Private subnets for RDS (no route to the IGW -> not internet-reachable).
resource "aws_subnet" "private" {
  count             = length(var.private_subnet_cidrs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.azs[count.index]
  tags              = merge(local.tags, { Name = "${local.name}-private-${count.index}" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
  tags = merge(local.tags, { Name = "${local.name}-public-rt" })
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# Private subnets get the VPC's default (local-only) route table — no IGW route,
# so RDS has no path to or from the internet. Demonstrable VPC-only access.

# --- Security groups --------------------------------------------------------
resource "aws_security_group" "app" {
  name        = "${local.name}-app-sg"
  description = "EC2: public HTTPS/HTTP + restricted SSH"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTP (redirects to HTTPS; also for certbot)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "SSH from admin only"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }
  egress {
    description = "All egress (Gemini, packages, Secrets Manager)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = merge(local.tags, { Name = "${local.name}-app-sg" })
}

resource "aws_security_group" "rds" {
  name        = "${local.name}-rds-sg"
  description = "RDS: 5432 from the app SG ONLY"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from app instances only"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id] # not a CIDR — SG-to-SG
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = merge(local.tags, { Name = "${local.name}-rds-sg" })
}

# --- RDS (PostgreSQL 16, private, not publicly accessible) ------------------
resource "aws_db_subnet_group" "db" {
  name       = "${local.name}-db-subnets"
  subnet_ids = aws_subnet.private[*].id
  tags       = local.tags
}

resource "aws_db_instance" "db" {
  identifier             = "${local.name}-db"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = var.db_instance_class
  allocated_storage      = 20
  storage_type           = "gp3"
  storage_encrypted      = true
  db_name                = var.db_name
  username               = var.db_username
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.db.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false # <-- VPC-only; demonstrable
  multi_az               = false
  skip_final_snapshot    = true
  apply_immediately      = true
  tags                   = local.tags
}

# --- Secrets Manager (app secret) ------------------------------------------
resource "aws_secretsmanager_secret" "app" {
  name        = "${var.project}/app"
  description = "Clinical Scribe DB creds + Gemini key"
  tags        = local.tags
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    db_username    = var.db_username
    db_password    = var.db_password
    db_host        = aws_db_instance.db.address
    db_port        = "5432"
    db_name        = var.db_name
    gemini_api_key = var.gemini_api_key
  })
}

# --- IAM: EC2 instance role that can read ONLY the app secret ---------------
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${local.name}-app-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "secrets_read" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app.arn]
  }
}

resource "aws_iam_role_policy" "secrets_read" {
  name   = "${local.name}-secrets-read"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.secrets_read.json
}

resource "aws_iam_instance_profile" "app" {
  name = "${local.name}-app-profile"
  role = aws_iam_role.app.name
}

# --- EC2 (Ubuntu 24.04) -----------------------------------------------------
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.app.name
  key_name               = var.key_name

  root_block_device {
    volume_size = 20
    encrypted   = true
  }
  tags = merge(local.tags, { Name = "${local.name}-app" })
}
