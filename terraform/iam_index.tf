# Every aws_iam_policy in the module, each role's list of managed policies (part 8 §8.2), and the attachments built
# from that list, so the index is what AWS gets. tests/iam_size.tftest.hcl measures every entry and
# tests/iam_forbidden.tftest.hcl reads the per-role action lists below; scripts/test/terraform-iam.test.ts fails when
# a policy in terraform/*.tf is missing here or an inline policy (aws_iam_role_policy) appears anywhere.
# A file that adds an aws_iam_policy adds its row here.
locals {
  all_policies = merge(
    {
      box_records     = aws_iam_policy.box_records
      box_compute     = aws_iam_policy.box_compute
      box_alerts      = aws_iam_policy.box_alerts
      box_logs        = aws_iam_policy.box_logs
      control_ec2     = aws_iam_policy.control_ec2
      control_volumes = aws_iam_policy.control_volumes
      control_records = aws_iam_policy.control_records
      control_state   = aws_iam_policy.control_state
      control_alerts  = aws_iam_policy.control_alerts
      control_spend   = aws_iam_policy.control_spend
      kill            = aws_iam_policy.kill
      unfreeze        = aws_iam_policy.unfreeze
      scheduler       = aws_iam_policy.scheduler
      snapshots       = aws_iam_policy.snapshots
      kill_events     = aws_iam_policy.kill_events
      frozen          = aws_iam_policy.frozen # attached by the kill runbook only, so it is in no role's list
    },
    var.enable_ssm_session ? { box_ssm_session = aws_iam_policy.box_ssm_session[0] } : {},
  )

  # Each role's managed policies by key of all_policies; at most 8 per role (tests/iam_size.tftest.hcl).
  role_policy_keys = {
    box         = concat(["box_records", "box_compute", "box_alerts", "box_logs"], var.enable_ssm_session ? ["box_ssm_session"] : [])
    control     = ["control_ec2", "control_volumes", "control_records", "control_state", "control_alerts", "control_spend"]
    kill        = ["kill"]
    unfreeze    = ["unfreeze"]
    scheduler   = ["scheduler"]
    snapshots   = ["snapshots"]
    kill_events = ["kill_events"]
  }
  role_policies = { for role, keys in local.role_policy_keys : role => [for k in keys : local.all_policies[k]] }
  roles = {
    box         = aws_iam_role.box
    control     = aws_iam_role.control
    kill        = aws_iam_role.kill
    unfreeze    = aws_iam_role.unfreeze
    scheduler   = aws_iam_role.scheduler
    snapshots   = aws_iam_role.snapshots
    kill_events = aws_iam_role.kill_events
  }

  # The policy documents as HCL objects, keyed like all_policies (sizes are measured on the rendered JSON).
  policy_documents = {
    box_records     = local.box_records_policy
    box_compute     = local.box_compute_policy
    box_alerts      = local.box_alerts_policy
    box_logs        = local.box_logs_policy
    box_ssm_session = local.box_ssm_session_policy
    control_ec2     = local.control_ec2_policy
    control_volumes = local.control_volumes_policy
    control_records = local.control_records_policy
    control_state   = local.control_state_policy
    control_alerts  = local.control_alerts_policy
    control_spend   = local.control_spend_policy
    kill            = local.kill_policy
    unfreeze        = local.unfreeze_policy
    scheduler       = local.scheduler_policy
    snapshots       = local.snapshots_policy
    kill_events     = local.kill_events_policy
    frozen          = local.frozen_policy
  }

  # Per role, the actions its Allow statements grant, and those granted without a condition on the box tag, for
  # tests/iam_forbidden.tftest.hcl.
  role_allowed_actions = {
    for role, keys in local.role_policy_keys : role => sort(distinct(flatten([
      for k in keys : [for s in local.policy_documents[k].Statement : flatten([s.Action]) if s.Effect == "Allow"]
    ])))
  }
  role_unscoped_actions = {
    for role, keys in local.role_policy_keys : role => sort(distinct(flatten([
      for k in keys : [
        for s in local.policy_documents[k].Statement : flatten([s.Action])
        if s.Effect == "Allow" && try(s.Condition.StringEquals[local.box_tag], null) == null
      ]
    ])))
  }
  role_policy_attachments = merge([
    for role, keys in local.role_policy_keys : { for k in keys : "${role}/${k}" => { role = role, arn = local.all_policies[k].arn } }
  ]...)
}

resource "aws_iam_role_policy_attachment" "managed" {
  for_each   = local.role_policy_attachments
  role       = local.roles[each.value.role].name
  policy_arn = each.value.arn
}
