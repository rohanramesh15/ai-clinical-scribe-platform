output "app_public_ip" {
  description = "Point your DNS A record at this, then run bootstrap.sh."
  value       = aws_instance.app.public_ip
}

output "app_public_dns" {
  value = aws_instance.app.public_dns
}

output "rds_endpoint" {
  description = "Private RDS endpoint (reachable only from the app SG)."
  value       = aws_db_instance.db.address
}

output "app_secret_name" {
  value = aws_secretsmanager_secret.app.name
}
