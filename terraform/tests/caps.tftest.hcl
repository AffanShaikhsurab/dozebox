# The budget, the topic policy that admits it, and the caps the control function gets (WP-T5).
# Offline: the AWS provider is mocked.
mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "111122223333" }
  }
  override_data {
    target = data.aws_region.current
    values = { region = "us-east-1" }
  }
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:111122223333:dozebox-main-alerts" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111122223333:role/dozebox-main-mock" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::111122223333:policy/dozebox-main-mock" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:us-east-1:111122223333:rule/dozebox-main-mock" }
  }
  mock_resource "aws_cloudwatch_metric_alarm" {
    defaults = { arn = "arn:aws:cloudwatch:us-east-1:111122223333:alarm:dozebox-main-mock" }
  }
  override_resource {
    target = aws_lambda_function.control
    values = { arn = "arn:aws:lambda:us-east-1:111122223333:function:dozebox-main-control", version = "3" }
  }
  override_resource {
    target = aws_lambda_alias.live
    values = { arn = "arn:aws:lambda:us-east-1:111122223333:function:dozebox-main-control:live" }
  }
  override_resource {
    target = aws_lambda_function_url.control
    values = { function_url = "https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/" }
  }
  override_resource {
    target = aws_sqs_queue.control_dlq
    values = { arn = "arn:aws:sqs:us-east-1:111122223333:dozebox-main-control-dlq" }
  }
}

variables {
  box_id      = "main"
  instance    = { types = ["t4g.small"] }
  data_volume = { size_gb = 20 }
  caps        = { monthly_budget_usd = 25, awake_hours_per_day = 2, on_demand_hours_per_day = 1, max_spot_price_per_hour = 0.03 }
  payloads = {
    demo = { schema = 1, name = "demo", user = "demo", protocol = "none", start = { command = ["/bin/true"] } }
  }
  agent = { version = "none" }
}

run "the_budget_filters_on_the_box_tag_and_notifies_the_topic" {
  command = apply

  assert {
    condition     = aws_budgets_budget.box.name == "dozebox-main-monthly" && aws_budgets_budget.box.limit_amount == "25" && aws_budgets_budget.box.time_unit == "MONTHLY"
    error_message = "The budget is <name>-monthly, USD caps.monthly_budget_usd a month (the phase 1 exit reads this name)."
  }
  assert {
    condition     = [for f in aws_budgets_budget.box.cost_filter : f if f.name == "TagKeyValue"][0].values == tolist(["user:dozebox:box$main"])
    error_message = "The budget filters on the user tag <prefix>:box = <box_id>, format user:<key>$<value>."
  }
  assert {
    condition     = length(aws_budgets_budget.box.cost_filter) == 1
    error_message = "One filter: the box tag, no payload tag."
  }
  assert {
    condition     = !can(regex("(?i)nightshift|t3box", jsonencode(aws_budgets_budget.box)))
    error_message = "The budget names no payload."
  }
  assert {
    condition     = !aws_budgets_budget.box.cost_types[0].include_credit && !aws_budgets_budget.box.cost_types[0].include_refund
    error_message = "Gross cost: credits and refunds would hide spend until they run out."
  }
  assert {
    condition     = toset([for n in aws_budgets_budget.box.notification : "${n.notification_type}-${n.threshold}"]) == toset(["ACTUAL-80", "ACTUAL-100", "FORECASTED-100"])
    error_message = "The budget notifies at 80% and 100% actual and 100% forecast."
  }
  assert {
    condition     = alltrue([for n in aws_budgets_budget.box.notification : n.subscriber_sns_topic_arns == toset([aws_sns_topic.alerts.arn])])
    error_message = "Every notification goes to the alert topic."
  }
  assert {
    condition     = aws_budgets_budget.box.tags["dozebox:box"] == "main"
    error_message = "The budget carries the box tag."
  }
}

run "the_topic_admits_this_box_budget_only" {
  command = apply

  assert {
    condition = [for s in jsondecode(aws_sns_topic_policy.alerts.policy).Statement : s if try(s.Principal.Service, "") == "budgets.amazonaws.com"][0].Condition == {
      StringEquals = { "aws:SourceAccount" = "111122223333" }
      ArnLike      = { "aws:SourceArn" = "arn:aws:budgets::111122223333:budget/dozebox-main-monthly" }
    }
    error_message = "Budgets may publish to the topic only for this box's budget."
  }
  assert {
    condition     = length([for s in jsondecode(aws_sns_topic_policy.alerts.policy).Statement : s if can(s.Principal.AWS) && s.Principal.AWS == "*"]) == 0
    error_message = "No statement opens the topic to every AWS principal."
  }
}

run "the_control_function_gets_the_caps" {
  command = plan

  assert {
    condition = jsondecode(aws_lambda_function.control.environment[0].variables.DOZEBOX_CONTROL).caps == {
      awakeHoursPerDay = 2, onDemandHoursPerDay = 1, monthlyBudgetUsd = 25, maxSpotPricePerHour = 0.03, freezeOnBudget = true
      budgetName       = "dozebox-main-monthly"
    }
    error_message = "DOZEBOX_CONTROL.caps carries every cap input."
  }
  assert {
    condition     = jsondecode(aws_lambda_function.control.environment[0].variables.DOZEBOX_CONTROL).kill.runbook == "dozebox-main-kill"
    error_message = "The control function knows the kill runbook (a budget freeze starts it)."
  }
  assert {
    condition     = jsondecode(aws_lambda_function.control.environment[0].variables.DOZEBOX_CONTROL).kill.freezeParameter == "/dozebox/main/freeze"
    error_message = "The control function knows where the freeze is recorded."
  }
}

run "no_awake_cap_means_null_in_the_function" {
  command = plan
  variables {
    caps = { monthly_budget_usd = 25 }
  }

  assert {
    condition     = jsondecode(aws_lambda_function.control.environment[0].variables.DOZEBOX_CONTROL).caps.awakeHoursPerDay == null
    error_message = "An unset awake cap reaches the function as null (no cap)."
  }
}

run "the_prefix_renames_the_budget_and_its_filter" {
  command = plan
  variables {
    box_id      = "second"
    name_prefix = "acme"
  }

  assert {
    condition     = aws_budgets_budget.box.name == "acme-second-monthly" && [for f in aws_budgets_budget.box.cost_filter : f.values][0] == tolist(["user:acme:box$second"])
    error_message = "name_prefix renames the budget and the tag it filters on."
  }
}
