# ── Origin Access Control ─────────────────────────────────────────────────────

resource "aws_cloudfront_origin_access_control" "photos" {
  name                              = var.s3_bucket_name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ── Cache policies ────────────────────────────────────────────────────────────

# Photos are immutable — cache for up to 1 year, honour the origin Cache-Control.
resource "aws_cloudfront_cache_policy" "immutable" {
  name        = "${var.project_name}-immutable"
  min_ttl     = 0
  default_ttl = 86400    # 1 day fallback
  max_ttl     = 31536000 # 1 year

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
  }
}

# Manifest is updated twice daily — keep the edge cache short so changes
# propagate quickly. The GitHub Actions workflow also invalidates on each run.
resource "aws_cloudfront_cache_policy" "manifest" {
  name        = "${var.project_name}-manifest"
  min_ttl     = 0
  default_ttl = 300  # 5 minutes
  max_ttl     = 3600 # 1 hour cap

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
  }
}

# ── Response headers policy ───────────────────────────────────────────────────
# Adds CORS headers so DuckDB-WASM can fetch the Parquet manifest cross-origin.

resource "aws_cloudfront_response_headers_policy" "cors" {
  name = "${var.project_name}-cors"

  cors_config {
    access_control_allow_credentials = false
    access_control_allow_headers { items = ["*"] }
    access_control_allow_methods { items = ["GET", "HEAD"] }
    access_control_allow_origins { items = ["*"] }
    access_control_expose_headers {
      items = ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"]
    }
    access_control_max_age_sec = 3600
    origin_override            = true
  }
}

# ── Distribution ──────────────────────────────────────────────────────────────

resource "aws_cloudfront_distribution" "photos" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "Mesonet photo explorer — ${var.s3_bucket_name}"
  tags            = local.common_tags

  origin {
    domain_name              = data.aws_s3_bucket.photos.bucket_regional_domain_name
    origin_id                = "s3-${var.s3_bucket_name}"
    origin_access_control_id = aws_cloudfront_origin_access_control.photos.id
  }

  # Manifest — short cache, CORS headers
  ordered_cache_behavior {
    path_pattern               = "photos/manifest.parquet"
    target_origin_id           = "s3-${var.s3_bucket_name}"
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id            = aws_cloudfront_cache_policy.manifest.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.cors.id
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
  }

  # All other paths (photos) — long immutable cache
  default_cache_behavior {
    target_origin_id           = "s3-${var.s3_bucket_name}"
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id            = aws_cloudfront_cache_policy.immutable.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.cors.id
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
