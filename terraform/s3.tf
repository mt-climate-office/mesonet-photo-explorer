# The bucket is no longer managed here.
#
# `mco-mesonet` is a SHARED bucket — data/ (mesonet-db-rds), photos/
# (mesonet-cameras), air-quality/ (mesonet-aq) — read publicly only through
# mco-data-cdn's OAC at data2.climate.umt.edu/mesonet/*. It, its policy, its
# public access block and its CORS configuration moved to mco-aws
# `stacks/mco-mesonet-bucket` on 2026-09-20 (state key
# `mco-aws/mco-mesonet-bucket/terraform.tfstate`), adopted there by `import`
# blocks and removed from this state with `terraform state rm`.
#
# Change the bucket, the bucket policy (including any grant to this repo's
# role), versioning, encryption, ownership controls or CORS THERE, not here.
# This stack keeps only a read-only lookup so the remaining CloudFront and
# IAM resources can still resolve the bucket's ARN and origin domain.
data "aws_s3_bucket" "photos" {
  bucket = var.s3_bucket_name
}
