# T7 front door: CloudFront with an origin access control (OAC, signs requests to the Function URL with SigV4), an
# origin request policy that forwards only the token headers, a cache policy that caches nothing, and a WAF web ACL
# with one per-IP rate rule. Everything is gated on var.front_door_enabled; with it off the URL stays public (control.tf).
locals {
  front_door = var.front_door_enabled ? 1 : 0

  # Built from the id (the same string as the distribution arn): other modules' tests mock the provider without an
  # arn shaped value, and a permission rejects a source_arn that is not an arn.
  front_door_arn = var.front_door_enabled ? "arn:${local.partition}:cloudfront::${local.account_id}:distribution/${aws_cloudfront_distribution.front_door[0].id}" : null

  # https://<id>.lambda-url.<region>.on.aws/ -> the host CloudFront calls.
  control_url_host = trimsuffix(trimprefix(aws_lambda_function_url.control.function_url, "https://"), "/")

  # OAC replaces Authorization with its SigV4 signature, so tokens travel in these headers (x-t3box-token until 2.0).
  # Host is never forwarded: the Function URL routes on its own host.
  token_headers = ["x-dozebox-token", "x-t3box-token"]

  # With the front door on, the AWS_IAM Function URL refuses unsigned calls: clients go through CloudFront.
  control_url = var.front_door_enabled ? "https://${aws_cloudfront_distribution.front_door[0].domain_name}" : trimsuffix(aws_lambda_function_url.control.function_url, "/")
}

resource "aws_cloudfront_origin_access_control" "front_door" {
  count = local.front_door

  name                              = local.name
  description                       = "Signs requests to the ${var.box_id} control Function URL."
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_request_policy" "front_door" {
  count = local.front_door

  name    = local.name
  comment = "Token headers only."

  headers_config {
    header_behavior = "whitelist"
    headers {
      items = local.token_headers
    }
  }
  cookies_config {
    cookie_behavior = "none"
  }
  query_strings_config {
    query_string_behavior = "all"
  }
}

resource "aws_cloudfront_cache_policy" "front_door" {
  count = local.front_door

  name        = local.name
  comment     = "Caches nothing: every call reaches the control function."
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = false
    enable_accept_encoding_gzip   = false

    headers_config {
      header_behavior = "none"
    }
    cookies_config {
      cookie_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# CLOUDFRONT-scope web ACLs exist only in us-east-1, whatever region the stack is in.
resource "aws_wafv2_web_acl" "front_door" {
  count  = local.front_door
  region = "us-east-1"

  name        = local.name
  description = "Rate limit in front of the ${var.box_id} control API."
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "rate-per-ip"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit_per_5min
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-rate-per-ip"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
    sampled_requests_enabled   = true
  }

  tags = local.tags
}

resource "aws_cloudfront_distribution" "front_door" {
  count = local.front_door

  enabled         = true
  comment         = "dozebox front door for ${var.box_id}"
  is_ipv6_enabled = true
  http_version    = "http2and3"
  price_class     = "PriceClass_100"
  web_acl_id      = aws_wafv2_web_acl.front_door[0].arn

  origin {
    origin_id                = "control"
    domain_name              = local.control_url_host
    origin_access_control_id = aws_cloudfront_origin_access_control.front_door[0].id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id         = "control"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = aws_cloudfront_cache_policy.front_door[0].id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.front_door[0].id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = local.tags
}

# CloudFront may call the URL, for this distribution only. Both statements are needed (AWS docs, "Control access to
# Lambda function URLs": new URLs need lambda:InvokeFunctionUrl and lambda:InvokeFunction). Lambda refuses concurrent
# policy edits (409), so these two wait for the last permission control.tf writes, then go one after the other.
resource "aws_lambda_permission" "front_door_url" {
  count      = local.front_door
  depends_on = [aws_lambda_permission.control_events_spot]

  statement_id           = "AllowCloudFrontFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.control.function_name
  qualifier              = aws_lambda_alias.live.name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = local.front_door_arn
  function_url_auth_type = "AWS_IAM"
}

resource "aws_lambda_permission" "front_door_invoke" {
  count      = local.front_door
  depends_on = [aws_lambda_permission.front_door_url]

  statement_id             = "AllowCloudFrontInvokeViaFunctionUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.control.function_name
  qualifier                = aws_lambda_alias.live.name
  principal                = "cloudfront.amazonaws.com"
  source_arn               = local.front_door_arn
  invoked_via_function_url = true
}

output "front_door_domain_name" {
  description = "CloudFront domain of the front door, or null when it is off."
  value       = one(aws_cloudfront_distribution.front_door[*].domain_name)
}

output "front_door_distribution_id" {
  description = "CloudFront distribution id, or null when the front door is off."
  value       = one(aws_cloudfront_distribution.front_door[*].id)
}

output "waf_web_acl_arn" {
  description = "WAF web ACL in front of the control API, or null when the front door is off."
  value       = one(aws_wafv2_web_acl.front_door[*].arn)
}
