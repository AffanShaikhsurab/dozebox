# Every aws_iam_policy in the module, and each role's list of managed policies (part 8 §8.2). tests/iam_size.tftest.hcl
# measures every entry; scripts/test/terraform-iam.test.ts fails when a policy in terraform/*.tf is missing here or an
# inline policy (aws_iam_role_policy) appears anywhere. A file that adds an aws_iam_policy adds its row here.
locals {
  all_policies = {
    frozen      = aws_iam_policy.frozen # attached by the kill runbook only, so it is in no role's list
    kill_events = aws_iam_policy.kill_events
  }

  role_policies = {
    box         = []
    control     = []
    kill        = []
    unfreeze    = []
    scheduler   = []
    snapshots   = []
    kill_events = [aws_iam_policy.kill_events]
  }
}

resource "aws_iam_role_policy_attachment" "managed" {
  for_each = {
    "kill_events/kill_events" = { role = aws_iam_role.kill_events.name, arn = aws_iam_policy.kill_events.arn }
  }

  role       = each.value.role
  policy_arn = each.value.arn
}
