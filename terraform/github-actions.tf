# ── GitHub Actions OIDC ───────────────────────────────────────────────────────
# Allows GitHub Actions to write to S3 and invalidate CloudFront
# without storing long-lived AWS credentials as secrets.

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "github_actions" {
  name = "${var.project_name}-github-actions"
  tags = local.common_tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "sts:AssumeRoleWithWebIdentity"
      Principal = {
        Federated = data.aws_iam_openid_connect_provider.github.arn
      }
      Condition = {
        StringLike = {
          # A list is an OR — the sub claim need match only one pattern. One
          # entry normally; briefly two while a repo rename is in flight, so
          # workflows keep authenticating under both names (github_repo_aliases).
          "token.actions.githubusercontent.com:sub" = [
            for repo in concat([var.github_repo], var.github_repo_aliases) :
            "repo:${repo}:*"
          ]
        }
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_actions" {
  name = "s3-cloudfront"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3ReadWrite"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
        ]
        Resource = "${data.aws_s3_bucket.photos.arn}/*"
      },
      {
        Sid      = "S3ListBucket"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = data.aws_s3_bucket.photos.arn
      },
      {
        Sid    = "CloudFrontInvalidate"
        Effect = "Allow"
        Action = "cloudfront:CreateInvalidation"
        # The data CDN only. Briefly covered both distributions while the
        # CLOUDFRONT_DISTRIBUTION_ID secret was being switched over, since a
        # GitHub secret and an IAM policy cannot change atomically together.
        Resource = local.data_cdn_distribution_arn
      },
    ]
  })
}
