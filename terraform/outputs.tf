output "s3_bucket_name" {
  description = "S3 bucket for photos and manifest"
  value       = data.aws_s3_bucket.photos.bucket
}

output "cloudfront_domain" {
  description = "CloudFront distribution domain — use this as the base URL in the web app"
  value       = "https://${aws_cloudfront_distribution.photos.domain_name}"
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID — needed for cache invalidations"
  value       = aws_cloudfront_distribution.photos.id
}

output "github_actions_role_arn" {
  description = "IAM role ARN assumed by GitHub Actions via OIDC"
  value       = aws_iam_role.github_actions.arn
}
