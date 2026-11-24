# Offline: the AWS provider is mocked, so this never calls AWS. WP-T1 replaces this with the module's real tests.
mock_provider "aws" {}

run "module_plans_offline" {
  command = plan
}
