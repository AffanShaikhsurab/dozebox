# Every aws_iam_policy in the module, and each role's list of managed policies (part 8 §8.2). tests/iam_size.tftest.hcl
# measures every entry; scripts/test/terraform-iam.test.ts fails when a policy in terraform/*.tf is missing here or an
# inline policy (aws_iam_role_policy) appears anywhere. A file that adds an aws_iam_policy adds its row here.
locals {
  all_policies = {}

  role_policies = {
    box       = []
    control   = []
    kill      = []
    unfreeze  = []
    scheduler = []
    snapshots = []
  }
}
