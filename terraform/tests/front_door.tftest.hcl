# The front door (T7): CloudFront with OAC, the token-header origin request policy, no caching, and the WAF rate rule.
# Offline: the AWS provider is mocked; ARNs the assertions compare are overridden with real-shaped values.
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
  override_data {
    target = data.aws_ec2_instance_type_offerings.home
    values = { locations = ["us-east-1b", "us-east-1a", "us-east-1a", "us-east-1c"] }
  }
  override_data {
    target = data.aws_ssm_parameter.ami
    values = { insecure_value = "ami-0123456789abcdef0", value = "ami-0123456789abcdef0" }
  }
  mock_resource "aws_iam_instance_profile" {
    defaults = { arn = "arn:aws:iam::111122223333:instance-profile/dozebox-main-box" }
  }
  mock_resource "aws_launch_template" {
    defaults = { id = "lt-0123456789abcdef0", arn = "arn:aws:ec2:us-east-1:111122223333:launch-template/lt-0123456789abcdef0" }
  }
  mock_resource "aws_security_group" {
    defaults = { id = "sg-0123456789abcdef0", arn = "arn:aws:ec2:us-east-1:111122223333:security-group/sg-0123456789abcdef0" }
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
  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      id          = "E1ABCDEFGHIJKL"
      arn         = "arn:aws:cloudfront::111122223333:distribution/E1ABCDEFGHIJKL"
      domain_name = "d111111abcdef8.cloudfront.net"
    }
  }
  mock_resource "aws_wafv2_web_acl" {
    defaults = { arn = "arn:aws:wafv2:us-east-1:111122223333:global/webacl/dozebox-main/11111111-2222-3333-4444-555555555555" }
  }
  mock_resource "aws_ebs_volume" {
    defaults = { id = "vol-0123456789abcdef0" }
  }
}

variables {
  box_id      = "main"
  instance    = { types = ["t4g.small"] }
  data_volume = { size_gb = 20 }
  caps        = { monthly_budget_usd = 10, awake_hours_per_day = 4 }
  payloads = {
    demo = { schema = 1, name = "demo", user = "demo", protocol = "none", start = { command = ["/bin/true"] } }
  }
  agent = { version = "none" }
}

run "front_door_on_puts_cloudfront_with_oac_in_front_of_the_function_url" {
  command = apply
  variables {
    front_door_enabled = true
  }

  assert {
    condition     = length(aws_cloudfront_distribution.front_door) == 1 && aws_cloudfront_distribution.front_door[0].enabled
    error_message = "One enabled distribution."
  }
  assert {
    condition     = length(aws_cloudfront_distribution.front_door[0].origin) == 1
    error_message = "Exactly one origin: the control Function URL."
  }
  assert {
    condition = (one(aws_cloudfront_distribution.front_door[0].origin).domain_name == "abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws" &&
    one(aws_cloudfront_distribution.front_door[0].origin).origin_access_control_id == aws_cloudfront_origin_access_control.front_door[0].id)
    error_message = "The origin is the Function URL host, signed by the origin access control."
  }
  assert {
    condition = (aws_cloudfront_origin_access_control.front_door[0].origin_access_control_origin_type == "lambda" &&
      aws_cloudfront_origin_access_control.front_door[0].signing_behavior == "always" &&
    aws_cloudfront_origin_access_control.front_door[0].signing_protocol == "sigv4")
    error_message = "OAC of type lambda, always signing, sigv4."
  }
  assert {
    condition     = aws_cloudfront_distribution.front_door[0].default_cache_behavior[0].viewer_protocol_policy == "https-only"
    error_message = "Viewers use HTTPS only."
  }
  assert {
    condition     = contains(aws_cloudfront_distribution.front_door[0].default_cache_behavior[0].allowed_methods, "POST")
    error_message = "POST is allowed: /v1/wake is a POST."
  }
  assert {
    condition     = aws_cloudfront_distribution.front_door[0].tags["dozebox:box"] == "main"
    error_message = "The distribution carries the box tags."
  }
}

run "the_origin_request_policy_forwards_exactly_the_token_headers" {
  command = apply

  assert {
    condition = (aws_cloudfront_origin_request_policy.front_door[0].headers_config[0].header_behavior == "whitelist" &&
    toset(aws_cloudfront_origin_request_policy.front_door[0].headers_config[0].headers[0].items) == toset(["x-dozebox-token", "x-t3box-token"]))
    error_message = "Only x-dozebox-token and the legacy x-t3box-token are forwarded."
  }
  assert {
    condition = (!contains([for h in aws_cloudfront_origin_request_policy.front_door[0].headers_config[0].headers[0].items : lower(h)], "authorization") &&
    !contains([for h in aws_cloudfront_origin_request_policy.front_door[0].headers_config[0].headers[0].items : lower(h)], "host"))
    error_message = "Authorization (OAC replaces it) and Host (the Function URL needs its own) are never forwarded."
  }
  assert {
    condition     = aws_cloudfront_origin_request_policy.front_door[0].cookies_config[0].cookie_behavior == "none"
    error_message = "No cookies reach the origin."
  }
  assert {
    condition     = aws_cloudfront_distribution.front_door[0].default_cache_behavior[0].origin_request_policy_id == aws_cloudfront_origin_request_policy.front_door[0].id
    error_message = "The behavior uses the origin request policy."
  }
}

