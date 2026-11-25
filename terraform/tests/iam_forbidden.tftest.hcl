mock_provider "aws" {
  # Real-shaped values: the mock's random strings would make ARNs short (and the provider rejects some of them).
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "111122223333" }
  }
  override_data {
    target = data.aws_region.current
    values = { region = "ap-southeast-2" }
  }
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws" }
  }
  override_data {
    target = data.aws_ec2_instance_type_offerings.home
    values = { locations = ["ap-southeast-2b", "ap-southeast-2a", "ap-southeast-2a", "ap-southeast-2c"] }
  }
  override_data {
    target = data.aws_ssm_parameter.ami
    values = { insecure_value = "ami-0123456789abcdef0", value = "ami-0123456789abcdef0" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111122223333:role/dozebox-a2345678901234567890-scheduler" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::111122223333:policy/dozebox-a2345678901234567890-control-volumes" }
  }
  mock_resource "aws_iam_instance_profile" {
    defaults = { arn = "arn:aws:iam::111122223333:instance-profile/dozebox-a2345678901234567890-box" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:ap-southeast-2:111122223333:dozebox-a2345678901234567890-alerts" }
  }
  mock_resource "aws_launch_template" {
    defaults = { id = "lt-0123456789abcdef0", arn = "arn:aws:ec2:ap-southeast-2:111122223333:launch-template/lt-0123456789abcdef0" }
  }
  mock_resource "aws_security_group" {
    defaults = { id = "sg-0123456789abcdef0", arn = "arn:aws:ec2:ap-southeast-2:111122223333:security-group/sg-0123456789abcdef0" }
  }
  mock_resource "aws_subnet" {
    defaults = { id = "subnet-0123456789abcdef0" }
  }
  mock_resource "aws_vpc" {
    defaults = { id = "vpc-0123456789abcdef0" }
  }
  mock_resource "aws_instance" {
    defaults = { id = "i-0123456789abcdef0" }
  }
  mock_resource "aws_ebs_volume" {
    defaults = { id = "vol-0123456789abcdef0" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:ap-southeast-2:111122223333:rule/dozebox-main-mock" }
  }
  mock_resource "aws_cloudwatch_metric_alarm" {
    defaults = { arn = "arn:aws:cloudwatch:ap-southeast-2:111122223333:alarm:dozebox-main-mock" }
  }
  override_resource {
    target = aws_lambda_function.control
    values = { arn = "arn:aws:lambda:ap-southeast-2:111122223333:function:dozebox-main-control", version = "3" }
  }
  override_resource {
    target = aws_lambda_alias.live
    values = { arn = "arn:aws:lambda:ap-southeast-2:111122223333:function:dozebox-main-control:live" }
  }
  override_resource {
    target = aws_lambda_function_url.control
    values = { function_url = "https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.ap-southeast-2.on.aws/" }
  }
  override_resource {
    target = aws_sqs_queue.control_dlq
    values = { arn = "arn:aws:sqs:ap-southeast-2:111122223333:dozebox-main-control-dlq" }
  }
}

variables {
  box_id      = "a2345678901234567890" # 20 characters: the worst case for names and ARNs
  instance    = { types = ["t4g.small", "t4g.medium"] }
  data_volume = { size_gb = 20 }
  caps        = { monthly_budget_usd = 25 }
  payloads = {
    demo = { schema = 1, name = "demo", user = "demo", protocol = "none", start = { command = ["/bin/true"] } }
  }
  agent = { version = "none" }
}
# Per role, forbidden actions are absent, and the instance and volume actions carry the box tag condition (part 8 §8.2).
run "forbidden_actions_are_absent" {
  command = apply
  variables {
    enable_ssm_session = true
  }

  assert {
    condition = length([for a in local.role_allowed_actions.box : a if can(regex("^iam:", a)) || contains([
      "ec2:StartInstances", "ec2:RunInstances", "ec2:CreateTags", "ec2:CreateSnapshot", "ec2:DescribeInstances",
      "autoscaling:UpdateAutoScalingGroup", "autoscaling:LaunchInstances",
    ], a)]) == 0
    error_message = "The box role must never start, launch, tag, snapshot, list instances or touch IAM: ${join(", ", local.role_allowed_actions.box)}"
  }
  assert {
    condition = alltrue(flatten([for k in local.role_policy_keys.box : [
      for s in local.policy_documents[k].Statement : !(s.Effect == "Allow" && contains(flatten([s.Resource]), "*") &&
      length([for a in flatten([s.Action]) : a if can(regex("^ssm:Get", a))]) > 0)
    ]]))
    error_message = "The box role must never read parameters on * (the AmazonSSMManagedInstanceCore trap)."
  }
  assert {
    condition     = [for a in local.role_allowed_actions.control : a if can(regex("^iam:", a))] == ["iam:PassRole"]
    error_message = "The control role gets no IAM action except iam:PassRole."
  }
  assert {
    condition = alltrue(flatten([for k in local.role_policy_keys.control : [
      for s in local.policy_documents[k].Statement :
      flatten([s.Resource]) == [aws_iam_role.box.arn] if contains(flatten([s.Action]), "iam:PassRole")
    ]]))
    error_message = "The control role passes only the box role."
  }
  assert {
    condition     = length(setintersection(local.role_allowed_actions.control, ["ec2:DeleteSnapshot", "ec2:TerminateInstances", "ec2:ModifyInstanceAttribute"])) == 0
    error_message = "The control role never deletes a snapshot, nor terminates an instance."
  }
  assert {
    condition = alltrue(flatten([for k in local.role_policy_keys.control : [
      for s in local.policy_documents[k].Statement :
      flatten([s.Action]) == ["ec2:DeleteVolume"] && try(s.Condition.StringEquals["aws:ResourceTag/dozebox:active"], "") == "false" && try(s.Condition.StringEquals["aws:ResourceTag/dozebox:box"], "") != ""
      if contains(flatten([s.Action]), "ec2:DeleteVolume")
    ]]))
    error_message = "The control role deletes only inactive volumes of its box (the restore test's scratch volume), in a statement of its own."
  }
  assert {
    condition     = !contains(local.role_allowed_actions.kill, "iam:DetachRolePolicy") && contains(local.role_allowed_actions.kill, "iam:AttachRolePolicy")
    error_message = "The kill role attaches the deny policy and can never detach it."
  }
  assert {
    condition     = [for a in local.role_allowed_actions.unfreeze : a if can(regex("^(iam|ec2|autoscaling):", a))] == ["iam:DetachRolePolicy"]
    error_message = "The unfreeze role only detaches the deny policy."
  }
  assert {
    condition = alltrue(flatten([for k in ["kill", "unfreeze"] : [
      for s in local.policy_documents[k].Statement :
      try(s.Condition.ArnEquals["iam:PolicyARN"], "") == "arn:aws:iam::111122223333:policy/dozebox-a2345678901234567890-frozen"
      if length([for a in flatten([s.Action]) : a if can(regex("^iam:", a))]) > 0
    ]]))
    error_message = "Kill and unfreeze touch only the deny policy (iam:PolicyARN condition)."
  }
  assert {
    condition     = local.role_allowed_actions.scheduler == tolist(["lambda:InvokeFunction"])
    error_message = "The scheduler role only invokes the control function."
  }
  assert {
    condition = alltrue([for role, actions in local.role_unscoped_actions : length(setintersection(actions, [
      "ec2:AttachVolume", "ec2:DetachVolume", "ec2:StartInstances", "ec2:StopInstances",
    ])) == 0])
    error_message = "AttachVolume, DetachVolume, StartInstances and StopInstances must carry the <prefix>:box tag condition."
  }
  assert {
    condition = alltrue(flatten([for k, doc in local.policy_documents : [
      for s in doc.Statement : [for a in flatten([s.Action]) : a != "*" && !can(regex(":\\*$", a))] if s.Effect == "Allow"
    ]]))
    error_message = "No Allow statement grants * or a whole service (service:*)."
  }
}

run "volume_fence_needs_the_active_tag" {
  command = plan

  assert {
    condition = alltrue([for s in local.box_compute_policy.Statement :
      s.Condition.StringEquals["aws:ResourceTag/dozebox:active"] == "true"
    if contains(flatten([s.Action]), "ec2:AttachVolume") && contains(flatten([s.Resource]), local.arns.volumes)])
    error_message = "The box may attach only a volume tagged <prefix>:active = true."
  }
}