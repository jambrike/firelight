terraform {
  # Environment-specific bucket, object key, KMS key, and allowed account are
  # supplied with -backend-config. Keeping credentials out of this block lets
  # operators use short-lived AWS sessions without persisting them in source.
  backend "s3" {}
}
