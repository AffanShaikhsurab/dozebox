# The control function's state table (DynamoDB for leases, outbox and ledgers; SSM holds the records). One table per
# stack, so the box is implicit: the only key is pk = "<kind>#<id>", for example "lease#reconcile" (the key the phase
# 2 exit reads). On-demand billing (a few hundred writes a day). Items that age out carry purgeAt (epoch seconds),
# which DynamoDB TTL deletes within a few days; readers treat an item past its own expiry as absent, so TTL only keeps
# the table small.
resource "aws_dynamodb_table" "state" {
  name         = local.names.state_table
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "purgeAt"
    enabled        = true
  }

  # Leases, idempotency keys and the outbox are rebuilt by the next tick; nothing here is worth the PITR charge.
  point_in_time_recovery {
    enabled = false
  }

  tags = local.tags
}
