# Bootstrap

Applied once per account by an administrator, before the first stack. It creates:

- the Terraform state bucket `<prefix>-tfstate-<account>-<region>` (versioned, SSE-S3, private, TLS only,
  `prevent_destroy`), locked with S3 native locking, so there is no lock table;
- three managed policies for the deploy principal, `<prefix>-deploy-{iam,compute,services}`, each under IAM's 6,144
  characters (`tests/deploy_policies.tftest.hcl`). Set `deploy_role_name` to attach them to an existing role.

```bash
terraform -chdir=terraform/bootstrap init
terraform -chdir=terraform/bootstrap apply -var region=us-east-1
terraform -chdir=terraform/bootstrap output -raw backend_hcl > backend.hcl
```

The deploy principal manages only roles, policies and instance profiles named `<prefix>-*`, attaches only the stack's
own managed policies, and is denied `iam:PutRolePolicy`: the module uses managed policies only. EC2 and Auto Scaling
create calls take no name, so they are limited to the region instead.