run "nothing_is_cached" {
  command = apply

  assert {
    condition = (aws_cloudfront_cache_policy.front_door[0].min_ttl == 0 && aws_cloudfront_cache_policy.front_door[0].default_ttl == 0 &&
    aws_cloudfront_cache_policy.front_door[0].max_ttl == 0)
    error_message = "The cache policy has zero TTLs."
  }
  assert {
    condition = (aws_cloudfront_cache_policy.front_door[0].parameters_in_cache_key_and_forwarded_to_origin[0].headers_config[0].header_behavior == "none" &&
      aws_cloudfront_cache_policy.front_door[0].parameters_in_cache_key_and_forwarded_to_origin[0].cookies_config[0].cookie_behavior == "none" &&
    aws_cloudfront_cache_policy.front_door[0].parameters_in_cache_key_and_forwarded_to_origin[0].query_strings_config[0].query_string_behavior == "none")
    error_message = "Nothing is in the cache key."
  }
  assert {
    condition     = aws_cloudfront_distribution.front_door[0].default_cache_behavior[0].cache_policy_id == aws_cloudfront_cache_policy.front_door[0].id
    error_message = "The behavior uses the no-cache policy."
  }
}

run "the_web_acl_rate_limits_each_ip_and_guards_the_distribution" {
  command = apply
  variables {
    waf_rate_limit_per_5min = 450
  }

  assert {
    condition     = aws_wafv2_web_acl.front_door[0].scope == "CLOUDFRONT" && aws_wafv2_web_acl.front_door[0].region == "us-east-1"
    error_message = "A CLOUDFRONT web ACL lives in us-east-1."
  }
  assert {
    condition     = length(aws_wafv2_web_acl.front_door[0].rule) == 1
    error_message = "One rule: the rate limit."
  }
  assert {
    condition = (one(aws_wafv2_web_acl.front_door[0].rule).statement[0].rate_based_statement[0].limit == 450 &&
    one(aws_wafv2_web_acl.front_door[0].rule).statement[0].rate_based_statement[0].aggregate_key_type == "IP")
    error_message = "The rate rule limit is waf_rate_limit_per_5min, per client IP."
  }
  assert {
    condition     = length(one(aws_wafv2_web_acl.front_door[0].rule).action[0].block) == 1
    error_message = "Over the limit is blocked."
  }
  assert {
    condition     = aws_cloudfront_distribution.front_door[0].web_acl_id == aws_wafv2_web_acl.front_door[0].arn
    error_message = "The distribution is associated with the web ACL."
  }
  assert {
    condition     = aws_wafv2_web_acl.front_door[0].tags["dozebox:box"] == "main"
    error_message = "The web ACL carries the box tags."
  }
}

run "only_cloudfront_may_invoke_the_function_url" {
  command = apply

  assert {
    condition     = aws_lambda_function_url.control.authorization_type == "AWS_IAM"
    error_message = "With the front door on the Function URL is AWS_IAM."
  }
  assert {
    condition = (aws_lambda_permission.front_door_url[0].principal == "cloudfront.amazonaws.com" &&
      aws_lambda_permission.front_door_url[0].action == "lambda:InvokeFunctionUrl" &&
      aws_lambda_permission.front_door_url[0].function_url_auth_type == "AWS_IAM" &&
      aws_lambda_permission.front_door_url[0].qualifier == "live" &&
    aws_lambda_permission.front_door_url[0].source_arn == aws_cloudfront_distribution.front_door[0].arn)
    error_message = "CloudFront may call lambda:InvokeFunctionUrl on the alias, for this distribution only."
  }
  assert {
    condition = (aws_lambda_permission.front_door_invoke[0].principal == "cloudfront.amazonaws.com" &&
      aws_lambda_permission.front_door_invoke[0].action == "lambda:InvokeFunction" &&
      aws_lambda_permission.front_door_invoke[0].invoked_via_function_url &&
    aws_lambda_permission.front_door_invoke[0].source_arn == aws_cloudfront_distribution.front_door[0].arn)
    error_message = "And lambda:InvokeFunction, only through the URL, for this distribution only (the October 2025 rule)."
  }
  assert {
    condition     = length(aws_lambda_permission.control_url_public) == 0 && length(aws_lambda_permission.control_url_invoke) == 0
    error_message = "Nothing else makes the URL public."
  }
}

run "outputs_name_the_front_door" {
  command = apply

  assert {
    condition     = output.front_door_domain_name == "d111111abcdef8.cloudfront.net" && output.front_door_distribution_id == "E1ABCDEFGHIJKL"
    error_message = "The domain name and distribution id are exported."
  }
  assert {
    condition     = output.waf_web_acl_arn == aws_wafv2_web_acl.front_door[0].arn
    error_message = "The web ACL arn is exported."
  }
  assert {
    condition     = output.control_url == "https://d111111abcdef8.cloudfront.net"
    error_message = "With the front door on, control_url is the CloudFront URL (the Function URL refuses unsigned calls)."
  }
}

run "front_door_off_builds_nothing_and_leaves_the_url_public" {
  command = apply
  variables {
    front_door_enabled = false
  }

  assert {
    condition = (length(aws_cloudfront_distribution.front_door) == 0 && length(aws_cloudfront_origin_access_control.front_door) == 0 &&
      length(aws_cloudfront_origin_request_policy.front_door) == 0 && length(aws_cloudfront_cache_policy.front_door) == 0 &&
      length(aws_wafv2_web_acl.front_door) == 0 && length(aws_lambda_permission.front_door_url) == 0 &&
    length(aws_lambda_permission.front_door_invoke) == 0)
    error_message = "No front door resource exists."
  }
  assert {
    condition     = output.front_door_domain_name == null && output.front_door_distribution_id == null && output.waf_web_acl_arn == null
    error_message = "The outputs are null."
  }
  assert {
    condition     = aws_lambda_function_url.control.authorization_type == "NONE" && length(aws_lambda_permission.control_url_public) == 1
    error_message = "Today's behaviour: the Function URL is public (NONE) and the token is the gate."
  }
  assert {
    condition     = output.control_url == "https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws"
    error_message = "With the front door off, control_url is the Function URL without the trailing slash."
  }
}
