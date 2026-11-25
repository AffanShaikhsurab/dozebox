terraform {
  # 1.10 is the first release with S3 native state locking (use_lockfile), so the bootstrap needs no lock table.
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }
}
