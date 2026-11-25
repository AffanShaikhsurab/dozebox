# One public subnet in the home AZ and no NAT gateway (a NAT bills about USD 33 a month while the box sleeps). The
# security group has no inbound rule unless network.ssh_cidrs is set; the box reaches out, nothing reaches in.
# The data volume is single-AZ, so the home AZ is one that offers every instance type.
data "aws_ec2_instance_type_offerings" "home" {
  count         = var.network.create ? 1 : 0
  location_type = "availability-zone"
  filter {
    name   = "instance-type"
    values = distinct(var.instance.types)
  }
}

data "aws_subnet" "existing" {
  count = var.network.create ? 0 : 1
  id    = var.network.subnet_ids[0]
}

locals {
  offered_azs = var.network.create ? data.aws_ec2_instance_type_offerings.home[0].locations : []
  # An AZ qualifies when it offers every distinct type, so neither the instance nor the fallback lands where the volume
  # cannot follow.
  azs_with_every_type = sort([
    for az in distinct(local.offered_azs) : az
    if length([for l in local.offered_azs : l if l == az]) == length(distinct(var.instance.types))
  ])
  home_az   = var.network.create ? local.azs_with_every_type[0] : data.aws_subnet.existing[0].availability_zone
  vpc_id    = var.network.create ? aws_vpc.box[0].id : var.network.vpc_id
  subnet_id = var.network.create ? aws_subnet.box[0].id : var.network.subnet_ids[0]
  vpc_cidr  = "10.42.0.0/16"
}

resource "aws_vpc" "box" {
  count                = var.network.create ? 1 : 0
  cidr_block           = local.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = local.name })
}

resource "aws_internet_gateway" "box" {
  count  = var.network.create ? 1 : 0
  vpc_id = aws_vpc.box[0].id
  tags   = merge(local.tags, { Name = local.name })
}

resource "aws_subnet" "box" {
  count                   = var.network.create ? 1 : 0
  vpc_id                  = aws_vpc.box[0].id
  cidr_block              = cidrsubnet(local.vpc_cidr, 8, 0)
  availability_zone       = local.home_az
  map_public_ip_on_launch = true
  tags                    = merge(local.tags, { Name = "${local.name}-${local.home_az}" })
}

resource "aws_route_table" "box" {
  count  = var.network.create ? 1 : 0
  vpc_id = aws_vpc.box[0].id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.box[0].id
  }
  tags = merge(local.tags, { Name = local.name })
}

resource "aws_route_table_association" "box" {
  count          = var.network.create ? 1 : 0
  subnet_id      = aws_subnet.box[0].id
  route_table_id = aws_route_table.box[0].id
}

resource "aws_security_group" "box" {
  name_prefix = "${local.name}-"
  description = "Dozebox box ${var.box_id}: no inbound rule unless ssh_cidrs is set; all egress."
  vpc_id      = local.vpc_id
  tags        = merge(local.tags, { Name = local.name })

  # Inline, so the rule is created by AuthorizeSecurityGroupEgress without tags. A separate (taggable)
  # aws_vpc_security_group_egress_rule gets the provider's default_tags, and a deploy principal that may only tag on
  # create for the box's own resources (the test account's) is refused tagging the security-group-rule.
  egress {
    description = "All outbound: payload providers, package mirrors, AWS APIs"
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  for_each          = toset(var.network.ssh_cidrs)
  security_group_id = aws_security_group.box.id
  description       = "SSH from an operator range (network.ssh_cidrs)"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = each.value
  tags              = local.tags
}
